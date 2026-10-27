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
import { Role } from "../src/types";

beforeEach(async () => {
  await resetDb();
});

after(async () => {
  await closeDb();
});

async function memberAt(depotId: string, role: Role = "MECHANIC") {
  const user = await createTestUser({ role });
  await addDepotMember(depotId, user.id);
  return { user, auth: bearerFor(user.id, user.role) };
}

async function scenario() {
  const depotId = await seedDepot();
  const jobCardId = await seedJobCard(depotId, await seedEquipmentType());
  const { auth } = await memberAt(depotId);
  return { depotId, jobCardId, auth };
}

const signBody = { signer_name: "A. Customer", signer_role: "CUSTOMER" };

const sign = (jobCardId: string, auth: string) =>
  request(app).post(`/job-cards/${jobCardId}/signature`).set("Authorization", auth).send(signBody);

const attach = (jobCardId: string, auth: string, mediaId: string) =>
  request(app)
    .post(`/job-cards/${jobCardId}/signature/image`)
    .set("Authorization", auth)
    .send({ media_id: mediaId });

test("attaching a READY image after a receipt returns image_url", async () => {
  const { depotId, jobCardId, auth } = await scenario();
  await sign(jobCardId, auth);
  const mediaId = await seedMediaAsset(depotId, { status: "READY", contentType: "image/png" });

  const res = await attach(jobCardId, auth, mediaId);

  assert.equal(res.status, 201);
  assert.match(res.body.image_url, /^\/assets\/media\//);
  assert.ok(res.body.expires_at);
});

test("verify and the card read include image_url when the receipt is valid", async () => {
  const { depotId, jobCardId, auth } = await scenario();
  await sign(jobCardId, auth);
  const mediaId = await seedMediaAsset(depotId, { status: "READY" });
  await attach(jobCardId, auth, mediaId);

  const verified = await request(app)
    .get(`/job-cards/${jobCardId}/signature/verify`)
    .set("Authorization", auth);
  assert.equal(verified.status, 200);
  assert.equal(verified.body.valid, true);
  assert.match(verified.body.image_url, /^\/assets\/media\//);

  const card = await request(app).get(`/job-cards/${jobCardId}`).set("Authorization", auth);
  assert.equal(card.body.signature.valid, true);
  assert.match(card.body.signature.image_url, /^\/assets\/media\//);
});

test("history includes image_url on the receipt that has ink", async () => {
  const { depotId, jobCardId, auth } = await scenario();
  await sign(jobCardId, auth);
  const mediaId = await seedMediaAsset(depotId, { status: "READY" });
  await attach(jobCardId, auth, mediaId);

  const history = await request(app)
    .get(`/job-cards/${jobCardId}/signature/history`)
    .set("Authorization", auth);

  assert.equal(history.status, 200);
  assert.equal(history.body.length, 1);
  assert.match(history.body[0].image_url, /^\/assets\/media\//);
});

test("attaching without a receipt is 404", async () => {
  const { depotId, jobCardId, auth } = await scenario();
  const mediaId = await seedMediaAsset(depotId, { status: "READY" });

  const res = await attach(jobCardId, auth, mediaId);
  assert.equal(res.status, 404);
});

test("a media asset from another depot is 404", async () => {
  const { jobCardId, auth } = await scenario();
  await sign(jobCardId, auth);
  const otherDepot = await seedDepot();
  const mediaId = await seedMediaAsset(otherDepot, { status: "READY" });

  const res = await attach(jobCardId, auth, mediaId);
  assert.equal(res.status, 404);
});

test("a PENDING asset is 409 MEDIA_NOT_READY", async () => {
  const { depotId, jobCardId, auth } = await scenario();
  await sign(jobCardId, auth);
  const mediaId = await seedMediaAsset(depotId, { status: "PENDING" });

  const res = await attach(jobCardId, auth, mediaId);
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "MEDIA_NOT_READY");
});

test("a second attach on the same receipt is 409", async () => {
  const { depotId, jobCardId, auth } = await scenario();
  await sign(jobCardId, auth);
  const first = await seedMediaAsset(depotId, { status: "READY" });
  const second = await seedMediaAsset(depotId, { status: "READY" });
  assert.equal((await attach(jobCardId, auth, first)).status, 201);

  const res = await attach(jobCardId, auth, second);
  assert.equal(res.status, 409);
});

test("a locked card refuses a new image", async () => {
  const { depotId, jobCardId, auth } = await scenario();
  await sign(jobCardId, auth);
  await pool.query("UPDATE job_cards SET locked_at = now(), status = 'SUBMITTED' WHERE id = $1", [
    jobCardId,
  ]);
  const mediaId = await seedMediaAsset(depotId, { status: "READY" });

  const res = await attach(jobCardId, auth, mediaId);
  assert.equal(res.status, 409);
  assert.equal(res.body.code, "JOB_CARD_LOCKED");
});

test("re-signing then attaching succeeds on the new receipt", async () => {
  const { depotId, jobCardId, auth } = await scenario();
  await sign(jobCardId, auth);
  const first = await seedMediaAsset(depotId, { status: "READY" });
  assert.equal((await attach(jobCardId, auth, first)).status, 201);

  await request(app)
    .patch(`/job-cards/${jobCardId}`)
    .set("Authorization", auth)
    .send({ customer_name: "Different Customer" });

  assert.equal((await sign(jobCardId, auth)).status, 201);
  const second = await seedMediaAsset(depotId, { status: "READY" });
  const res = await attach(jobCardId, auth, second);
  assert.equal(res.status, 201);
  assert.match(res.body.image_url, /^\/assets\/media\//);

  const history = await request(app)
    .get(`/job-cards/${jobCardId}/signature/history`)
    .set("Authorization", auth);
  assert.equal(history.body.length, 2);
  assert.match(history.body[0].image_url, /^\/assets\/media\//);
  assert.match(history.body[1].image_url, /^\/assets\/media\//);
});

test("signature ink is not listed as a photograph", async () => {
  const { depotId, jobCardId, auth } = await scenario();
  await sign(jobCardId, auth);
  const mediaId = await seedMediaAsset(depotId, { status: "READY" });
  await attach(jobCardId, auth, mediaId);

  const photos = await request(app)
    .get(`/job-cards/${jobCardId}/photographs`)
    .set("Authorization", auth);

  assert.equal(photos.status, 200);
  assert.equal(photos.body.length, 0);
});
