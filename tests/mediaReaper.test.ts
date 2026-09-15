import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import request from "supertest";
import { app } from "../src/app";
import { pool } from "../src/db/pool";
import * as storage from "../src/storage/mediaStorage";
import { reapMedia } from "../src/services/mediaReaper";
import { parseArgs } from "../scripts/reap-media";
import { closeDb, resetDb } from "./helpers/db";
import { bearerFor, createTestUser } from "./helpers/auth";
import {
  addDepotMember,
  seedDepot,
  seedEquipmentType,
  seedJobCard,
  seedMediaAsset,
} from "./helpers/fixtures";

beforeEach(async () => {
  await resetDb();
});

after(async () => {
  await closeDb();
});

/** A real file on disk, so the sweep has something to unlink. */
async function storedAsset(
  depotId: string,
  contents: string,
): Promise<{ id: string; storageKey: string }> {
  const stored = await storage.put(Buffer.from(contents), "image/jpeg");
  const id = await seedMediaAsset(depotId, {
    status: "READY",
    storageKey: stored.storageKey,
    checksum: stored.checksumSha256,
    sizeBytes: stored.sizeBytes,
  });
  return { id, storageKey: stored.storageKey };
}

async function assetExists(id: string): Promise<boolean> {
  const { rows } = await pool.query("SELECT 1 FROM media_assets WHERE id = $1", [id]);
  return rows.length > 0;
}

async function scenario() {
  const depotId = await seedDepot();
  const jobCardId = await seedJobCard(depotId, await seedEquipmentType());
  const user = await createTestUser({ role: "MECHANIC" });
  await addDepotMember(depotId, user.id);
  return { depotId, jobCardId, auth: bearerFor(user.id, user.role), actorId: user.id };
}

test("a PENDING row older than the window is reported; a younger one is not", async () => {
  const { depotId } = await scenario();
  const stale = await seedMediaAsset(depotId);
  const fresh = await seedMediaAsset(depotId);
  await pool.query("UPDATE media_assets SET created_at = now() - interval '3 days' WHERE id = $1", [
    stale,
  ]);

  const report = await reapMedia();

  assert.deepEqual(
    report.orphans.map((o) => o.id),
    [stale],
    `an upload still in flight must never be swept out from under itself (${fresh})`,
  );
});

test("an asset attached to a job card is not an orphan", async () => {
  const { depotId, jobCardId, actorId } = await scenario();
  const { id } = await storedAsset(depotId, "job card photo");
  await pool.query(
    "INSERT INTO job_card_media (job_card_id, media_asset_id, kind, created_by) VALUES ($1, $2, 'CHASSIS', $3)",
    [jobCardId, id, actorId],
  );

  assert.deepEqual((await reapMedia()).orphans, []);
});

test("an asset attached to an inspection item is not an orphan", async () => {
  const { depotId, jobCardId, auth } = await scenario();
  const { id } = await storedAsset(depotId, "line item photo");

  const item = await request(app)
    .post(`/job-cards/${jobCardId}/items`)
    .set("Authorization", auth)
    .send({ notes: "dent" });
  await request(app)
    .post(`/job-cards/${jobCardId}/items/${item.body.id}/media`)
    .set("Authorization", auth)
    .send({ media_id: id });

  assert.deepEqual(
    (await reapMedia()).orphans,
    [],
    "omitting inspection_item_media from the query would delete live photographs",
  );
});

test("an asset stranded by a deleted inspection item is reported", async () => {
  const { depotId, jobCardId, auth } = await scenario();
  const { id } = await storedAsset(depotId, "stranded photo");

  const item = await request(app)
    .post(`/job-cards/${jobCardId}/items`)
    .set("Authorization", auth)
    .send({ notes: "dent" });
  await request(app)
    .post(`/job-cards/${jobCardId}/items/${item.body.id}/media`)
    .set("Authorization", auth)
    .send({ media_id: id });
  await request(app)
    .delete(`/job-cards/${jobCardId}/items/${item.body.id}`)
    .set("Authorization", auth);

  assert.deepEqual(
    (await reapMedia()).orphans.map((o) => o.id),
    [id],
    "the link cascades away with the item; the asset row stays behind",
  );
});

test("a dry run deletes nothing at all", async () => {
  const { depotId } = await scenario();
  const { id, storageKey } = await storedAsset(depotId, "keep me");

  const report = await reapMedia();

  assert.equal(report.committed, false);
  assert.equal(report.orphans.length, 1);
  assert.equal(report.rowsDeleted, 0);
  assert.equal(report.filesDeleted, 0);
  assert.equal(await assetExists(id), true, "the default must never destroy anything");
  assert.equal(await storage.exists(storageKey), true);
});

test("a committed run removes the row and the file", async () => {
  const { depotId } = await scenario();
  const { id, storageKey } = await storedAsset(depotId, "sweep me");

  const report = await reapMedia({ commit: true });

  assert.equal(report.rowsDeleted, 1);
  assert.equal(report.filesDeleted, 1);
  assert.equal(await assetExists(id), false);
  assert.equal(await storage.exists(storageKey), false);
});

test("a row whose file is already gone is still swept, without erroring", async () => {
  const { depotId } = await scenario();
  const { id, storageKey } = await storedAsset(depotId, "half gone");
  await storage.remove(storageKey);

  const report = await reapMedia({ commit: true });

  assert.equal(report.rowsDeleted, 1);
  assert.equal(report.filesDeleted, 0, "missing is success; the sweep converges");
  assert.equal(await assetExists(id), false);
});

test("a PENDING row has no file to unlink and is swept cleanly", async () => {
  const { depotId } = await scenario();
  const id = await seedMediaAsset(depotId);
  await pool.query("UPDATE media_assets SET created_at = now() - interval '3 days' WHERE id = $1", [
    id,
  ]);

  const report = await reapMedia({ commit: true });

  assert.equal(report.rowsDeleted, 1);
  assert.equal(report.filesDeleted, 0);
  assert.equal(await assetExists(id), false);
});

test("two rows sharing one storage key: reaping one keeps the file for the other", async () => {
  const { depotId, jobCardId, actorId } = await scenario();
  // Identical bytes are written once and shared, so both rows name one file.
  const first = await storedAsset(depotId, "identical bytes");
  const second = await storedAsset(depotId, "identical bytes");
  assert.equal(first.storageKey, second.storageKey, "the store is content-addressed");

  // Keep the second one alive by attaching it to a card.
  await pool.query(
    "INSERT INTO job_card_media (job_card_id, media_asset_id, kind, created_by) VALUES ($1, $2, 'CHASSIS', $3)",
    [jobCardId, second.id, actorId],
  );

  const report = await reapMedia({ commit: true });

  assert.equal(report.rowsDeleted, 1);
  assert.equal(report.filesDeleted, 0);
  assert.equal(report.filesKeptShared, 1);
  assert.equal(await assetExists(second.id), true);
  assert.equal(
    await storage.exists(second.storageKey),
    true,
    "unlinking here would destroy a photograph another card is still showing",
  );
});

test("the pending window is configurable", async () => {
  const { depotId } = await scenario();
  const id = await seedMediaAsset(depotId);
  await pool.query("UPDATE media_assets SET created_at = now() - interval '2 hours' WHERE id = $1", [
    id,
  ]);

  assert.deepEqual((await reapMedia()).orphans, [], "two hours is inside the default 24h window");
  assert.equal(
    (await reapMedia({ pendingOlderThanMs: 60 * 60 * 1000 })).orphans.length,
    1,
  );
});

test("the report totals the bytes it found, committed or not", async () => {
  const { depotId } = await scenario();
  await storedAsset(depotId, "a".repeat(100));

  const report = await reapMedia();

  assert.equal(report.bytes, 100);
});

test("the command needs --commit to delete, and rejects an argument it does not know", () => {
  assert.equal(parseArgs([]).commit, false, "the destructive path is never the accidental one");
  assert.equal(parseArgs(["--commit"]).commit, true);
  assert.equal(
    parseArgs(["--pending-older-than-hours=72"]).pendingOlderThanMs,
    72 * 60 * 60 * 1000,
  );
  assert.throws(
    () => parseArgs(["--comit"]),
    "a typo'd flag must not silently become a dry run the operator thinks committed",
  );
});
