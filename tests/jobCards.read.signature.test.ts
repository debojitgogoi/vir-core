import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import request from "supertest";
import { app } from "../src/app";
import { pool } from "../src/db/pool";
import { closeDb, resetDb } from "./helpers/db";
import { bearerFor, createTestUser } from "./helpers/auth";
import { addDepotMember, seedDepot, seedEquipmentType, seedJobCard } from "./helpers/fixtures";

beforeEach(async () => {
  await resetDb();
});

after(async () => {
  await closeDb();
});

async function scenario() {
  const depotId = await seedDepot();
  const jobCardId = await seedJobCard(depotId, await seedEquipmentType());
  const user = await createTestUser({ role: "MECHANIC" });
  await addDepotMember(depotId, user.id);
  return { jobCardId, auth: bearerFor(user.id, user.role) };
}

const sign = (jobCardId: string, auth: string) =>
  request(app)
    .post(`/job-cards/${jobCardId}/signature`)
    .set("Authorization", auth)
    .send({ signer_name: "A. Customer", signer_role: "CUSTOMER" });

test("an unsigned card reads with signature.valid false and NO_SIGNATURE", async () => {
  const { jobCardId, auth } = await scenario();

  const res = await request(app).get(`/job-cards/${jobCardId}`).set("Authorization", auth);

  assert.equal(res.status, 200);
  assert.deepEqual(res.body.signature, { valid: false, reason: "NO_SIGNATURE" });
});

test("a signed card reads with signature.valid true", async () => {
  const { jobCardId, auth } = await scenario();
  await sign(jobCardId, auth);

  const res = await request(app).get(`/job-cards/${jobCardId}`).set("Authorization", auth);

  assert.equal(res.body.signature.valid, true);
  assert.equal(res.body.signature.signer_name, "A. Customer");
});

test("the read reflects an edit made after signing, rather than a stale flag", async () => {
  const { jobCardId, auth } = await scenario();
  await sign(jobCardId, auth);

  await request(app)
    .patch(`/job-cards/${jobCardId}`)
    .set("Authorization", auth)
    .send({ customer_name: "Different Customer" });

  const res = await request(app).get(`/job-cards/${jobCardId}`).set("Authorization", auth);
  assert.deepEqual(res.body.signature, { valid: false, reason: "CONTENT_MODIFIED" });
});

test("the card read still carries media, so one request renders the whole card", async () => {
  const { jobCardId, auth } = await scenario();

  const res = await request(app).get(`/job-cards/${jobCardId}`).set("Authorization", auth);

  assert.deepEqual(res.body.media, []);
  assert.ok("signature" in res.body);
  assert.ok("can_edit" in res.body);
});

test("a locked card still reports its signature status", async () => {
  const { jobCardId, auth } = await scenario();
  await sign(jobCardId, auth);
  await pool.query("UPDATE job_cards SET locked_at = now(), status = 'SUBMITTED' WHERE id = $1", [
    jobCardId,
  ]);

  const res = await request(app).get(`/job-cards/${jobCardId}`).set("Authorization", auth);

  assert.equal(res.body.can_edit, false);
  assert.equal(res.body.signature.valid, true);
});
