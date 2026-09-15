import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { after, test } from "node:test";
import * as storage from "../src/storage/mediaStorage";

const JPEG = Buffer.from("fake-jpeg-bytes");

after(async () => {
  // bootstrap.ts made this a fresh temp directory for this file's process.
  if (process.env.STORAGE_ROOT) {
    await fs.rm(process.env.STORAGE_ROOT, { recursive: true, force: true });
  }
});

test("put writes the bytes and returns content-addressed metadata", async () => {
  const stored = await storage.put(JPEG, "image/jpeg");

  assert.equal(stored.checksumSha256, storage.sha256(JPEG));
  assert.equal(stored.sizeBytes, JPEG.length);
  assert.ok(stored.storageKey.startsWith("media/"), "media lives under its own subdirectory");
  assert.ok(stored.storageKey.endsWith(".jpg"));
  assert.ok(await storage.exists(stored.storageKey));

  const onDisk = await fs.readFile(storage.resolvePath(stored.storageKey));
  assert.deepEqual(onDisk, JPEG, "the bytes on disk are the bytes handed in");
});

test("identical bytes reuse one file rather than writing a second", async () => {
  const first = await storage.put(JPEG, "image/jpeg");
  const second = await storage.put(JPEG, "image/jpeg");

  assert.equal(second.storageKey, first.storageKey, "content addressing means one path");
});

test("the same bytes under a different content type get their own key", async () => {
  const asJpeg = await storage.put(JPEG, "image/jpeg");
  const asPng = await storage.put(JPEG, "image/png");

  assert.notEqual(
    asPng.storageKey,
    asJpeg.storageKey,
    "the extension is part of the key, so a served file's name matches its type",
  );
});

test("the key fans out on the checksum so no directory holds every file", async () => {
  const stored = await storage.put(JPEG, "image/jpeg");
  const segments = stored.storageKey.split("/");

  assert.equal(segments.length, 3, "media/<2 chars>/<checksum>.<ext>");
  assert.equal(segments[1], stored.checksumSha256.slice(0, 2));
  assert.equal(segments[2], `${stored.checksumSha256}.jpg`);
});

test("put refuses a content type it has no extension for", async () => {
  await assert.rejects(
    () => storage.put(JPEG, "application/pdf"),
    /Unsupported media content type/,
  );
});

test("resolvePath refuses a key that escapes the storage root", () => {
  assert.throws(() => storage.resolvePath("../../etc/passwd"), /escapes the storage root/);
  assert.throws(() => storage.resolvePath("media/../../../secrets"), /escapes the storage root/);
});

test("resolvePath accepts a key that stays inside the root", () => {
  const resolved = storage.resolvePath("media/ab/abcd.jpg");
  assert.ok(resolved.endsWith(path.join("media", "ab", "abcd.jpg")));
});

test("resolveDownload hands back a path on disk when no bucket is configured", async () => {
  const stored = await storage.put(JPEG, "image/jpeg");
  const target = await storage.resolveDownload(stored.storageKey, { ttlSeconds: 900 });

  assert.ok(target.kind === "file", "no bucket is set in this process, so disk answers");
  assert.deepEqual(await fs.readFile(target.absolutePath), JPEG);
});

test("exists reports false for a key that was never written", async () => {
  assert.equal(await storage.exists("media/ab/deadbeef.jpg"), false);
});

test("a concurrent put of identical bytes leaves exactly one file", async () => {
  const bytes = Buffer.from("racing-bytes");

  // Both writes go to a temp name and rename onto the same final path, so the
  // loser's rename overwrites an identical file rather than corrupting it.
  const [first, second] = await Promise.all([
    storage.put(bytes, "image/webp"),
    storage.put(bytes, "image/webp"),
  ]);

  assert.equal(first.storageKey, second.storageKey);
  const onDisk = await fs.readFile(storage.resolvePath(first.storageKey));
  assert.deepEqual(onDisk, bytes, "neither writer left a truncated file behind");

  const dir = path.dirname(storage.resolvePath(first.storageKey));
  const entries = await fs.readdir(dir);
  assert.deepEqual(
    entries.filter((e) => e.endsWith(".tmp")),
    [],
    "no temporary files are left behind",
  );
});
