/**
 * GLB binary storage.
 *
 * Files are content-addressed: the storage key derives from the SHA-256 of the
 * bytes, so re-uploading an identical GLB writes nothing new and no supplier
 * filename can ever influence an object key.
 *
 * Bytes live in S3 when a bucket is configured and on local disk otherwise.
 * Callers ask for a DownloadTarget and never learn which backend answered; the
 * choice stays a property of this module, which is what lets development and
 * the test suite run with no AWS account.
 */

import crypto from "crypto";
import fs from "fs/promises";
import path from "path";
import { env } from "../config/env";
import * as s3 from "./s3Client";

const GLB_SUBDIR = "glb";
const GLB_CONTENT_TYPE = "model/gltf-binary";

export interface StoredGlb {
  storageKey: string;
  checksumSha256: string;
  sizeBytes: number;
}

/**
 * Where a stored GLB can be read from. A disk read streams from a path; an S3
 * read is a short-lived signed URL the caller redirects to, so the bytes never
 * pass through the API.
 */
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
 * Resolve a storage key to an absolute path, refusing anything that escapes
 * the storage root. Only meaningful for the disk backend; S3 has no such thing
 * as a traversable key. Keys come from our own database rather than from user
 * input, but a traversal check costs nothing and keeps that a local property
 * of this module rather than an assumption about every caller.
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
 * asserted without a bucket or a filesystem — and the layout is the one thing
 * that must not drift, because existing rows already point at it.
 *
 * S3 and disk share it deliberately: `glb/<type>/<sha>.glb` was already a
 * valid object key, so moving a deployment to S3 is an upload of the files and
 * no UPDATE to the table.
 */
export function storageKeyFor(
  equipmentTypeId: string,
  buffer: Buffer,
): { storageKey: string; checksumSha256: string } {
  const checksumSha256 = sha256(buffer);
  return {
    storageKey: `${GLB_SUBDIR}/${equipmentTypeId}/${checksumSha256}.glb`,
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

/**
 * Write a GLB for an equipment type and return its storage metadata.
 *
 * Writes are skipped when the content-addressed key already holds the same
 * bytes, which makes this idempotent: retrying a failed upload reuses the
 * object instead of duplicating it.
 */
export async function put(equipmentTypeId: string, buffer: Buffer): Promise<StoredGlb> {
  const { storageKey, checksumSha256 } = storageKeyFor(equipmentTypeId, buffer);

  if (s3.isS3Enabled()) {
    if (!(await exists(storageKey))) {
      await s3.putObject(storageKey, buffer, GLB_CONTENT_TYPE);
    }
    return { storageKey, checksumSha256, sizeBytes: buffer.length };
  }

  const absolutePath = resolvePath(storageKey);

  if (!(await exists(storageKey))) {
    await fs.mkdir(path.dirname(absolutePath), { recursive: true });
    // Write to a temporary name first, then rename. rename() is atomic within
    // a filesystem, so a crash mid-write can never leave a truncated file at
    // the path a database row points to. A single S3 PutObject is already
    // atomic, which is why that branch needs no equivalent.
    const tempPath = `${absolutePath}.${crypto.randomUUID()}.tmp`;
    await fs.writeFile(tempPath, buffer);
    await fs.rename(tempPath, absolutePath);
  }

  return { storageKey, checksumSha256, sizeBytes: buffer.length };
}

/** A caller-supplied name is echoed back as a response header by S3, so it must not be able to break out of it. */
function attachmentDisposition(filename: string): string {
  return `attachment; filename="${filename.replace(/["\r\n]/g, "")}"`;
}

/**
 * How to read a stored GLB.
 *
 * The signed URL expires, so it must never be cached beyond `ttlSeconds`; see
 * the no-store header on the route that issues the redirect.
 */
export async function resolveDownload(
  storageKey: string,
  opts: { ttlSeconds: number; filename?: string },
): Promise<DownloadTarget> {
  if (!s3.isS3Enabled()) {
    return { kind: "file", absolutePath: resolvePath(storageKey) };
  }

  return {
    kind: "url",
    url: await s3.presignGet(storageKey, {
      ttlSeconds: opts.ttlSeconds,
      responseContentType: GLB_CONTENT_TYPE,
      ...(opts.filename
        ? { responseContentDisposition: attachmentDisposition(opts.filename) }
        : {}),
    }),
  };
}
