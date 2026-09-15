import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import request from "supertest";
import { app } from "../src/app";
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

async function authFor(role: Role) {
  const user = await createTestUser({ role });
  return bearerFor(user.id, user.role);
}

/** Two depots, one card each, so a cross-depot read is observably different. */
async function twoDepots() {
  const first = await seedDepot();
  const second = await seedDepot();
  const equipmentTypeId = await seedEquipmentType();

  const a = await seedJobCard(first, equipmentTypeId, { chassis_number: "CHS-A" });
  const b = await seedJobCard(second, equipmentTypeId, { chassis_number: "CHS-B" });

  return { first, second, a, b };
}

const queue = (auth: string, query = "") =>
  request(app).get(`/job-cards${query}`).set("Authorization", auth);

test("an estimator reads every depot's cards from one list", async () => {
  await twoDepots();
  const auth = await authFor("ESTIMATOR");

  const res = await queue(auth);

  assert.equal(res.status, 200);
  assert.equal(res.body.data.length, 2, "the queue is the one cross-depot read");
});

test("a mechanic cannot read the queue", async () => {
  await twoDepots();
  const auth = await authFor("MECHANIC");

  const res = await queue(auth);

  assert.equal(res.status, 403, "a mechanic reads their own depot's list instead");
});

test("admins and superusers may read the queue", async () => {
  await twoDepots();

  assert.equal((await queue(await authFor("ADMIN"))).status, 200);
  assert.equal((await queue(await authFor("SUPERUSER"))).status, 200);
});

test("the queue needs a token", async () => {
  await twoDepots();
  assert.equal((await request(app).get("/job-cards")).status, 401);
});

test("depot_id narrows the queue to one depot", async () => {
  const { first } = await twoDepots();
  const auth = await authFor("ESTIMATOR");

  const res = await queue(auth, `?depot_id=${first}`);

  assert.equal(res.body.data.length, 1);
  assert.equal(res.body.data[0].chassis_number, "CHS-A");
});

test("status filters the queue", async () => {
  const { second } = await twoDepots();
  const auth = await authFor("ESTIMATOR");
  const equipmentTypeId = await seedEquipmentType();
  await seedJobCard(second, equipmentTypeId, {
    chassis_number: "CHS-C",
    status: "SUBMITTED",
  });

  const res = await queue(auth, "?status=SUBMITTED");

  assert.equal(res.body.data.length, 1);
  assert.equal(res.body.data[0].chassis_number, "CHS-C");
});

test("a malformed depot_id is 400 rather than an empty list", async () => {
  await twoDepots();
  const auth = await authFor("ESTIMATOR");

  const res = await queue(auth, "?depot_id=not-a-uuid");

  assert.equal(res.status, 400);
  assert.equal(res.body.code, "VALIDATION_ERROR");
});

test("the envelope matches the depot list exactly, so the two cannot drift", async () => {
  const { first } = await twoDepots();
  const estimator = await createTestUser({ role: "ESTIMATOR" });
  await addDepotMember(first, estimator.id);
  const auth = bearerFor(estimator.id, estimator.role);

  const queued = await queue(auth);
  const depotList = await request(app)
    .get(`/depots/${first}/job-cards`)
    .set("Authorization", auth);

  assert.deepEqual(Object.keys(queued.body).sort(), Object.keys(depotList.body).sort());
  assert.deepEqual(
    Object.keys(queued.body.pagination).sort(),
    Object.keys(depotList.body.pagination).sort(),
  );
});

test("inspected_from and inspected_to filter on inspected_at", async () => {
  const depotId = await seedDepot();
  const equipmentTypeId = await seedEquipmentType();
  await seedJobCard(depotId, equipmentTypeId, {
    chassis_number: "CHS-EARLY",
    inspected_at: new Date("2026-08-01T09:00:00Z"),
  });
  await seedJobCard(depotId, equipmentTypeId, {
    chassis_number: "CHS-LATE",
    inspected_at: new Date("2026-09-01T09:00:00Z"),
  });
  const auth = await authFor("ESTIMATOR");

  const res = await queue(auth, "?inspected_from=2026-08-20T00:00:00Z");

  assert.deepEqual(
    res.body.data.map((c: { chassis_number: string }) => c.chassis_number),
    ["CHS-LATE"],
  );
});

test("a never-inspected card is excluded by inspected_at but kept by created_at", async () => {
  const depotId = await seedDepot();
  const equipmentTypeId = await seedEquipmentType();
  await seedJobCard(depotId, equipmentTypeId, { chassis_number: "CHS-NEVER" });
  const auth = await authFor("ESTIMATOR");

  const byInspected = await queue(auth, "?inspected_from=2000-01-01T00:00:00Z");
  assert.deepEqual(
    byInspected.body.data,
    [],
    "asking what was inspected must not return what was never inspected",
  );

  const byCreated = await queue(auth, "?from=2000-01-01T00:00:00Z");
  assert.equal(
    byCreated.body.data.length,
    1,
    "which is exactly why the existing pair was not repointed at inspected_at",
  );
});

test("a reversed range is 400 on either pair", async () => {
  await twoDepots();
  const auth = await authFor("ESTIMATOR");

  assert.equal(
    (await queue(auth, "?from=2026-09-02T00:00:00Z&to=2026-09-01T00:00:00Z")).status,
    400,
  );
  assert.equal(
    (
      await queue(
        auth,
        "?inspected_from=2026-09-02T00:00:00Z&inspected_to=2026-09-01T00:00:00Z",
      )
    ).status,
    400,
  );
});

test("the depot list ignores a depot_id that disagrees with its path", async () => {
  const { first, second } = await twoDepots();
  const user = await createTestUser({ role: "MECHANIC" });
  await addDepotMember(first, user.id);
  const auth = bearerFor(user.id, user.role);

  const res = await request(app)
    .get(`/depots/${first}/job-cards?depot_id=${second}`)
    .set("Authorization", auth);

  assert.equal(res.status, 200);
  assert.deepEqual(
    res.body.data.map((c: { chassis_number: string }) => c.chassis_number),
    ["CHS-A"],
    "the path is what requireDepotAccess checked; a query parameter must not override it",
  );
});

test("mounting the queue route did not break the public endpoints", async () => {
  assert.equal((await request(app).get("/health")).status, 200);
  assert.equal((await request(app).get("/app-config")).status, 200);
});
