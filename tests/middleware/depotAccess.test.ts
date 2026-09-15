import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import express from "express";
import request from "supertest";
import { pool } from "../../src/db/pool";
import { errorHandler } from "../../src/middleware/errors";
import { requireAuth } from "../../src/middleware/auth";
import {
  requireDepotAccess,
  requireUnlockedJobCard,
} from "../../src/middleware/depotAccess";
import { closeDb, resetDb } from "../helpers/db";
import { bearerFor, createTestUser } from "../helpers/auth";
import { generateJobNumber } from "../../src/utils/jobNumber";

// A minimal app exercising both middlewares on the two path shapes they must
// support: a depot in the path, and a job card in the path.
const testApp = express();
testApp.use(express.json());
testApp.get("/depots/:depotId/probe", requireAuth, requireDepotAccess, (req, res) => {
  res.json({ depot_code: req.depot!.code });
});
testApp.patch(
  "/job-cards/:jobCardId/probe",
  requireAuth,
  requireDepotAccess,
  requireUnlockedJobCard,
  (req, res) => {
    res.json({ status: req.jobCardAccess!.status });
  },
);
// Both params present: the shape Phase 2 introduces (a job card nested under
// its depot in the path).
testApp.get(
  "/depots/:depotId/job-cards/:jobCardId/probe",
  requireAuth,
  requireDepotAccess,
  (req, res) => {
    res.json({ status: req.jobCardAccess!.status });
  },
);
// requireUnlockedJobCard standing alone, with no requireDepotAccess ahead of
// it to have populated req.jobCardAccess. It must then load the row itself.
testApp.patch(
  "/unscoped/:jobCardId/probe",
  requireAuth,
  requireUnlockedJobCard,
  (req, res) => {
    res.json({ status: req.jobCardAccess!.status });
  },
);
testApp.use(errorHandler);

beforeEach(async () => {
  await resetDb();
});

after(async () => {
  await closeDb();
});

async function seed(): Promise<{
  depotId: string;
  otherDepotId: string;
  equipmentTypeId: string;
}> {
  const depot = await pool.query<{ id: string }>(
    `INSERT INTO depots (slug_id, code, name) VALUES ('AAAAAAAA', 'LAX', 'LA') RETURNING id`,
  );
  const other = await pool.query<{ id: string }>(
    `INSERT INTO depots (slug_id, code, name) VALUES ('BBBBBBBB', 'SEA', 'Seattle') RETURNING id`,
  );
  const category = await pool.query<{ id: string }>(
    `INSERT INTO equipment_categories (name, slug_id)
     VALUES ('Chassis-' || generate_slug_id(8), generate_slug_id(8)) RETURNING id`,
  );
  const type = await pool.query<{ id: string }>(
    `INSERT INTO equipment_types (equipment_category_id, name, slug_id)
     VALUES ($1, 'Std-' || generate_slug_id(8), generate_slug_id(8)) RETURNING id`,
    [category.rows[0].id],
  );
  return {
    depotId: depot.rows[0].id,
    otherDepotId: other.rows[0].id,
    equipmentTypeId: type.rows[0].id,
  };
}

async function assign(userId: string, depotId: string): Promise<void> {
  await pool.query(`INSERT INTO depot_members (depot_id, user_id) VALUES ($1, $2)`, [
    depotId,
    userId,
  ]);
}

async function makeJobCard(
  depotId: string,
  equipmentTypeId: string,
  locked: boolean,
): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO job_cards
       (job_number, depot_id, direction, equipment_type_id, chassis_number,
        status, locked_at)
     VALUES ($1, $2, 'INBOUND', $3, 'CHS1', $4, $5)
     RETURNING id`,
    [
      // Not Math.random().toString(36).slice(2, 10): that yields fewer than 8
      // characters whenever the draw is short, which migration 009's
      // job_number_format CHECK now rejects.
      await generateJobNumber(),
      depotId,
      equipmentTypeId,
      locked ? "SUBMITTED" : "DRAFT",
      locked ? new Date() : null,
    ],
  );
  return rows[0].id;
}

test("a member reaches their own depot", async () => {
  const { depotId } = await seed();
  const user = await createTestUser({ role: "MECHANIC" });
  await assign(user.id, depotId);

  const res = await request(testApp)
    .get(`/depots/${depotId}/probe`)
    .set("Authorization", bearerFor(user.id, user.role));

  assert.equal(res.status, 200);
  assert.equal(res.body.depot_code, "LAX");
});

test("a member is refused another depot with 403", async () => {
  const { depotId, otherDepotId } = await seed();
  const user = await createTestUser({ role: "MECHANIC" });
  await assign(user.id, depotId);

  const res = await request(testApp)
    .get(`/depots/${otherDepotId}/probe`)
    .set("Authorization", bearerFor(user.id, user.role));

  assert.equal(res.status, 403);
  assert.equal(res.body.code, "DEPOT_FORBIDDEN");
});

test("a user with no depot is refused with 403", async () => {
  const { depotId } = await seed();
  const user = await createTestUser({ role: "MECHANIC" });

  const res = await request(testApp)
    .get(`/depots/${depotId}/probe`)
    .set("Authorization", bearerFor(user.id, user.role));

  assert.equal(res.status, 403);
});

test("an admin reaches any depot without a membership", async () => {
  const { otherDepotId } = await seed();
  const admin = await createTestUser({ role: "ADMIN" });

  const res = await request(testApp)
    .get(`/depots/${otherDepotId}/probe`)
    .set("Authorization", bearerFor(admin.id, admin.role));

  assert.equal(res.status, 200);
  assert.equal(res.body.depot_code, "SEA");
});

test("a malformed depot id is a 400, not a 500", async () => {
  const user = await createTestUser({ role: "ADMIN" });
  const res = await request(testApp)
    .get("/depots/not-a-uuid/probe")
    .set("Authorization", bearerFor(user.id, user.role));

  assert.equal(res.status, 400);
});

test("an unknown depot id is a 404", async () => {
  const user = await createTestUser({ role: "ADMIN" });
  const res = await request(testApp)
    .get("/depots/00000000-0000-0000-0000-000000000000/probe")
    .set("Authorization", bearerFor(user.id, user.role));

  assert.equal(res.status, 404);
});

test("a job card in the caller's depot is writable while unlocked", async () => {
  const { depotId, equipmentTypeId } = await seed();
  const user = await createTestUser({ role: "MECHANIC" });
  await assign(user.id, depotId);
  const cardId = await makeJobCard(depotId, equipmentTypeId, false);

  const res = await request(testApp)
    .patch(`/job-cards/${cardId}/probe`)
    .set("Authorization", bearerFor(user.id, user.role));

  assert.equal(res.status, 200);
  assert.equal(res.body.status, "DRAFT");
});

test("a locked job card rejects writes with 409", async () => {
  const { depotId, equipmentTypeId } = await seed();
  const user = await createTestUser({ role: "MECHANIC" });
  await assign(user.id, depotId);
  const cardId = await makeJobCard(depotId, equipmentTypeId, true);

  const res = await request(testApp)
    .patch(`/job-cards/${cardId}/probe`)
    .set("Authorization", bearerFor(user.id, user.role));

  assert.equal(res.status, 409);
  assert.equal(res.body.code, "JOB_CARD_LOCKED");
});

test("a job card in another depot is refused with 403", async () => {
  const { depotId, otherDepotId, equipmentTypeId } = await seed();
  const user = await createTestUser({ role: "MECHANIC" });
  await assign(user.id, depotId);
  const cardId = await makeJobCard(otherDepotId, equipmentTypeId, false);

  const res = await request(testApp)
    .patch(`/job-cards/${cardId}/probe`)
    .set("Authorization", bearerFor(user.id, user.role));

  assert.equal(res.status, 403);
});

test("an unknown job card is a 404", async () => {
  const user = await createTestUser({ role: "ADMIN" });
  const res = await request(testApp)
    .patch("/job-cards/00000000-0000-0000-0000-000000000000/probe")
    .set("Authorization", bearerFor(user.id, user.role));

  assert.equal(res.status, 404);
});

test("a job card nested under its own depot in the path is reachable", async () => {
  const { depotId, equipmentTypeId } = await seed();
  const user = await createTestUser({ role: "ADMIN" });
  const cardId = await makeJobCard(depotId, equipmentTypeId, false);

  const res = await request(testApp)
    .get(`/depots/${depotId}/job-cards/${cardId}/probe`)
    .set("Authorization", bearerFor(user.id, user.role));

  assert.equal(res.status, 200);
  assert.equal(res.body.status, "DRAFT");
});

test("a job card nested under a different depot in the path is a 404", async () => {
  const { depotId, otherDepotId, equipmentTypeId } = await seed();
  const user = await createTestUser({ role: "ADMIN" });
  // The card actually lives in otherDepotId; the path claims depotId.
  const cardId = await makeJobCard(otherDepotId, equipmentTypeId, false);

  const res = await request(testApp)
    .get(`/depots/${depotId}/job-cards/${cardId}/probe`)
    .set("Authorization", bearerFor(user.id, user.role));

  assert.equal(res.status, 404);
});

test("every cross-depot role is checked against CROSS_DEPOT_ROLES", async () => {
  const { otherDepotId } = await seed();

  const admin = await createTestUser({ role: "ADMIN" });
  const adminRes = await request(testApp)
    .get(`/depots/${otherDepotId}/probe`)
    .set("Authorization", bearerFor(admin.id, admin.role));
  assert.equal(adminRes.status, 200);

  const superuser = await createTestUser({ role: "SUPERUSER" });
  const superuserRes = await request(testApp)
    .get(`/depots/${otherDepotId}/probe`)
    .set("Authorization", bearerFor(superuser.id, superuser.role));
  assert.equal(superuserRes.status, 200);

  const mechanic = await createTestUser({ role: "MECHANIC" });
  const mechanicRes = await request(testApp)
    .get(`/depots/${otherDepotId}/probe`)
    .set("Authorization", bearerFor(mechanic.id, mechanic.role));
  assert.equal(mechanicRes.status, 403);

  const estimator = await createTestUser({ role: "ESTIMATOR" });
  const estimatorRes = await request(testApp)
    .get(`/depots/${otherDepotId}/probe`)
    .set("Authorization", bearerFor(estimator.id, estimator.role));
  assert.equal(estimatorRes.status, 403);
});

// Carry-over 6: until Phase 2 these paths were verified only by reading the
// code, because every route chained requireUnlockedJobCard after
// requireDepotAccess and so never exercised its own row load.

test("requireUnlockedJobCard standing alone loads the card and admits an unlocked one", async () => {
  const { depotId, equipmentTypeId } = await seed();
  const user = await createTestUser({ role: "MECHANIC" });
  await assign(user.id, depotId);
  const cardId = await makeJobCard(depotId, equipmentTypeId, false);

  const res = await request(testApp)
    .patch(`/unscoped/${cardId}/probe`)
    .set("Authorization", bearerFor(user.id, user.role));

  assert.equal(res.status, 200);
  assert.equal(res.body.status, "DRAFT", "it populated req.jobCardAccess by itself");
});

test("requireUnlockedJobCard standing alone refuses a locked card", async () => {
  const { depotId, equipmentTypeId } = await seed();
  const user = await createTestUser({ role: "MECHANIC" });
  await assign(user.id, depotId);
  const cardId = await makeJobCard(depotId, equipmentTypeId, true);

  const res = await request(testApp)
    .patch(`/unscoped/${cardId}/probe`)
    .set("Authorization", bearerFor(user.id, user.role));

  assert.equal(res.status, 409);
  assert.equal(res.body.code, "JOB_CARD_LOCKED");
});

test("requireUnlockedJobCard standing alone 404s on an unknown card", async () => {
  const user = await createTestUser({ role: "MECHANIC" });

  const res = await request(testApp)
    .patch("/unscoped/00000000-0000-0000-0000-000000000000/probe")
    .set("Authorization", bearerFor(user.id, user.role));

  assert.equal(res.status, 404);
});

test("requireUnlockedJobCard standing alone rejects a malformed id with 400", async () => {
  const user = await createTestUser({ role: "MECHANIC" });

  const res = await request(testApp)
    .patch("/unscoped/not-a-uuid/probe")
    .set("Authorization", bearerFor(user.id, user.role));

  assert.equal(res.status, 400);
});

async function disable(depotId: string): Promise<void> {
  await pool.query(`UPDATE depots SET is_disabled = true WHERE id = $1`, [depotId]);
}

test("a disabled depot still serves reads", async () => {
  const { depotId } = await seed();
  const user = await createTestUser({ role: "MECHANIC" });
  await assign(user.id, depotId);
  await disable(depotId);

  const res = await request(testApp)
    .get(`/depots/${depotId}/probe`)
    .set("Authorization", bearerFor(user.id, user.role));

  assert.equal(res.status, 200, "history stays readable after a depot closes");
});

test("a disabled depot refuses writes with 403 DEPOT_DISABLED", async () => {
  const { depotId, equipmentTypeId } = await seed();
  const user = await createTestUser({ role: "MECHANIC" });
  await assign(user.id, depotId);
  const cardId = await makeJobCard(depotId, equipmentTypeId, false);
  await disable(depotId);

  const res = await request(testApp)
    .patch(`/job-cards/${cardId}/probe`)
    .set("Authorization", bearerFor(user.id, user.role));

  assert.equal(res.status, 403);
  assert.equal(res.body.code, "DEPOT_DISABLED");
});

test("an admin is refused writes at a disabled depot too", async () => {
  const { depotId, equipmentTypeId } = await seed();
  const admin = await createTestUser({ role: "ADMIN" });
  const cardId = await makeJobCard(depotId, equipmentTypeId, false);
  await disable(depotId);

  const res = await request(testApp)
    .patch(`/job-cards/${cardId}/probe`)
    .set("Authorization", bearerFor(admin.id, admin.role));

  assert.equal(
    res.status,
    403,
    "a closed depot is closed to everyone; re-enable it rather than working around it",
  );
  assert.equal(res.body.code, "DEPOT_DISABLED");
});

test("a caller outside a disabled depot learns DEPOT_FORBIDDEN, not that it is disabled", async () => {
  const { depotId, otherDepotId } = await seed();
  const user = await createTestUser({ role: "MECHANIC" });
  await assign(user.id, depotId);
  await disable(otherDepotId);

  const res = await request(testApp)
    .get(`/depots/${otherDepotId}/probe`)
    .set("Authorization", bearerFor(user.id, user.role));

  assert.equal(res.status, 403);
  assert.equal(res.body.code, "DEPOT_FORBIDDEN", "membership is judged before depot state");
});
