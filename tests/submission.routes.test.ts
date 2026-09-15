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

const MISSING = "00000000-0000-0000-0000-000000000000";

const COMPLETE = {
  inspected_at: new Date("2026-09-01T09:00:00Z"),
  chassis_number: "CHS-1000",
  size: 40,
  equipment_form: "STANDARD",
  customer_name: "Acme Logistics",
  driver_name: "R. Diaz",
};

async function memberAt(depotId: string, role: Role = "MECHANIC") {
  const user = await createTestUser({ role });
  await addDepotMember(depotId, user.id);
  return { user, auth: bearerFor(user.id, user.role) };
}

/** A card that will pass validation, built entirely through the API. */
async function scenario({ complete = true } = {}) {
  const depotId = await seedDepot();
  const jobCardId = await seedJobCard(
    depotId,
    await seedEquipmentType(),
    complete ? COMPLETE : { chassis_number: "CHS-2000" },
  );
  const { auth } = await memberAt(depotId);

  if (complete) {
    const item = await request(app)
      .post(`/job-cards/${jobCardId}/items`)
      .set("Authorization", auth)
      .send({ notes: "dent" });
    const signature = await request(app)
      .post(`/job-cards/${jobCardId}/signature`)
      .set("Authorization", auth)
      .send({ signer_name: "A. Customer", signer_role: "CUSTOMER" });

    // Assert the setup, not just the behaviour under test. A 403 here — which
    // has been seen intermittently, and is suspected to be a depot membership
    // insert not yet visible to the request that reads it — leaves an unsigned,
    // item-less card, and the failure then surfaces three assertions later as
    // "a locked card accepted a PATCH". Naming it here costs two lines.
    assert.equal(item.status, 201, `setup: item POST said ${JSON.stringify(item.body)}`);
    assert.equal(
      signature.status,
      201,
      `setup: signature POST said ${JSON.stringify(signature.body)}`,
    );
  }

  return { depotId, jobCardId, auth };
}

const submit = (jobCardId: string, auth: string) =>
  request(app).post(`/job-cards/${jobCardId}/submit`).set("Authorization", auth);

const events = (jobCardId: string, auth: string) =>
  request(app).get(`/job-cards/${jobCardId}/events`).set("Authorization", auth);

test("submitting a ready card is 200 with the locked record", async () => {
  const { jobCardId, auth } = await scenario();

  const res = await submit(jobCardId, auth);

  assert.equal(res.status, 200);
  assert.equal(res.body.status, "SUBMITTED");
  assert.equal(res.body.can_edit, false);
  assert.ok(res.body.submitted_at);
  assert.ok(res.body.locked_at);
});

test("an incomplete card is 422 SUBMISSION_INCOMPLETE listing everything at once", async () => {
  const { jobCardId, auth } = await scenario({ complete: false });

  const res = await submit(jobCardId, auth);

  assert.equal(res.status, 422);
  assert.equal(res.body.code, "SUBMISSION_INCOMPLETE");
  assert.ok(res.body.violations.length > 1, "a gatekeeper should not fix one field per request");
  assert.ok(res.body.violations.some((v: string) => v.startsWith("items:")));
  assert.ok(res.body.violations.some((v: string) => v.startsWith("signature:")));
});

test("re-submitting is 200, not a conflict", async () => {
  const { jobCardId, auth } = await scenario();
  const first = await submit(jobCardId, auth);

  const second = await submit(jobCardId, auth);

  assert.equal(
    second.status,
    200,
    "the lock guard is deliberately absent here; it would turn a retry into a 409",
  );
  assert.equal(second.body.submitted_at, first.body.submitted_at);
});

test("a submitted card refuses every other kind of write", async () => {
  const { jobCardId, auth } = await scenario();

  const submitted = await submit(jobCardId, auth);
  assert.equal(
    submitted.status,
    200,
    `the card must actually be submitted first: ${JSON.stringify(submitted.body)}`,
  );

  const patched = await request(app)
    .patch(`/job-cards/${jobCardId}`)
    .set("Authorization", auth)
    .send({ customer_name: "Too Late" });
  assert.equal(patched.status, 409);
  assert.equal(patched.body.code, "JOB_CARD_LOCKED");

  const item = await request(app)
    .post(`/job-cards/${jobCardId}/items`)
    .set("Authorization", auth)
    .send({ notes: "too late" });
  assert.equal(item.status, 409);

  const signature = await request(app)
    .post(`/job-cards/${jobCardId}/signature`)
    .set("Authorization", auth)
    .send({ signer_name: "B. Customer", signer_role: "CUSTOMER" });
  assert.equal(signature.status, 409);
});

test("submitting needs a token, and the caller's own depot", async () => {
  const { jobCardId } = await scenario();

  assert.equal((await request(app).post(`/job-cards/${jobCardId}/submit`)).status, 401);

  const { auth: outsider } = await memberAt(await seedDepot());
  const res = await submit(jobCardId, outsider);
  assert.equal(res.status, 403);
  assert.equal(res.body.code, "DEPOT_FORBIDDEN");
});

test("submitting at a disabled depot is 403 DEPOT_DISABLED", async () => {
  const { depotId, jobCardId, auth } = await scenario();
  await pool.query("UPDATE depots SET is_disabled = true WHERE id = $1", [depotId]);

  const res = await submit(jobCardId, auth);

  assert.equal(res.status, 403);
  assert.equal(res.body.code, "DEPOT_DISABLED");
});

test("a malformed id is 400 and an unknown card is 404", async () => {
  const { auth } = await scenario();

  assert.equal(
    (await request(app).post("/job-cards/not-a-uuid/submit").set("Authorization", auth)).status,
    400,
  );
  assert.equal((await submit(MISSING, auth)).status, 404);
});

test("the event history reads forward and shows the whole life of the card", async () => {
  const { jobCardId, auth } = await scenario();
  await submit(jobCardId, auth);

  const res = await events(jobCardId, auth);

  assert.equal(res.status, 200);
  assert.deepEqual(
    res.body.map((e: { from_status: string; to_status: string }) => [e.from_status, e.to_status]),
    [
      ["DRAFT", "IN_INSPECTION"],
      ["IN_INSPECTION", "SUBMITTED"],
    ],
  );
  assert.ok(res.body[1].note, "each row says what happened in words a person can read");
});

test("a card with no history yet answers with an empty list", async () => {
  const { jobCardId, auth } = await scenario({ complete: false });

  const res = await events(jobCardId, auth);

  assert.equal(res.status, 200);
  assert.deepEqual(res.body, []);
});

test("the history stays readable once the card is locked", async () => {
  const { jobCardId, auth } = await scenario();
  await submit(jobCardId, auth);

  assert.equal(
    (await events(jobCardId, auth)).status,
    200,
    "a submitted card is exactly when its history is wanted",
  );
});

test("the history needs a token, and the caller's own depot", async () => {
  const { jobCardId } = await scenario();

  assert.equal((await request(app).get(`/job-cards/${jobCardId}/events`)).status, 401);

  const { auth: outsider } = await memberAt(await seedDepot());
  assert.equal((await events(jobCardId, outsider)).status, 403);
});

test("the history of an unknown card is 404, not an empty list", async () => {
  const { auth } = await scenario();

  assert.equal(
    (await events(MISSING, auth)).status,
    404,
    "'no such card' and 'no history yet' are different answers",
  );
});
