import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import request from "supertest";
import { app } from "../src/app";
import { pool } from "../src/db/pool";
import { closeDb, resetDb } from "./helpers/db";
import { bearerFor, createTestUser } from "./helpers/auth";
import { addDepotMember, seedDepot, seedEquipmentType, seedJobCard } from "./helpers/fixtures";
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

const body = { signer_name: "A. Customer", signer_role: "CUSTOMER" };

const sign = (jobCardId: string, auth: string, payload: object = body) =>
  request(app).post(`/job-cards/${jobCardId}/signature`).set("Authorization", auth).send(payload);

const verify = (jobCardId: string, auth: string) =>
  request(app).get(`/job-cards/${jobCardId}/signature/verify`).set("Authorization", auth);

test("recording then verifying is the happy path", async () => {
  const { jobCardId, auth } = await scenario();

  const recorded = await sign(jobCardId, auth);
  assert.equal(recorded.status, 201);
  assert.equal(recorded.body.signer_name, "A. Customer");
  assert.equal(recorded.body.key_version, 1);
  assert.equal(recorded.body.receipt_hmac, undefined);
  assert.equal(recorded.body.nonce, undefined);

  const verified = await verify(jobCardId, auth);
  assert.equal(verified.status, 200);
  assert.equal(verified.body.valid, true);
  assert.equal(verified.body.signer_name, "A. Customer");
});

test("verifying an unsigned card is 200 with valid:false, not an error", async () => {
  const { jobCardId, auth } = await scenario();

  const res = await verify(jobCardId, auth);

  assert.equal(res.status, 200, "'nobody has signed yet' is an answer, not a failure");
  assert.deepEqual(res.body, { valid: false, reason: "NO_SIGNATURE" });
});

test("editing intake after signing shows up as CONTENT_MODIFIED", async () => {
  const { jobCardId, auth } = await scenario();
  await sign(jobCardId, auth);

  const patched = await request(app)
    .patch(`/job-cards/${jobCardId}`)
    .set("Authorization", auth)
    .send({ customer_name: "Different Customer" });
  assert.equal(patched.status, 200);

  const res = await verify(jobCardId, auth);
  assert.equal(res.body.valid, false);
  assert.equal(res.body.reason, "CONTENT_MODIFIED");
});

test("recording with no token is 401", async () => {
  const { jobCardId } = await scenario();
  const res = await request(app).post(`/job-cards/${jobCardId}/signature`).send(body);
  assert.equal(res.status, 401);
});

test("verifying with no token is 401", async () => {
  const { jobCardId } = await scenario();
  const res = await request(app).get(`/job-cards/${jobCardId}/signature/verify`);
  assert.equal(res.status, 401);
});

test("a member of another depot cannot sign this depot's card", async () => {
  const { jobCardId } = await scenario();
  const { auth: outsider } = await memberAt(await seedDepot());

  const res = await sign(jobCardId, outsider);

  assert.equal(res.status, 403);
  assert.equal(res.body.code, "DEPOT_FORBIDDEN");
});

test("a member of another depot cannot verify this depot's card", async () => {
  const { jobCardId } = await scenario();
  const { auth: outsider } = await memberAt(await seedDepot());

  assert.equal((await verify(jobCardId, outsider)).status, 403);
});

test("a member of another depot cannot read this depot's signature history", async () => {
  const { jobCardId, auth } = await scenario();
  await sign(jobCardId, auth);
  const { auth: outsider } = await memberAt(await seedDepot());

  const res = await request(app)
    .get(`/job-cards/${jobCardId}/signature/history`)
    .set("Authorization", outsider);

  assert.equal(res.status, 403);
});

test("signing a locked card is 409 JOB_CARD_LOCKED", async () => {
  const { jobCardId, auth } = await scenario();
  await pool.query("UPDATE job_cards SET locked_at = now(), status = 'SUBMITTED' WHERE id = $1", [
    jobCardId,
  ]);

  const res = await sign(jobCardId, auth);

  assert.equal(res.status, 409);
  assert.equal(res.body.code, "JOB_CARD_LOCKED");
});

test("verifying a locked card still works", async () => {
  const { jobCardId, auth } = await scenario();
  await sign(jobCardId, auth);
  await pool.query("UPDATE job_cards SET locked_at = now(), status = 'SUBMITTED' WHERE id = $1", [
    jobCardId,
  ]);

  const res = await verify(jobCardId, auth);

  assert.equal(res.status, 200, "a submitted card is exactly when a receipt gets checked");
  assert.equal(res.body.valid, true);
});

test("signing at a disabled depot is 403 DEPOT_DISABLED", async () => {
  const { depotId, jobCardId, auth } = await scenario();
  await pool.query("UPDATE depots SET is_disabled = true WHERE id = $1", [depotId]);

  const res = await sign(jobCardId, auth);

  assert.equal(res.status, 403);
  assert.equal(res.body.code, "DEPOT_DISABLED", "the depot rule reaches signatures for free");
});

test("verifying at a disabled depot still works", async () => {
  const { depotId, jobCardId, auth } = await scenario();
  await sign(jobCardId, auth);
  await pool.query("UPDATE depots SET is_disabled = true WHERE id = $1", [depotId]);

  assert.equal((await verify(jobCardId, auth)).status, 200, "a closed depot stays readable");
});

test("a malformed body is 400 with a violation per field", async () => {
  const { jobCardId, auth } = await scenario();

  const res = await sign(jobCardId, auth, { signer_name: "", signer_role: "MANAGER" });

  assert.equal(res.status, 400);
  assert.equal(res.body.code, "VALIDATION_ERROR");
  assert.equal(res.body.violations.length, 2);
});

test("supplying a receipt field is rejected rather than honoured", async () => {
  const { jobCardId, auth } = await scenario();

  const res = await sign(jobCardId, auth, { ...body, receipt_hmac: "f".repeat(64) });

  assert.equal(res.status, 400);
});

test("a signed_at outside the accepted window is 400", async () => {
  const { jobCardId, auth } = await scenario();
  const tooOld = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  const res = await sign(jobCardId, auth, { ...body, signed_at: tooOld });

  assert.equal(res.status, 400);
  assert.equal(res.body.code, "VALIDATION_ERROR");
});

test("a malformed job card id is 400, not 500", async () => {
  const { auth } = await scenario();
  const res = await request(app)
    .get("/job-cards/not-a-uuid/signature/verify")
    .set("Authorization", auth);
  assert.equal(res.status, 400);
});

test("an unknown job card is 404", async () => {
  const { auth } = await scenario();
  const res = await verify("00000000-0000-0000-0000-000000000000", auth);
  assert.equal(res.status, 404);
});

test("the history route returns every receipt, newest first", async () => {
  const { jobCardId, auth } = await scenario();
  await sign(jobCardId, auth);
  await sign(jobCardId, auth, { ...body, signer_name: "B. Customer" });

  const res = await request(app)
    .get(`/job-cards/${jobCardId}/signature/history`)
    .set("Authorization", auth);

  assert.equal(res.status, 200);
  assert.deepEqual(
    res.body.map((s: { signer_name: string }) => s.signer_name),
    ["B. Customer", "A. Customer"],
  );
});

test("mounting the signatures router did not break the public endpoints", async () => {
  // signaturesRouter is mounted at "/" like the others, so a router-wide
  // requireAuth would reject requests bound for routers after it.
  assert.equal((await request(app).get("/health")).status, 200);
  assert.equal((await request(app).get("/app-config")).status, 200);
});
