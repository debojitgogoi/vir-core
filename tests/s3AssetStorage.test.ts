/**
 * S3-backed asset storage.
 *
 * The bucket and static credentials are set before anything under src/ is
 * required, using require rather than import: env.ts resolves the bucket once,
 * at module load, so a hoisted import would read env before these lines ran and
 * leave isS3Enabled() false — quietly testing the disk backend instead and
 * passing for the wrong reason.
 *
 * Signing is local arithmetic, so nothing here opens a socket and no bucket
 * needs to exist. `node --test` gives each file its own process, so this does
 * not leak into mediaStorage.test.ts, which exercises the disk branch.
 */
process.env.ASSETS_S3_BUCKET = "vir-assets-test";
process.env.ASSETS_S3_REGION = "ap-southeast-2";
process.env.AWS_ACCESS_KEY_ID = "test-key";
process.env.AWS_SECRET_ACCESS_KEY = "test-secret";

import assert from "node:assert/strict";
import { test } from "node:test";

/* eslint-disable @typescript-eslint/no-require-imports */
const glbStorage =
  require("../src/storage/glbStorage") as typeof import("../src/storage/glbStorage");
const mediaStorage =
  require("../src/storage/mediaStorage") as typeof import("../src/storage/mediaStorage");
const s3 = require("../src/storage/s3Client") as typeof import("../src/storage/s3Client");
const { env, resolveAssetsBucket } =
  require("../src/config/env") as typeof import("../src/config/env");
/* eslint-enable @typescript-eslint/no-require-imports */

const GLB = Buffer.from("fake-glb-bytes");
const JPEG = Buffer.from("fake-jpeg-bytes");
const BUCKET_ORIGIN = "https://vir-assets-test.s3.ap-southeast-2.amazonaws.com";

test("the process is actually wired to S3, not the disk fallback", () => {
  assert.equal(s3.isS3Enabled(), true);
  assert.equal(env.assetsS3Bucket, "vir-assets-test");
});

/**
 * The layout is the migration contract: every existing row already points at
 * these keys, so a move to S3 needs an upload of the files and no UPDATE.
 */
test("the GLB key layout is unchanged by the move to S3", () => {
  const { storageKey, checksumSha256 } = glbStorage.storageKeyFor("type-1", GLB);

  assert.equal(checksumSha256, glbStorage.sha256(GLB));
  assert.equal(storageKey, `glb/type-1/${checksumSha256}.glb`);
});

test("the media key layout is unchanged by the move to S3", () => {
  const { storageKey, checksumSha256 } = mediaStorage.storageKeyFor("image/jpeg", JPEG);

  assert.equal(storageKey, `media/${checksumSha256.slice(0, 2)}/${checksumSha256}.jpg`);
});

test("an identical GLB maps to one key, so a retried upload cannot duplicate it", () => {
  const first = glbStorage.storageKeyFor("type-1", GLB);
  const second = glbStorage.storageKeyFor("type-1", GLB);

  assert.deepEqual(second, first);
});

test("a GLB download resolves to a signed S3 URL rather than a local path", async () => {
  const { storageKey } = glbStorage.storageKeyFor("type-1", GLB);
  const target = await glbStorage.resolveDownload(storageKey, {
    ttlSeconds: 900,
    filename: "chassis-v2.glb",
  });

  assert.ok(target.kind === "url", "with a bucket configured, the bytes come from S3");

  const url = new URL(target.url);
  assert.equal(url.origin, BUCKET_ORIGIN);
  assert.equal(url.pathname, `/${storageKey}`, "the signed key is the one the row stores");
  assert.equal(url.searchParams.get("X-Amz-Expires"), "900");
  assert.equal(url.searchParams.get("response-content-type"), "model/gltf-binary");
  assert.equal(
    url.searchParams.get("response-content-disposition"),
    'attachment; filename="chassis-v2.glb"',
  );
  assert.ok(url.searchParams.get("X-Amz-Signature"), "the URL carries a signature");
});

/**
 * The filename reaches S3 as a signed query parameter and comes back as a
 * response header, with no Express setHeader in between to reject a CR or LF.
 */
test("a filename cannot break out of the Content-Disposition header", async () => {
  const { storageKey } = glbStorage.storageKeyFor("type-1", GLB);
  const target = await glbStorage.resolveDownload(storageKey, {
    ttlSeconds: 900,
    filename: 'ev"il\r\nX-Injected: 1.glb',
  });

  assert.ok(target.kind === "url");
  const disposition = new URL(target.url).searchParams.get("response-content-disposition");

  assert.equal(disposition, 'attachment; filename="evilX-Injected: 1.glb"');
  assert.ok(!/[\r\n]/.test(disposition ?? ""), "no CR or LF can reach a response header");
});

test("a GLB download with no filename still resolves and still expires", async () => {
  const { storageKey } = glbStorage.storageKeyFor("type-1", GLB);
  const target = await glbStorage.resolveDownload(storageKey, { ttlSeconds: 60 });

  assert.ok(target.kind === "url");
  const url = new URL(target.url);
  assert.equal(url.searchParams.get("X-Amz-Expires"), "60");
  assert.equal(url.searchParams.get("response-content-disposition"), null);
});

test("a media download resolves to a signed S3 URL served inline", async () => {
  const { storageKey } = mediaStorage.storageKeyFor("image/jpeg", JPEG);
  const target = await mediaStorage.resolveDownload(storageKey, { ttlSeconds: 900 });

  assert.ok(target.kind === "url");

  const url = new URL(target.url);
  assert.equal(url.origin, BUCKET_ORIGIN);
  assert.equal(url.pathname, `/${storageKey}`);
  assert.equal(url.searchParams.get("response-content-disposition"), "inline");
  assert.equal(url.searchParams.get("X-Amz-Expires"), "900");
});

test("the short TTL a caller asks for is the one signed, not a default", async () => {
  const { storageKey } = mediaStorage.storageKeyFor("image/png", JPEG);
  const target = await mediaStorage.resolveDownload(storageKey, { ttlSeconds: 30 });

  assert.ok(target.kind === "url");
  assert.equal(new URL(target.url).searchParams.get("X-Amz-Expires"), "30");
});

test("an explicitly configured bucket is used", () => {
  assert.equal(resolveAssetsBucket({ ASSETS_S3_BUCKET: "vir-assets-new" }, false), "vir-assets-new");
});

test("the documented GLB_S3_BUCKET name is still honoured", () => {
  assert.equal(resolveAssetsBucket({ GLB_S3_BUCKET: "vir-glb-legacy" }, false), "vir-glb-legacy");
});

test("ASSETS_S3_BUCKET wins when both names are set", () => {
  assert.equal(
    resolveAssetsBucket({ ASSETS_S3_BUCKET: "new", GLB_S3_BUCKET: "old" }, false),
    "new",
  );
});

test("with nothing configured outside production there is no bucket, so bytes go to disk", () => {
  assert.equal(resolveAssetsBucket({}, false), null);
});

test("production refuses to boot without a bucket", () => {
  // Disk is ephemeral there, so booting would silently revert every model and
  // photograph to files the next deploy deletes.
  assert.throws(() => resolveAssetsBucket({}, true), /ASSETS_S3_BUCKET/);
});
