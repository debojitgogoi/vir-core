/**
 * Photograph storage.
 *
 * Files are content-addressed: the storage key derives from the SHA-256 of the
 * bytes, so an identical re-upload writes nothing new and a client-supplied
 * filename can never influence an object key.
 *
 * Bytes live in S3 when a bucket is configured and on local disk otherwise.
 * Callers ask for a DownloadTarget and never learn which backend answered.
 *
 * It mirrors glbStorage.ts rather than sharing code with it. The two differ in
 * subdirectory, extension mapping, key layout and size limits; an abstraction
 * over exactly two callers would be guessing at the shape of the third.
 */

import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import { env } from "../config/env";
import * as s3 from "./s3Client";

const MEDIA_SUBDIR = "media";

/** A served file's name should say what its bytes actually are. */
export const EXTENSION_BY_CONTENT_TYPE: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
};

export interface StoredMedia {
  storageKey: string;
  checksumSha256: string;
  sizeBytes: number;
}

/** Where a stored photograph can be read from. See glbStorage's twin type. */
export type DownloadTarget =
  | { kind: "file"; absolutePath: string }
  | { kind: "url"; url: string };

function storageRoot(): string {
  return path.resolve(process.cwd(), env.storageRoot);
}

export function sha256(buffer: Buffer): string {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

/**
 * Resolve a storage key to an absolute path, refusing anything that escapes the
 * storage root. Only meaningful for the disk backend; S3 has no such thing as a
 * traversable key. Keys come from our own database rather than user input, but
 * the check costs nothing and keeps that a local property of this module rather
 * than an assumption about every caller.
 */
export function resolvePath(storageKey: string): string {
  const root = storageRoot();
  const resolved = path.resolve(root, storageKey);
  if (resolved !== root && !resolved.startsWith(root + path.sep)) {
    throw new Error(`Storage key escapes the storage root: ${storageKey}`);
  }
  return resolved;
}

/**
 * The content-addressed key for these bytes. Pure, so the layout can be
 * asserted without a bucket or a filesystem.
 *
 * The key fans out on the checksum's first two characters. A depot shooting a
 * few hundred photographs a day puts tens of thousands of files under one root
 * within a year, and a single flat directory that size is slow to list on every
 * filesystem worth naming — and equally slow to list as one S3 prefix.
 */
export function storageKeyFor(
  contentType: string,
  buffer: Buffer,
): { storageKey: string; checksumSha256: string } {
  const extension = EXTENSION_BY_CONTENT_TYPE[contentType];
  if (!extension) {
    throw new Error(`Unsupported media content type: ${contentType}`);
  }

  const checksumSha256 = sha256(buffer);
  return {
    storageKey: `${MEDIA_SUBDIR}/${checksumSha256.slice(0, 2)}/${checksumSha256}${extension}`,
    checksumSha256,
  };
}

export async function exists(storageKey: string): Promise<boolean> {
  if (s3.isS3Enabled()) return s3.headObject(storageKey);

  try {
    await fs.access(resolvePath(storageKey));
    return true;
  } catch {
    return false;
  }
}

/** Write a photograph and return its storage metadata. */
export async function put(buffer: Buffer, contentType: string): Promise<StoredMedia> {
  const { storageKey, checksumSha256 } = storageKeyFor(contentType, buffer);

  if (s3.isS3Enabled()) {
    if (!(await exists(storageKey))) {
      await s3.putObject(storageKey, buffer, contentType);
    }
    return { storageKey, checksumSha256, sizeBytes: buffer.length };
  }

  const absolutePath = resolvePath(storageKey);

  if (!(await exists(storageKey))) {
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    // Write to a temporary name, then rename. rename() is atomic within a
    // filesystem, so a crash mid-write cannot leave a truncated file at the
    // path a database row points to, and two writers racing on identical bytes
    // simply overwrite each other with the same content. A single S3 PutObject
    // is already atomic, which is why that branch needs no equivalent.
    const tempPath = `${absolutePath}.${crypto.randomUUID()}.tmp`;
    try {
      await fs.writeFile(tempPath, buffer);
      await fs.rename(tempPath, absolutePath);
    } catch (err) {
      // Leaving a .tmp behind would accumulate silently and defeat the reaper's
      // "PENDING rows with no bytes" query, which looks at the database only.
      await fs.rm(tempPath, { force: true });
      throw err;
    }
  }

  return { storageKey, checksumSha256, sizeBytes: buffer.length };
}

/**
 * Remove a stored file.
 *
 * Missing is success. The reaper's job is to converge on "no unreferenced
 * bytes", and a file that is already gone is that state — treating it as an
 * error would make a resumed sweep fail on everything the interrupted one
 * finished.
 *
 * @returns true when a file was actually removed, false when there was none.
 */
export async function remove(storageKey: string): Promise<boolean> {
  // S3 reports success for a key that was never there, so this head-then-delete
  // is what keeps the reaper's filesDeleted counter from inflating.
  if (s3.isS3Enabled()) return s3.deleteObject(storageKey);

  try {
    await fs.unlink(resolvePath(storageKey));
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw err;
  }
}

/**
 * How to read a stored photograph.
 *
 * The signed URL expires, so it must never be cached beyond `ttlSeconds`; see
 * the no-store header on the route that issues the redirect.
 */
export async function resolveDownload(
  storageKey: string,
  opts: { ttlSeconds: number },
): Promise<DownloadTarget> {
  if (!s3.isS3Enabled()) {
    return { kind: "file", absolutePath: resolvePath(storageKey) };
  }

  return {
    kind: "url",
    url: await s3.presignGet(storageKey, {
      ttlSeconds: opts.ttlSeconds,
      // inline rather than attachment: these are photographs a client displays
      // in place, not files a user is expected to save.
      responseContentDisposition: "inline",
    }),
  };
}
