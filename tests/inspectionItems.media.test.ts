import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import request from "supertest";
import { app } from "../src/app";
import { pool } from "../src/db/pool";
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

const MISSING = "00000000-0000-0000-0000-000000000000";

async function scenario() {
  const depotId = await seedDepot();
  const jobCardId = await seedJobCard(depotId, await seedEquipmentType());
  const user = await createTestUser({ role: "MECHANIC" });
  await addDepotMember(depotId, user.id);
  const auth = bearerFor(user.id, user.role);

  const created = await request(app)
    .post(`/job-cards/${jobCardId}/items`)
    .set("Authorization", auth)
    .send({ notes: "dent" });

  return { depotId, jobCardId, auth, itemId: created.body.id as string };
}

const attach = (jobCardId: string, itemId: string, auth: string, mediaId: string) =>
  request(app)
    .post(`/job-cards/${jobCardId}/items/${itemId}/media`)
    .set("Authorization", auth)
    .send({ media_id: mediaId });

const listMedia = (jobCardId: string, itemId: string, auth: string) =>
  request(app).get(`/job-cards/${jobCardId}/items/${itemId}/media`).set("Authorization", auth);

const readyAsset = (depotId: string) =>
  seedMediaAsset(depotId, { status: "READY", storageKey: "ab/cdef", sizeBytes: 4096 });

test("attaching a READY asset works, and the list carries a signed URL", async () => {
  const { depotId, jobCardId, itemId, auth } = await scenario();
  const assetId = await readyAsset(depotId);

  const attached = await attach(jobCardId, itemId, auth, assetId);
  assert.equal(attached.status, 201);
  assert.equal(attached.body.id, assetId);
  assert.equal(attached.body.size_bytes, 4096);

  const listed = await listMedia(jobCardId, itemId, auth);
  assert.equal(listed.status, 200);
  assert.equal(listed.body.length, 1);
  assert.match(listed.body[0].url, /^\/assets\/media\/.+/);
  assert.equal(typeof listed.body[0].expires_at, "string");
  assert.equal(listed.body[0].display_order, 0);
});

test("attaching a PENDING asset is 409 MEDIA_NOT_READY", async () => {
  const { depotId, jobCardId, itemId, auth } = await scenario();
  const assetId = await seedMediaAsset(depotId);

  const res = await attach(jobCardId, itemId, auth, assetId);

  assert.equal(res.status, 409);
  assert.equal(res.body.code, "MEDIA_NOT_READY");
});

test("attaching another depot's asset is 404, not 403", async () => {
  const { jobCardId, itemId, auth } = await scenario();
  const foreignAssetId = await readyAsset(await seedDepot());

  const res = await attach(jobCardId, itemId, auth, foreignAssetId);

  assert.equal(res.status, 404, "the difference must not reveal that the asset exists");
});

test("re-attaching the same asset is a retry, not a conflict", async () => {
  const { depotId, jobCardId, itemId, auth } = await scenario();
  const assetId = await readyAsset(depotId);

  assert.equal((await attach(jobCardId, itemId, auth, assetId)).status, 201);
  assert.equal((await attach(jobCardId, itemId, auth, assetId)).status, 201);

  assert.equal((await listMedia(jobCardId, itemId, auth)).body.length, 1);
});

test("detaching removes the link and leaves the asset row alone", async () => {
  const { depotId, jobCardId, itemId, auth } = await scenario();
  const assetId = await readyAsset(depotId);
  await attach(jobCardId, itemId, auth, assetId);

  const res = await request(app)
    .delete(`/job-cards/${jobCardId}/items/${itemId}/media/${assetId}`)
    .set("Authorization", auth);

  assert.equal(res.status, 204);
  assert.deepEqual((await listMedia(jobCardId, itemId, auth)).body, []);

  const { rows } = await pool.query("SELECT 1 FROM media_assets WHERE id = $1", [assetId]);
  assert.equal(rows.length, 1, "content-addressed bytes may be shared; only a reaper removes them");
});

test("detaching an asset that is not attached is 404", async () => {
  const { depotId, jobCardId, itemId, auth } = await scenario();
  const assetId = await readyAsset(depotId);

  const res = await request(app)
    .delete(`/job-cards/${jobCardId}/items/${itemId}/media/${assetId}`)
    .set("Authorization", auth);

  assert.equal(res.status, 404);
});

test("deleting the item removes its links and still leaves the asset", async () => {
  const { depotId, jobCardId, itemId, auth } = await scenario();
  const assetId = await readyAsset(depotId);
  await attach(jobCardId, itemId, auth, assetId);

  const removed = await request(app)
    .delete(`/job-cards/${jobCardId}/items/${itemId}`)
    .set("Authorization", auth);

  assert.equal(
    removed.status,
    204,
    "RESTRICT is on the asset, not the item — deleting the item must not be blocked by it",
  );

  const { rows: links } = await pool.query(
    "SELECT 1 FROM inspection_item_media WHERE inspection_item_id = $1",
    [itemId],
  );
  assert.equal(links.length, 0);

  const { rows: assets } = await pool.query("SELECT 1 FROM media_assets WHERE id = $1", [assetId]);
  assert.equal(assets.length, 1);
});

test("attaching to an item on a locked card is 409 JOB_CARD_LOCKED", async () => {
  const { depotId, jobCardId, itemId, auth } = await scenario();
  const assetId = await readyAsset(depotId);
  await pool.query("UPDATE job_cards SET locked_at = now(), status = 'SUBMITTED' WHERE id = $1", [
    jobCardId,
  ]);

  const res = await attach(jobCardId, itemId, auth, assetId);

  assert.equal(res.status, 409);
  assert.equal(res.body.code, "JOB_CARD_LOCKED");
});

test("a locked card still serves an item's photographs", async () => {
  const { depotId, jobCardId, itemId, auth } = await scenario();
  await attach(jobCardId, itemId, auth, await readyAsset(depotId));
  await pool.query("UPDATE job_cards SET locked_at = now(), status = 'SUBMITTED' WHERE id = $1", [
    jobCardId,
  ]);

  const res = await listMedia(jobCardId, itemId, auth);

  assert.equal(res.status, 200);
  assert.equal(res.body.length, 1);
});

test("attaching to an item that belongs to a different card is 404", async () => {
  const { depotId, jobCardId, itemId, auth } = await scenario();
  const otherCardId = await seedJobCard(depotId, await seedEquipmentType());
  const assetId = await readyAsset(depotId);

  const res = await attach(otherCardId, itemId, auth, assetId);

  assert.equal(res.status, 404);
  assert.notEqual(jobCardId, otherCardId);
});

test("attaching an unknown asset is 404, and a malformed body is 400", async () => {
  const { jobCardId, itemId, auth } = await scenario();

  assert.equal((await attach(jobCardId, itemId, auth, MISSING)).status, 404);

  const malformed = await request(app)
    .post(`/job-cards/${jobCardId}/items/${itemId}/media`)
    .set("Authorization", auth)
    .send({ media_id: MISSING, kind: "CHASSIS" });
  assert.equal(malformed.status, 400, "line item media carries no kind");
});

test("the media routes need a token and the caller's own depot", async () => {
  const { depotId, jobCardId, itemId, auth } = await scenario();
  const assetId = await readyAsset(depotId);

  assert.equal(
    (await request(app).get(`/job-cards/${jobCardId}/items/${itemId}/media`)).status,
    401,
  );

  const outsider = await createTestUser({ role: "MECHANIC" });
  await addDepotMember(await seedDepot(), outsider.id);
  const outsiderAuth = bearerFor(outsider.id, outsider.role);

  assert.equal((await attach(jobCardId, itemId, outsiderAuth, assetId)).status, 403);
  assert.equal((await listMedia(jobCardId, itemId, outsiderAuth)).status, 403);
});

test("a second photograph appends rather than colliding on display_order", async () => {
  const { depotId, jobCardId, itemId, auth } = await scenario();
  const first = await readyAsset(depotId);
  const second = await seedMediaAsset(depotId, { status: "READY", storageKey: "cd/ef01" });

  await attach(jobCardId, itemId, auth, first);
  await attach(jobCardId, itemId, auth, second);

  const listed = await listMedia(jobCardId, itemId, auth);
  assert.deepEqual(
    listed.body.map((m: { display_order: number }) => m.display_order),
    [0, 1],
  );
  assert.deepEqual(
    listed.body.map((m: { id: string }) => m.id),
    [first, second],
  );
});
