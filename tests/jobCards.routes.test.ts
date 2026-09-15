import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import request from "supertest";
import { app } from "../src/app";
import { pool } from "../src/db/pool";
import { closeDb, resetDb } from "./helpers/db";
import { bearerFor, createTestUser } from "./helpers/auth";
import { addDepotMember, seedDepot, seedEquipmentType } from "./helpers/fixtures";
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
  const equipmentTypeId = await seedEquipmentType();
  const { user, auth } = await memberAt(depotId);
  return { depotId, equipmentTypeId, user, auth };
}

const validBody = (equipmentTypeId: string) => ({
  direction: "INBOUND",
  equipment_type_id: equipmentTypeId,
  chassis_number: "CHS-9",
});

function createCard(depotId: string, auth: string, body: Record<string, unknown>) {
  return request(app).post(`/depots/${depotId}/job-cards`).set("Authorization", auth).send(body);
}

test("a depot member creates a card and reads it back", async () => {
  const { depotId, equipmentTypeId, auth } = await scenario();

  const created = await createCard(depotId, auth, validBody(equipmentTypeId));

  assert.equal(created.status, 201);
  assert.match(created.body.job_number, /^VIR-[0-9A-Z]{8}$/);
  assert.equal(created.body.can_edit, true);

  const fetched = await request(app)
    .get(`/job-cards/${created.body.id}`)
    .set("Authorization", auth);
  assert.equal(fetched.status, 200);
  assert.equal(fetched.body.id, created.body.id);
});

test("a replayed client_uuid returns 200 with the same card", async () => {
  const { depotId, equipmentTypeId, auth } = await scenario();
  const body = {
    ...validBody(equipmentTypeId),
    client_uuid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  };

  const first = await createCard(depotId, auth, body);
  const second = await createCard(depotId, auth, body);

  assert.equal(first.status, 201);
  assert.equal(second.status, 200, "a replay is not a creation");
  assert.equal(second.body.id, first.body.id);
});

test("a member of another depot is refused with 403 DEPOT_FORBIDDEN", async () => {
  const { depotId, equipmentTypeId } = await scenario();
  const otherDepot = await seedDepot();
  const { auth: outsider } = await memberAt(otherDepot);

  const res = await createCard(depotId, outsider, validBody(equipmentTypeId));

  assert.equal(res.status, 403);
  assert.equal(res.body.code, "DEPOT_FORBIDDEN");
  assert.notEqual(
    res.body.error,
    "DEPOT_FORBIDDEN",
    "the message is prose for a human; the code is the token clients branch on",
  );
});

test("a request with no token is 401", async () => {
  const { depotId, equipmentTypeId } = await scenario();
  const res = await request(app)
    .post(`/depots/${depotId}/job-cards`)
    .send(validBody(equipmentTypeId));
  assert.equal(res.status, 401);
});

test("an invalid body is 400 VALIDATION_ERROR with per-field violations", async () => {
  const { depotId, auth } = await scenario();

  const res = await createCard(depotId, auth, {
    direction: "SIDEWAYS",
    equipment_type_id: "not-a-uuid",
  });

  assert.equal(res.status, 400);
  assert.equal(res.body.code, "VALIDATION_ERROR");
  assert.ok(Array.isArray(res.body.violations));
  assert.ok(res.body.violations.some((v: string) => v.startsWith("direction:")));
});

test("a misspelled field is rejected rather than silently dropped", async () => {
  const { depotId, equipmentTypeId, auth } = await scenario();

  const res = await createCard(depotId, auth, {
    ...validBody(equipmentTypeId),
    chasis_number: "typo",
  });
  assert.equal(res.status, 400);
});

test("list is depot-scoped, filtered, and enveloped", async () => {
  const { depotId, equipmentTypeId, auth } = await scenario();
  await createCard(depotId, auth, { ...validBody(equipmentTypeId), customer_name: "Hapag" });
  await createCard(depotId, auth, {
    ...validBody(equipmentTypeId),
    direction: "OUTBOUND",
    customer_name: "Maersk",
  });

  const all = await request(app).get(`/depots/${depotId}/job-cards`).set("Authorization", auth);
  assert.equal(all.status, 200);
  assert.equal(all.body.data.length, 2);
  assert.deepEqual(Object.keys(all.body.pagination).sort(), [
    "has_more",
    "limit",
    "offset",
    "total",
  ]);

  const filtered = await request(app)
    .get(`/depots/${depotId}/job-cards?direction=OUTBOUND&q=maersk`)
    .set("Authorization", auth);
  assert.equal(filtered.body.data.length, 1);
  assert.equal(filtered.body.data[0].customer_name, "Maersk");
});

test("a bad query parameter is 400 rather than a silently ignored filter", async () => {
  const { depotId, auth } = await scenario();
  const res = await request(app)
    .get(`/depots/${depotId}/job-cards?status=NOPE`)
    .set("Authorization", auth);
  assert.equal(res.status, 400);
  assert.equal(res.body.code, "VALIDATION_ERROR");
});

test("an unknown query parameter is ignored", async () => {
  const { depotId, auth } = await scenario();
  const res = await request(app)
    .get(`/depots/${depotId}/job-cards?utm_source=email`)
    .set("Authorization", auth);
  assert.equal(res.status, 200, "a stray tracking parameter is not a client bug");
});

test("PATCH updates present fields and clears explicit nulls", async () => {
  const { depotId, equipmentTypeId, auth } = await scenario();
  const created = await createCard(depotId, auth, {
    ...validBody(equipmentTypeId),
    container_number: "MSCU1234567",
    pool_point: "LAX-3",
  });

  const patched = await request(app)
    .patch(`/job-cards/${created.body.id}`)
    .set("Authorization", auth)
    .send({ container_number: null, customer_name: "Hapag" });

  assert.equal(patched.status, 200);
  assert.equal(patched.body.container_number, null);
  assert.equal(patched.body.customer_name, "Hapag");
  assert.equal(patched.body.pool_point, "LAX-3");
});

test("PATCH on a locked card is 409 JOB_CARD_LOCKED", async () => {
  const { depotId, equipmentTypeId, auth } = await scenario();
  const created = await createCard(depotId, auth, validBody(equipmentTypeId));

  await pool.query("UPDATE job_cards SET locked_at = now(), status = 'SUBMITTED' WHERE id = $1", [
    created.body.id,
  ]);

  const patched = await request(app)
    .patch(`/job-cards/${created.body.id}`)
    .set("Authorization", auth)
    .send({ customer_name: "too late" });

  assert.equal(patched.status, 409);
  assert.equal(patched.body.code, "JOB_CARD_LOCKED");
});

test("a locked card is still readable and reports can_edit false", async () => {
  const { depotId, equipmentTypeId, auth } = await scenario();
  const created = await createCard(depotId, auth, validBody(equipmentTypeId));
  await pool.query("UPDATE job_cards SET locked_at = now(), status = 'SUBMITTED' WHERE id = $1", [
    created.body.id,
  ]);

  const read = await request(app)
    .get(`/job-cards/${created.body.id}`)
    .set("Authorization", auth);
  assert.equal(read.status, 200);
  assert.equal(read.body.can_edit, false);
});

test("a stale If-Unmodified-Since is 409 STALE_WRITE", async () => {
  const { depotId, equipmentTypeId, auth } = await scenario();
  const created = await createCard(depotId, auth, validBody(equipmentTypeId));

  const stale = new Date(Date.parse(created.body.updated_at) - 60_000).toUTCString();
  const res = await request(app)
    .patch(`/job-cards/${created.body.id}`)
    .set("Authorization", auth)
    .set("If-Unmodified-Since", stale)
    .send({ customer_name: "x" });

  assert.equal(res.status, 409);
  assert.equal(res.body.code, "STALE_WRITE");
});

test("an uppercase UUID in the path resolves the same card", async () => {
  const { depotId, equipmentTypeId, auth } = await scenario();
  const created = await createCard(depotId, auth, validBody(equipmentTypeId));

  const res = await request(app)
    .get(`/job-cards/${String(created.body.id).toUpperCase()}`)
    .set("Authorization", auth);

  assert.equal(res.status, 200, "Postgres compares uuid case-insensitively; so must we");
  assert.equal(res.body.id, created.body.id);
});

test("a malformed job card id is 400, not 500", async () => {
  const { auth } = await scenario();
  const res = await request(app).get("/job-cards/not-a-uuid").set("Authorization", auth);
  assert.equal(res.status, 400);
});

test("a card at another depot is refused, not disclosed", async () => {
  const { depotId, equipmentTypeId, auth } = await scenario();
  const created = await createCard(depotId, auth, validBody(equipmentTypeId));

  const otherDepot = await seedDepot();
  const { auth: outsider } = await memberAt(otherDepot);

  const res = await request(app)
    .get(`/job-cards/${created.body.id}`)
    .set("Authorization", outsider);
  assert.equal(res.status, 403);
  assert.equal(res.body.code, "DEPOT_FORBIDDEN");
});

test("an admin reads a card at a depot they are not a member of", async () => {
  const { depotId, equipmentTypeId, auth } = await scenario();
  const created = await createCard(depotId, auth, validBody(equipmentTypeId));

  const admin = await createTestUser({ role: "ADMIN" });
  const res = await request(app)
    .get(`/job-cards/${created.body.id}`)
    .set("Authorization", bearerFor(admin.id, admin.role));

  assert.equal(res.status, 200);
});

test("a user with no depot membership cannot reach the intake routes", async () => {
  const { depotId, equipmentTypeId } = await scenario();
  const stranger = await createTestUser({ role: "MECHANIC" });

  const res = await createCard(
    depotId,
    bearerFor(stranger.id, stranger.role),
    validBody(equipmentTypeId),
  );
  assert.equal(res.status, 403);
});
