import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import request from "supertest";
import { app } from "../src/app";
import { pool } from "../src/db/pool";
import { closeDb, resetDb } from "./helpers/db";
import { bearerFor, createTestUser } from "./helpers/auth";
import {
  addDepotMember,
  seedDamageCode,
  seedDepot,
  seedEquipmentType,
  seedJobCard,
} from "./helpers/fixtures";
import { Role } from "../src/types";

beforeEach(async () => {
  await resetDb();
});

after(async () => {
  await closeDb();
});

const MISSING = "00000000-0000-0000-0000-000000000000";

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

const create = (jobCardId: string, auth: string, body: unknown) =>
  request(app).post(`/job-cards/${jobCardId}/items`).set("Authorization", auth).send(body as object);

const list = (jobCardId: string, auth: string) =>
  request(app).get(`/job-cards/${jobCardId}/items`).set("Authorization", auth);

test("posting a single object answers with a single object", async () => {
  const { jobCardId, auth } = await scenario();

  const res = await create(jobCardId, auth, { notes: "dent, driver side" });

  assert.equal(res.status, 201);
  assert.equal(Array.isArray(res.body), false, "the answer takes the shape of the request");
  assert.equal(res.body.notes, "dent, driver side");
  assert.equal(res.body.job_card_id, jobCardId);
});

test("posting an array answers with an array of the same length, in order", async () => {
  const { jobCardId, auth } = await scenario();

  const res = await create(jobCardId, auth, [{ notes: "a" }, { notes: "b" }]);

  assert.equal(res.status, 201);
  assert.deepEqual(
    res.body.map((i: { notes: string }) => i.notes),
    ["a", "b"],
  );
});

test("the list returns items in display order", async () => {
  const { jobCardId, auth } = await scenario();
  await create(jobCardId, auth, [
    { notes: "second", display_order: 1 },
    { notes: "first", display_order: 0 },
  ]);

  const res = await list(jobCardId, auth);

  assert.equal(res.status, 200);
  assert.deepEqual(
    res.body.map((i: { notes: string }) => i.notes),
    ["first", "second"],
  );
});

test("a single item is readable by its own id", async () => {
  const { jobCardId, auth } = await scenario();
  const created = await create(jobCardId, auth, { notes: "dent" });

  const res = await request(app)
    .get(`/job-cards/${jobCardId}/items/${created.body.id}`)
    .set("Authorization", auth);

  assert.equal(res.status, 200);
  assert.equal(res.body.id, created.body.id);
});

test("patching returns the updated item", async () => {
  const { jobCardId, auth } = await scenario();
  const created = await create(jobCardId, auth, { notes: "dent" });
  const damageId = await seedDamageCode();

  const res = await request(app)
    .patch(`/job-cards/${jobCardId}/items/${created.body.id}`)
    .set("Authorization", auth)
    .send({ notes: "deep dent", damage_code_ids: [damageId] });

  assert.equal(res.status, 200);
  assert.equal(res.body.notes, "deep dent");
  assert.deepEqual(res.body.damage_code_ids, [damageId]);
});

test("deleting answers 204 and the item stops being listed", async () => {
  const { jobCardId, auth } = await scenario();
  const created = await create(jobCardId, auth, { notes: "dent" });

  const res = await request(app)
    .delete(`/job-cards/${jobCardId}/items/${created.body.id}`)
    .set("Authorization", auth);

  assert.equal(res.status, 204);
  assert.deepEqual((await list(jobCardId, auth)).body, []);
});

test("every route refuses a request with no token", async () => {
  const { jobCardId } = await scenario();

  assert.equal((await request(app).get(`/job-cards/${jobCardId}/items`)).status, 401);
  assert.equal(
    (await request(app).post(`/job-cards/${jobCardId}/items`).send({ notes: "x" })).status,
    401,
  );
  assert.equal((await request(app).get(`/job-cards/${jobCardId}/items/${MISSING}`)).status, 401);
  assert.equal(
    (await request(app).patch(`/job-cards/${jobCardId}/items/${MISSING}`).send({ notes: "x" }))
      .status,
    401,
  );
  assert.equal((await request(app).delete(`/job-cards/${jobCardId}/items/${MISSING}`)).status, 401);
});

test("a member of another depot cannot write or read this depot's items", async () => {
  const { jobCardId, auth } = await scenario();
  await create(jobCardId, auth, { notes: "dent" });
  const { auth: outsider } = await memberAt(await seedDepot());

  const created = await create(jobCardId, outsider, { notes: "intruder" });
  assert.equal(created.status, 403);
  assert.equal(created.body.code, "DEPOT_FORBIDDEN");

  assert.equal((await list(jobCardId, outsider)).status, 403);
});

test("a locked card refuses writes but still serves its findings", async () => {
  const { jobCardId, auth } = await scenario();
  const created = await create(jobCardId, auth, { notes: "dent" });
  await pool.query("UPDATE job_cards SET locked_at = now(), status = 'SUBMITTED' WHERE id = $1", [
    jobCardId,
  ]);

  const blocked = await create(jobCardId, auth, { notes: "late" });
  assert.equal(blocked.status, 409);
  assert.equal(blocked.body.code, "JOB_CARD_LOCKED");

  const patched = await request(app)
    .patch(`/job-cards/${jobCardId}/items/${created.body.id}`)
    .set("Authorization", auth)
    .send({ notes: "late" });
  assert.equal(patched.status, 409);

  const removed = await request(app)
    .delete(`/job-cards/${jobCardId}/items/${created.body.id}`)
    .set("Authorization", auth);
  assert.equal(removed.status, 409);

  const read = await list(jobCardId, auth);
  assert.equal(read.status, 200, "a submitted card's findings stay readable");
  assert.equal(read.body.length, 1);
});

test("a disabled depot refuses writes and still serves reads", async () => {
  const { depotId, jobCardId, auth } = await scenario();
  await create(jobCardId, auth, { notes: "dent" });
  await pool.query("UPDATE depots SET is_disabled = true WHERE id = $1", [depotId]);

  const blocked = await create(jobCardId, auth, { notes: "late" });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.code, "DEPOT_DISABLED", "the depot rule reaches items for free");

  assert.equal((await list(jobCardId, auth)).status, 200, "a closed depot stays readable");
});

test("a malformed job card id is 400, and an unknown one is 404", async () => {
  const { auth } = await scenario();

  assert.equal(
    (await request(app).get("/job-cards/not-a-uuid/items").set("Authorization", auth)).status,
    400,
  );
  assert.equal((await list(MISSING, auth)).status, 404);
});

test("a malformed item id is 400, and an unknown one is 404", async () => {
  const { jobCardId, auth } = await scenario();

  assert.equal(
    (
      await request(app)
        .get(`/job-cards/${jobCardId}/items/not-a-uuid`)
        .set("Authorization", auth)
    ).status,
    400,
  );
  assert.equal(
    (await request(app).get(`/job-cards/${jobCardId}/items/${MISSING}`).set("Authorization", auth))
      .status,
    404,
  );
});

test("a malformed body is 400 with one violation per failing field", async () => {
  const { jobCardId, auth } = await scenario();

  const res = await create(jobCardId, auth, { notes: 42, display_order: -1 });

  assert.equal(res.status, 400);
  assert.equal(res.body.code, "VALIDATION_ERROR");
  assert.equal(res.body.violations.length, 2);
});

test("an unknown key is refused rather than silently dropped", async () => {
  const { jobCardId, auth } = await scenario();

  const res = await create(jobCardId, auth, { note: "typo" });

  assert.equal(res.status, 400);
});

test("an empty patch is 400 rather than a write that means nothing", async () => {
  const { jobCardId, auth } = await scenario();
  const created = await create(jobCardId, auth, { notes: "dent" });

  const res = await request(app)
    .patch(`/job-cards/${jobCardId}/items/${created.body.id}`)
    .set("Authorization", auth)
    .send({});

  assert.equal(res.status, 400);
});

test("a batch violation names the failing index", async () => {
  const { jobCardId, auth } = await scenario();

  const res = await create(jobCardId, auth, [{ notes: "fine" }, { display_order: -1 }]);

  assert.equal(res.status, 400);
  assert.ok(
    res.body.violations.some((v: string) => v.startsWith("1.display_order")),
    "a client resending fifty items needs to know which one failed, and why",
  );
  assert.deepEqual((await list(jobCardId, auth)).body, [], "all-or-nothing");
});

test("mounting the items router did not break the public endpoints", async () => {
  // inspectionItemsRouter is mounted at "/" like the others, so a router-wide
  // requireAuth would reject requests bound for routers mounted after it.
  assert.equal((await request(app).get("/health")).status, 200);
  assert.equal((await request(app).get("/app-config")).status, 200);
});
