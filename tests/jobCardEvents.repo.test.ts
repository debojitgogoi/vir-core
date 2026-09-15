import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import * as repo from "../src/db/jobCardEvents.repo";
import { pool } from "../src/db/pool";
import { closeDb, resetDb } from "./helpers/db";
import { createTestUser } from "./helpers/auth";
import { seedDepot, seedEquipmentType, seedJobCard } from "./helpers/fixtures";

beforeEach(async () => {
  await resetDb();
});

after(async () => {
  await closeDb();
});

const MISSING = "00000000-0000-0000-0000-000000000000";

async function context() {
  const depotId = await seedDepot();
  const jobCardId = await seedJobCard(depotId, await seedEquipmentType());
  const user = await createTestUser({ role: "MECHANIC" });
  return { depotId, jobCardId, actorId: user.id };
}

test("an event inserts and reads back with its actor and note", async () => {
  const { jobCardId, actorId } = await context();

  const row = await repo.insertJobCardEvent({
    jobCardId,
    fromStatus: "DRAFT",
    toStatus: "IN_INSPECTION",
    actorUserId: actorId,
    note: "First inspection item recorded",
  });

  assert.equal(row.job_card_id, jobCardId);
  assert.equal(row.from_status, "DRAFT");
  assert.equal(row.to_status, "IN_INSPECTION");
  assert.equal(row.actor_user_id, actorId);
  assert.equal(row.note, "First inspection item recorded");
  assert.ok(row.created_at instanceof Date);
});

test("from_status may be null, but to_status may not", async () => {
  const { jobCardId } = await context();

  const row = await repo.insertJobCardEvent({
    jobCardId,
    fromStatus: null,
    toStatus: "DRAFT",
    actorUserId: null,
    note: null,
  });
  assert.equal(row.from_status, null, "a card's own creation has no prior status");

  await assert.rejects(
    () =>
      pool.query(
        "INSERT INTO job_card_events (job_card_id, to_status) VALUES ($1, NULL)",
        [jobCardId],
      ),
    "an event that does not say where the card went records nothing",
  );
});

test("events list oldest first, because an audit trail is read forward", async () => {
  const { jobCardId, actorId } = await context();

  await repo.insertJobCardEvent({
    jobCardId,
    fromStatus: "DRAFT",
    toStatus: "IN_INSPECTION",
    actorUserId: actorId,
    note: "first",
  });
  await repo.insertJobCardEvent({
    jobCardId,
    fromStatus: "IN_INSPECTION",
    toStatus: "SUBMITTED",
    actorUserId: actorId,
    note: "second",
  });

  assert.deepEqual(
    (await repo.listJobCardEvents(jobCardId)).map((e) => e.note),
    ["first", "second"],
  );
});

test("two events sharing one timestamp still list in a stable order", async () => {
  const { jobCardId, actorId } = await context();
  const at = new Date("2026-09-01T10:00:00Z");

  for (const note of ["a", "b", "c"]) {
    await pool.query(
      `INSERT INTO job_card_events (job_card_id, from_status, to_status, actor_user_id, note, created_at)
       VALUES ($1, 'DRAFT', 'IN_INSPECTION', $2, $3, $4)`,
      [jobCardId, actorId, note, at],
    );
  }

  const once = (await repo.listJobCardEvents(jobCardId)).map((e) => e.id);
  const twice = (await repo.listJobCardEvents(jobCardId)).map((e) => e.id);
  assert.deepEqual(once, twice, "rows written in one transaction share now()");
});

test("an unknown card lists no events rather than failing", async () => {
  await context();
  assert.deepEqual(await repo.listJobCardEvents(MISSING), []);
});

test("only this card's events come back", async () => {
  const { depotId, jobCardId, actorId } = await context();
  const otherCardId = await seedJobCard(depotId, await seedEquipmentType());

  await repo.insertJobCardEvent({
    jobCardId,
    fromStatus: null,
    toStatus: "DRAFT",
    actorUserId: actorId,
    note: "mine",
  });
  await repo.insertJobCardEvent({
    jobCardId: otherCardId,
    fromStatus: null,
    toStatus: "DRAFT",
    actorUserId: actorId,
    note: "theirs",
  });

  assert.deepEqual(
    (await repo.listJobCardEvents(jobCardId)).map((e) => e.note),
    ["mine"],
  );
});

test("deleting the card takes its events with it", async () => {
  const { jobCardId, actorId } = await context();
  await repo.insertJobCardEvent({
    jobCardId,
    fromStatus: null,
    toStatus: "DRAFT",
    actorUserId: actorId,
    note: "x",
  });

  await pool.query("DELETE FROM job_cards WHERE id = $1", [jobCardId]);

  assert.deepEqual(await repo.listJobCardEvents(jobCardId), []);
});

test("an actor who is deleted leaves the event behind, with a null actor", async () => {
  const { jobCardId, actorId } = await context();
  await repo.insertJobCardEvent({
    jobCardId,
    fromStatus: null,
    toStatus: "DRAFT",
    actorUserId: actorId,
    note: "x",
  });

  await pool.query("DELETE FROM users WHERE id = $1", [actorId]);

  const [event] = await repo.listJobCardEvents(jobCardId);
  assert.equal(event.actor_user_id, null, "the transition still happened");
  assert.equal(event.note, "x");
});

test("an event written in a supplied transaction rolls back with it", async () => {
  const { jobCardId, actorId } = await context();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await repo.insertJobCardEvent(
      {
        jobCardId,
        fromStatus: "DRAFT",
        toStatus: "SUBMITTED",
        actorUserId: actorId,
        note: "doomed",
      },
      client,
    );
    await client.query("ROLLBACK");
  } finally {
    client.release();
  }

  assert.deepEqual(
    await repo.listJobCardEvents(jobCardId),
    [],
    "an audit trail that outlives the change it describes is worse than none",
  );
});

test("an event written in a supplied transaction survives a commit", async () => {
  const { jobCardId, actorId } = await context();
  const client = await pool.connect();

  try {
    await client.query("BEGIN");
    await repo.insertJobCardEvent(
      {
        jobCardId,
        fromStatus: "DRAFT",
        toStatus: "SUBMITTED",
        actorUserId: actorId,
        note: "kept",
      },
      client,
    );
    await client.query("COMMIT");
  } finally {
    client.release();
  }

  assert.equal((await repo.listJobCardEvents(jobCardId)).length, 1);
});
