import assert from "node:assert/strict";
import crypto from "node:crypto";
import { after, beforeEach, test } from "node:test";
import { pool } from "../src/db/pool";
import { closeDb, resetDb } from "./helpers/db";
import { seedDepot, seedEquipmentType, seedMediaAsset } from "./helpers/fixtures";
import { generateJobNumber } from "../src/utils/jobNumber";

beforeEach(async () => {
  await resetDb();
});

after(async () => {
  await closeDb();
});

async function seedJobCard(depotId: string, equipmentTypeId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO job_cards (job_number, depot_id, direction, equipment_type_id, chassis_number)
     VALUES ($1, $2, 'INBOUND', $3, 'CHS-1') RETURNING id`,
    [await generateJobNumber(), depotId, equipmentTypeId],
  );
  return rows[0].id;
}

function insertAsset(overrides: Record<string, unknown> = {}) {
  const values = {
    storage_key: "",
    checksum_sha256: crypto.randomBytes(32).toString("hex"),
    content_type: "image/jpeg",
    size_bytes: 1024,
    ...overrides,
  } as Record<string, unknown>;

  const columns = Object.keys(values);
  const params = Object.values(values);
  const placeholders = params.map((_, i) => `$${i + 1}`).join(", ");

  return pool.query<{ id: string }>(
    `INSERT INTO media_assets (${columns.join(", ")}) VALUES (${placeholders}) RETURNING id`,
    params,
  );
}

function link(jobCardId: string, mediaAssetId: string, kind = "CHASSIS") {
  return pool.query<{ id: string }>(
    `INSERT INTO job_card_media (job_card_id, media_asset_id, kind)
     VALUES ($1, $2, $3) RETURNING id`,
    [jobCardId, mediaAssetId, kind],
  );
}

test("a media asset defaults to PENDING with an empty storage key", async () => {
  const { rows } = await insertAsset();
  const { rows: read } = await pool.query<{ status: string; storage_key: string }>(
    `SELECT status, storage_key FROM media_assets WHERE id = $1`,
    [rows[0].id],
  );

  assert.equal(read[0].status, "PENDING");
  assert.equal(read[0].storage_key, "", "no bytes have arrived yet");
});

test("an unlisted content type is rejected", async () => {
  await assert.rejects(
    () => insertAsset({ content_type: "application/pdf" }),
    (err: { code?: string }) => err.code === "23514",
  );
  await assert.rejects(
    () => insertAsset({ content_type: "image/gif" }),
    (err: { code?: string }) => err.code === "23514",
  );
});

test("a zero or negative size is rejected", async () => {
  for (const size of [0, -1]) {
    await assert.rejects(
      () => insertAsset({ size_bytes: size }),
      (err: { code?: string }) => err.code === "23514",
      `size_bytes ${size} should be refused`,
    );
  }
});

test("a READY asset must carry a storage key", async () => {
  await assert.rejects(
    () => insertAsset({ status: "READY", storage_key: "" }),
    (err: { code?: string; constraint?: string }) =>
      err.code === "23514" && err.constraint === "media_asset_ready_has_storage_key",
    "a READY row promising bytes nothing can find is not a valid row",
  );

  const ok = await insertAsset({ status: "READY", storage_key: "media/ab/abc.jpg" });
  assert.ok(ok.rows[0].id);
});

test("an unknown media status is rejected", async () => {
  await assert.rejects(
    () => insertAsset({ status: "UPLOADING" }),
    (err: { code?: string }) => err.code === "23514",
  );
});

test("an unknown link kind is rejected", async () => {
  const depotId = await seedDepot();
  const typeId = await seedEquipmentType();
  const cardId = await seedJobCard(depotId, typeId);
  const assetId = await seedMediaAsset(depotId, { status: "READY" });

  await assert.rejects(
    () => link(cardId, assetId, "SELFIE"),
    (err: { code?: string }) => err.code === "23514",
  );
});

test("the same asset cannot be linked to one card twice", async () => {
  const depotId = await seedDepot();
  const typeId = await seedEquipmentType();
  const cardId = await seedJobCard(depotId, typeId);
  const assetId = await seedMediaAsset(depotId, { status: "READY" });

  await link(cardId, assetId);
  await assert.rejects(
    () => link(cardId, assetId, "DRIVER_LICENSE"),
    (err: { code?: string }) => err.code === "23505",
    "the UNIQUE is on the pair, so even a different kind is a duplicate link",
  );
});

test("one asset may be linked to two different cards", async () => {
  const depotId = await seedDepot();
  const typeId = await seedEquipmentType();
  const firstCard = await seedJobCard(depotId, typeId);
  const secondCard = await seedJobCard(depotId, typeId);
  const assetId = await seedMediaAsset(depotId, { status: "READY" });

  await link(firstCard, assetId);
  const second = await link(secondCard, assetId);

  assert.ok(second.rows[0].id, "content-addressed bytes are shareable across cards");
});

test("deleting a job card cascades its link rows away", async () => {
  const depotId = await seedDepot();
  const typeId = await seedEquipmentType();
  const cardId = await seedJobCard(depotId, typeId);
  const assetId = await seedMediaAsset(depotId, { status: "READY" });
  await link(cardId, assetId);

  await pool.query(`DELETE FROM job_cards WHERE id = $1`, [cardId]);

  const { rows } = await pool.query<{ count: string }>(
    `SELECT count(*) FROM job_card_media WHERE job_card_id = $1`,
    [cardId],
  );
  assert.equal(rows[0].count, "0");

  const { rows: asset } = await pool.query<{ count: string }>(
    `SELECT count(*) FROM media_assets WHERE id = $1`,
    [assetId],
  );
  assert.equal(asset[0].count, "1", "the asset outlives the card that referenced it");
});

test("deleting a media asset that is still linked is refused", async () => {
  const depotId = await seedDepot();
  const typeId = await seedEquipmentType();
  const cardId = await seedJobCard(depotId, typeId);
  const assetId = await seedMediaAsset(depotId, { status: "READY" });
  await link(cardId, assetId);

  await assert.rejects(
    () => pool.query(`DELETE FROM media_assets WHERE id = $1`, [assetId]),
    (err: { code?: string }) => err.code === "23503",
    "RESTRICT keeps a reaper honest: check every link before removing bytes",
  );
});

test("deleting a depot leaves its media rows in place with a null depot", async () => {
  const depotId = await seedDepot();
  const assetId = await seedMediaAsset(depotId);

  await pool.query(`DELETE FROM depots WHERE id = $1`, [depotId]);

  const { rows } = await pool.query<{ depot_id: string | null }>(
    `SELECT depot_id FROM media_assets WHERE id = $1`,
    [assetId],
  );
  assert.equal(rows[0].depot_id, null, "SET NULL rather than stranding the row");
});
