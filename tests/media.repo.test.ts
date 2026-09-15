import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, beforeEach, test } from "node:test";
import * as repo from "../src/db/media.repo";
import { pool } from "../src/db/pool";
import { closeDb, resetDb } from "./helpers/db";
import { createTestUser } from "./helpers/auth";
import { seedDepot, seedEquipmentType } from "./helpers/fixtures";
import { generateJobNumber } from "../src/utils/jobNumber";

beforeEach(async () => {
  await resetDb();
});

after(async () => {
  await closeDb();
});

const checksum = () => crypto.randomBytes(32).toString("hex");

async function seedJobCard(depotId: string, equipmentTypeId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO job_cards (job_number, depot_id, direction, equipment_type_id, chassis_number)
     VALUES ($1, $2, 'INBOUND', $3, 'CHS-1') RETURNING id`,
    [await generateJobNumber(), depotId, equipmentTypeId],
  );
  return rows[0].id;
}

function register(depotId: string, overrides: Partial<repo.InsertMediaAssetInput> = {}) {
  return repo.insertMediaAsset({
    checksumSha256: checksum(),
    contentType: "image/jpeg",
    sizeBytes: 1024,
    originalFilename: "licence.jpg",
    depotId,
    uploadedBy: null,
    ...overrides,
  });
}

test("an inserted asset starts PENDING with no bytes behind it", async () => {
  const depotId = await seedDepot();
  const user = await createTestUser({ role: "MECHANIC" });
  const row = await register(depotId, { uploadedBy: user.id });

  assert.equal(row.status, "PENDING");
  assert.equal(row.storage_key, "");
  assert.equal(row.depot_id, depotId);
  assert.equal(row.uploaded_by, user.id);
  assert.equal(row.original_filename, "licence.jpg");
});

test("size_bytes comes back as a number, not a BIGINT string", async () => {
  const depotId = await seedDepot();
  const row = await register(depotId, { sizeBytes: 2048 });

  assert.equal(typeof row.size_bytes, "number", "pg returns BIGINT as a string by default");
  assert.equal(row.size_bytes, 2048);
});

test("a size beyond 32 bits survives the round trip intact", async () => {
  const depotId = await seedDepot();
  const large = 5_000_000_000;
  const row = await register(depotId, { sizeBytes: large });

  assert.equal(row.size_bytes, large, "BIGINT is the column type for a reason");
});

test("markMediaAssetReady promotes the row and records the real size", async () => {
  const depotId = await seedDepot();
  const pending = await register(depotId, { sizeBytes: 1024 });

  const ready = await repo.markMediaAssetReady(pending.id, "media/ab/abc.jpg", 999);

  assert.equal(ready!.status, "READY");
  assert.equal(ready!.storage_key, "media/ab/abc.jpg");
  assert.equal(ready!.size_bytes, 999, "the declared size is replaced by what arrived");
});

test("markMediaAssetReady on an unknown id returns null", async () => {
  const missing = await repo.markMediaAssetReady(
    "00000000-0000-0000-0000-000000000000",
    "media/ab/abc.jpg",
    10,
  );
  assert.equal(missing, null);
});

test("markMediaAssetReady is idempotent for a retried upload", async () => {
  const depotId = await seedDepot();
  const pending = await register(depotId);

  const first = await repo.markMediaAssetReady(pending.id, "media/ab/abc.jpg", 500);
  const second = await repo.markMediaAssetReady(pending.id, "media/ab/abc.jpg", 500);

  assert.equal(second!.id, first!.id);
  assert.equal(second!.status, "READY");
});

test("findMediaAssetById returns null rather than throwing for an unknown id", async () => {
  assert.equal(await repo.findMediaAssetById("00000000-0000-0000-0000-000000000000"), null);
});

test("insertJobCardMedia links an asset to a card", async () => {
  const depotId = await seedDepot();
  const typeId = await seedEquipmentType();
  const cardId = await seedJobCard(depotId, typeId);
  const asset = await register(depotId);
  await repo.markMediaAssetReady(asset.id, "media/ab/abc.jpg", 10);
  const user = await createTestUser({ role: "MECHANIC" });

  const link = await repo.insertJobCardMedia({
    jobCardId: cardId,
    mediaAssetId: asset.id,
    kind: "DRIVER_LICENSE",
    createdBy: user.id,
  });

  assert.equal(link.job_card_id, cardId);
  assert.equal(link.media_asset_id, asset.id);
  assert.equal(link.kind, "DRIVER_LICENSE");
});

test("listJobCardMedia returns each asset joined to its kind, newest first", async () => {
  const depotId = await seedDepot();
  const typeId = await seedEquipmentType();
  const cardId = await seedJobCard(depotId, typeId);

  const licence = await register(depotId);
  await repo.markMediaAssetReady(licence.id, "media/aa/aa.jpg", 10);
  await repo.insertJobCardMedia({
    jobCardId: cardId,
    mediaAssetId: licence.id,
    kind: "DRIVER_LICENSE",
    createdBy: null,
  });

  const chassis = await register(depotId);
  await repo.markMediaAssetReady(chassis.id, "media/bb/bb.jpg", 20);
  await repo.insertJobCardMedia({
    jobCardId: cardId,
    mediaAssetId: chassis.id,
    kind: "CHASSIS",
    createdBy: null,
  });

  const rows = await repo.listJobCardMedia(cardId);

  assert.equal(rows.length, 2);
  assert.equal(rows[0].id, chassis.id, "most recently attached leads");
  assert.equal(rows[0].kind, "CHASSIS");
  assert.equal(rows[1].kind, "DRIVER_LICENSE");
  assert.equal(typeof rows[0].size_bytes, "number", "the join must not reintroduce the string");
});

test("listJobCardMedia is empty for a card with no media", async () => {
  const depotId = await seedDepot();
  const typeId = await seedEquipmentType();
  const cardId = await seedJobCard(depotId, typeId);

  assert.deepEqual(await repo.listJobCardMedia(cardId), []);
});

test("listJobCardMedia is scoped to its card", async () => {
  const depotId = await seedDepot();
  const typeId = await seedEquipmentType();
  const mine = await seedJobCard(depotId, typeId);
  const theirs = await seedJobCard(depotId, typeId);

  const asset = await register(depotId);
  await repo.markMediaAssetReady(asset.id, "media/aa/aa.jpg", 10);
  await repo.insertJobCardMedia({
    jobCardId: theirs,
    mediaAssetId: asset.id,
    kind: "CHASSIS",
    createdBy: null,
  });

  assert.deepEqual(await repo.listJobCardMedia(mine), []);
});

test("findJobCardMediaLink finds an existing link and nothing otherwise", async () => {
  const depotId = await seedDepot();
  const typeId = await seedEquipmentType();
  const cardId = await seedJobCard(depotId, typeId);
  const asset = await register(depotId);
  await repo.markMediaAssetReady(asset.id, "media/aa/aa.jpg", 10);

  assert.equal(await repo.findJobCardMediaLink(cardId, asset.id), null);

  await repo.insertJobCardMedia({
    jobCardId: cardId,
    mediaAssetId: asset.id,
    kind: "CHASSIS",
    createdBy: null,
  });

  assert.ok(await repo.findJobCardMediaLink(cardId, asset.id));
});

test("deleteJobCardMedia reports whether it removed anything", async () => {
  const depotId = await seedDepot();
  const typeId = await seedEquipmentType();
  const cardId = await seedJobCard(depotId, typeId);
  const asset = await register(depotId);
  await repo.markMediaAssetReady(asset.id, "media/aa/aa.jpg", 10);
  await repo.insertJobCardMedia({
    jobCardId: cardId,
    mediaAssetId: asset.id,
    kind: "CHASSIS",
    createdBy: null,
  });

  assert.equal(await repo.deleteJobCardMedia(cardId, asset.id), true);
  assert.equal(
    await repo.deleteJobCardMedia(cardId, asset.id),
    false,
    "a second detach has nothing to remove",
  );
});

test("detaching leaves the asset row in place", async () => {
  const depotId = await seedDepot();
  const typeId = await seedEquipmentType();
  const cardId = await seedJobCard(depotId, typeId);
  const asset = await register(depotId);
  await repo.markMediaAssetReady(asset.id, "media/aa/aa.jpg", 10);
  await repo.insertJobCardMedia({
    jobCardId: cardId,
    mediaAssetId: asset.id,
    kind: "CHASSIS",
    createdBy: null,
  });

  await repo.deleteJobCardMedia(cardId, asset.id);

  assert.ok(
    await repo.findMediaAssetById(asset.id),
    "content-addressed bytes may be shared, so removing them is a reaper's job",
  );
});
