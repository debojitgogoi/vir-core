import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import request from "supertest";
import { app } from "../src/app";
import { closeDb, resetDb } from "./helpers/db";
import { bearerFor, createTestUser } from "./helpers/auth";
import { seedEquipmentType } from "./helpers/fixtures";

beforeEach(async () => {
  await resetDb();
});

after(async () => {
  await closeDb();
});

async function adminAuth(): Promise<string> {
  const admin = await createTestUser({ role: "ADMIN" });
  return bearerFor(admin.id, admin.role);
}

test("an admin can create a depot and read it back", async () => {
  const auth = await adminAuth();

  const created = await request(app)
    .post("/depots")
    .set("Authorization", auth)
    .send({ code: "lax", name: "Los Angeles", timezone: "America/Los_Angeles" });

  assert.equal(created.status, 201);
  assert.equal(created.body.code, "LAX", "code is normalized to uppercase");
  assert.equal(created.body.slug_id.length, 8);

  const fetched = await request(app)
    .get(`/depots/${created.body.id}`)
    .set("Authorization", auth);

  assert.equal(fetched.status, 200);
  assert.equal(fetched.body.name, "Los Angeles");
});

test("a duplicate depot code is rejected with 409", async () => {
  const auth = await adminAuth();
  await request(app).post("/depots").set("Authorization", auth).send({ code: "LAX", name: "LA" });

  const second = await request(app)
    .post("/depots")
    .set("Authorization", auth)
    .send({ code: "LAX", name: "LA Again" });

  assert.equal(second.status, 409);
});

test("creating a depot without a name is rejected with 400", async () => {
  const auth = await adminAuth();
  const res = await request(app).post("/depots").set("Authorization", auth).send({ code: "LAX" });
  assert.equal(res.status, 400);
});

test("a mechanic cannot create a depot", async () => {
  const mechanic = await createTestUser({ role: "MECHANIC" });
  const res = await request(app)
    .post("/depots")
    .set("Authorization", bearerFor(mechanic.id, mechanic.role))
    .send({ code: "LAX", name: "LA" });

  assert.equal(res.status, 403);
});

test("GET /depots returns a pagination envelope", async () => {
  const auth = await adminAuth();
  for (const code of ["AAA", "BBB", "CCC"]) {
    await request(app).post("/depots").set("Authorization", auth).send({ code, name: code });
  }

  const res = await request(app).get("/depots?limit=2&offset=0").set("Authorization", auth);

  assert.equal(res.status, 200);
  assert.equal(res.body.data.length, 2);
  assert.deepEqual(res.body.pagination, { limit: 2, offset: 0, total: 3, has_more: true });
});

test("an unknown depot id returns 404", async () => {
  const auth = await adminAuth();
  const res = await request(app)
    .get("/depots/00000000-0000-0000-0000-000000000000")
    .set("Authorization", auth);

  assert.equal(res.status, 404);
});

test("PATCH updates a depot", async () => {
  const auth = await adminAuth();
  const created = await request(app)
    .post("/depots")
    .set("Authorization", auth)
    .send({ code: "LAX", name: "LA" });

  const res = await request(app)
    .patch(`/depots/${created.body.id}`)
    .set("Authorization", auth)
    .send({ name: "Los Angeles", is_disabled: true });

  assert.equal(res.status, 200);
  assert.equal(res.body.name, "Los Angeles");
  assert.equal(res.body.is_disabled, true);
});

test("assigning a user to a depot moves them off their previous depot", async () => {
  const auth = await adminAuth();
  const mechanic = await createTestUser({ role: "MECHANIC", name: "Dana" });

  const lax = await request(app).post("/depots").set("Authorization", auth).send({ code: "LAX", name: "LA" });
  const sea = await request(app).post("/depots").set("Authorization", auth).send({ code: "SEA", name: "Seattle" });

  const first = await request(app)
    .post(`/depots/${lax.body.id}/members`)
    .set("Authorization", auth)
    .send({ user_id: mechanic.id });
  assert.equal(first.status, 201);

  await request(app)
    .post(`/depots/${sea.body.id}/members`)
    .set("Authorization", auth)
    .send({ user_id: mechanic.id });

  const laxMembers = await request(app)
    .get(`/depots/${lax.body.id}/members`)
    .set("Authorization", auth);
  assert.equal(laxMembers.body.length, 0);

  const seaMembers = await request(app)
    .get(`/depots/${sea.body.id}/members`)
    .set("Authorization", auth);
  assert.equal(seaMembers.body.length, 1);
  assert.equal(seaMembers.body[0].name, "Dana");
});

test("GET /me/depot returns the caller's active depot", async () => {
  const auth = await adminAuth();
  const mechanic = await createTestUser({ role: "MECHANIC" });
  const lax = await request(app).post("/depots").set("Authorization", auth).send({ code: "LAX", name: "LA" });

  await request(app)
    .post(`/depots/${lax.body.id}/members`)
    .set("Authorization", auth)
    .send({ user_id: mechanic.id });

  const res = await request(app)
    .get("/me/depot")
    .set("Authorization", bearerFor(mechanic.id, mechanic.role));

  assert.equal(res.status, 200);
  assert.equal(res.body.code, "LAX");
});

test("GET /me/depot returns null for an unassigned user", async () => {
  const mechanic = await createTestUser({ role: "MECHANIC" });
  const res = await request(app)
    .get("/me/depot")
    .set("Authorization", bearerFor(mechanic.id, mechanic.role));

  assert.equal(res.status, 200);
  assert.equal(res.body, null);
});

test("removing a member leaves them with no active depot", async () => {
  const auth = await adminAuth();
  const mechanic = await createTestUser({ role: "MECHANIC" });
  const lax = await request(app).post("/depots").set("Authorization", auth).send({ code: "LAX", name: "LA" });

  await request(app)
    .post(`/depots/${lax.body.id}/members`)
    .set("Authorization", auth)
    .send({ user_id: mechanic.id });

  const removed = await request(app)
    .delete(`/depots/${lax.body.id}/members/${mechanic.id}`)
    .set("Authorization", auth);
  assert.equal(removed.status, 204);

  const me = await request(app)
    .get("/me/depot")
    .set("Authorization", bearerFor(mechanic.id, mechanic.role));
  assert.equal(me.body, null);
});

test("removing a user who is not a member returns 404", async () => {
  const auth = await adminAuth();
  const mechanic = await createTestUser({ role: "MECHANIC" });
  const lax = await request(app).post("/depots").set("Authorization", auth).send({ code: "LAX", name: "LA" });

  const res = await request(app)
    .delete(`/depots/${lax.body.id}/members/${mechanic.id}`)
    .set("Authorization", auth);

  assert.equal(res.status, 404);
});

test("a malformed depot id in the path is a 400, not a 500", async () => {
  const auth = await adminAuth();
  const res = await request(app).get("/depots/not-a-uuid").set("Authorization", auth);
  assert.equal(res.status, 400);
});

test("a malformed user_id when assigning a member is a 400, not a 500", async () => {
  const auth = await adminAuth();
  const lax = await request(app).post("/depots").set("Authorization", auth).send({ code: "LAX", name: "LA" });

  const res = await request(app)
    .post(`/depots/${lax.body.id}/members`)
    .set("Authorization", auth)
    .send({ user_id: "abc" });

  assert.equal(res.status, 400);
});

// Carry-over 7: the spec's access matrix grants this read to any member, but
// Phase 1 shipped it admin-only, which left requireDepotAccess with no
// production caller at all.
test("a depot member can read their own depot but not another", async () => {
  const admin = await adminAuth();
  const lax = await request(app)
    .post("/depots")
    .set("Authorization", admin)
    .send({ code: "LAX", name: "Los Angeles" });
  const sea = await request(app)
    .post("/depots")
    .set("Authorization", admin)
    .send({ code: "SEA", name: "Seattle" });

  const member = await createTestUser({ role: "MECHANIC" });
  await request(app)
    .post(`/depots/${lax.body.id}/members`)
    .set("Authorization", admin)
    .send({ user_id: member.id });
  const auth = bearerFor(member.id, member.role);

  const own = await request(app).get(`/depots/${lax.body.id}`).set("Authorization", auth);
  assert.equal(own.status, 200);
  assert.equal(own.body.code, "LAX");

  const other = await request(app).get(`/depots/${sea.body.id}`).set("Authorization", auth);
  assert.equal(other.status, 403);
  assert.equal(other.body.code, "DEPOT_FORBIDDEN");
});

test("a user with no depot membership cannot read any depot", async () => {
  const admin = await adminAuth();
  const lax = await request(app)
    .post("/depots")
    .set("Authorization", admin)
    .send({ code: "LAX", name: "Los Angeles" });

  const stranger = await createTestUser({ role: "MECHANIC" });
  const res = await request(app)
    .get(`/depots/${lax.body.id}`)
    .set("Authorization", bearerFor(stranger.id, stranger.role));

  assert.equal(res.status, 403);
});

// The hand-rolled `input.name?.trim()` these replace turned any non-string
// body value into a TypeError and a 500.
test("a non-string depot name is a 400, not a 500", async () => {
  const auth = await adminAuth();
  const res = await request(app)
    .post("/depots")
    .set("Authorization", auth)
    .send({ code: "LAX", name: { first: "Los Angeles" } });

  assert.equal(res.status, 400);
  assert.equal(res.body.code, "VALIDATION_ERROR");
});

test("a missing depot code names the field in violations", async () => {
  const auth = await adminAuth();
  const res = await request(app).post("/depots").set("Authorization", auth).send({ name: "LA" });

  assert.equal(res.status, 400);
  assert.ok(res.body.violations.some((v: string) => v.startsWith("code:")));
});

test("a blank depot name is rejected rather than stored as an empty string", async () => {
  const auth = await adminAuth();
  const res = await request(app)
    .post("/depots")
    .set("Authorization", auth)
    .send({ code: "LAX", name: "   " });

  assert.equal(res.status, 400);
});

test("an unknown field in a depot body is rejected", async () => {
  const auth = await adminAuth();
  const res = await request(app)
    .post("/depots")
    .set("Authorization", auth)
    .send({ code: "LAX", name: "LA", timezon: "UTC" });

  assert.equal(res.status, 400, "a misspelled field must not be silently dropped");
});

test("a non-boolean is_disabled on PATCH is a 400", async () => {
  const auth = await adminAuth();
  const created = await request(app)
    .post("/depots")
    .set("Authorization", auth)
    .send({ code: "LAX", name: "LA" });

  const res = await request(app)
    .patch(`/depots/${created.body.id}`)
    .set("Authorization", auth)
    .send({ is_disabled: "yes" });

  assert.equal(res.status, 400);
});

test("GET /depots hides disabled depots unless asked", async () => {
  const auth = await adminAuth();
  const open = await request(app)
    .post("/depots")
    .set("Authorization", auth)
    .send({ code: "LAX", name: "Los Angeles" });
  const closed = await request(app)
    .post("/depots")
    .set("Authorization", auth)
    .send({ code: "SEA", name: "Seattle" });
  await request(app)
    .patch(`/depots/${closed.body.id}`)
    .set("Authorization", auth)
    .send({ is_disabled: true });

  const listed = await request(app).get("/depots").set("Authorization", auth);
  assert.equal(listed.body.pagination.total, 1);
  assert.equal(listed.body.data[0].id, open.body.id);

  const all = await request(app)
    .get("/depots?include_disabled=true")
    .set("Authorization", auth);
  assert.equal(all.body.pagination.total, 2, "an admin must be able to find it to re-enable it");
});

test("a disabled depot is still readable by id", async () => {
  const auth = await adminAuth();
  const created = await request(app)
    .post("/depots")
    .set("Authorization", auth)
    .send({ code: "LAX", name: "Los Angeles" });
  await request(app)
    .patch(`/depots/${created.body.id}`)
    .set("Authorization", auth)
    .send({ is_disabled: true });

  const res = await request(app).get(`/depots/${created.body.id}`).set("Authorization", auth);
  assert.equal(res.status, 200);
  assert.equal(res.body.is_disabled, true);
});

test("a disabled depot refuses new job cards", async () => {
  const auth = await adminAuth();
  const created = await request(app)
    .post("/depots")
    .set("Authorization", auth)
    .send({ code: "LAX", name: "Los Angeles" });
  await request(app)
    .patch(`/depots/${created.body.id}`)
    .set("Authorization", auth)
    .send({ is_disabled: true });

  const equipmentTypeId = await seedEquipmentType();
  const res = await request(app)
    .post(`/depots/${created.body.id}/job-cards`)
    .set("Authorization", auth)
    .send({ direction: "INBOUND", equipment_type_id: equipmentTypeId, chassis_number: "CHS-1" });

  assert.equal(res.status, 403);
  assert.equal(res.body.code, "DEPOT_DISABLED");
});

test("re-enabling a depot restores writes", async () => {
  const auth = await adminAuth();
  const created = await request(app)
    .post("/depots")
    .set("Authorization", auth)
    .send({ code: "LAX", name: "Los Angeles" });
  const equipmentTypeId = await seedEquipmentType();

  await request(app)
    .patch(`/depots/${created.body.id}`)
    .set("Authorization", auth)
    .send({ is_disabled: true });
  await request(app)
    .patch(`/depots/${created.body.id}`)
    .set("Authorization", auth)
    .send({ is_disabled: false });

  const res = await request(app)
    .post(`/depots/${created.body.id}/job-cards`)
    .set("Authorization", auth)
    .send({ direction: "INBOUND", equipment_type_id: equipmentTypeId, chassis_number: "CHS-1" });

  assert.equal(res.status, 201, "disabling must be reversible without a data fix");
});
