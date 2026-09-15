import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import * as service from "../src/services/jobCards.service";
import { AppError } from "../src/middleware/errors";
import { findJobCardById } from "../src/db/jobCards.repo";
import { pool } from "../src/db/pool";
import { closeDb, resetDb } from "./helpers/db";
import { createTestUser } from "./helpers/auth";
import { seedDepot, seedEquipmentType } from "./helpers/fixtures";

beforeEach(async () => {
  await resetDb();
});

after(async () => {
  await closeDb();
});

async function context() {
  const depotId = await seedDepot();
  const equipmentTypeId = await seedEquipmentType();
  const actor = await createTestUser({ role: "MECHANIC" });
  return { depotId, equipmentTypeId, actorId: actor.id };
}

const minimal = (equipmentTypeId: string) =>
  ({
    direction: "INBOUND",
    equipment_type_id: equipmentTypeId,
    chassis_number: "CHS-9",
  }) as const;

test("create assigns a VIR job number, DRAFT status, and the actor", async () => {
  const { depotId, equipmentTypeId, actorId } = await context();

  const { card, created } = await service.createJobCard(
    depotId,
    minimal(equipmentTypeId),
    actorId,
  );

  assert.equal(created, true);
  assert.match(card.job_number, /^VIR-[0-9A-Z]{8}$/);
  assert.equal(card.status, "DRAFT");
  assert.equal(card.depot_id, depotId);
  assert.equal(card.created_by, actorId);
  assert.equal(card.can_edit, true, "an unlocked card is editable");
});

test("a repeated client_uuid returns the existing card rather than a duplicate", async () => {
  const { depotId, equipmentTypeId, actorId } = await context();
  const body = {
    ...minimal(equipmentTypeId),
    client_uuid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  };

  const first = await service.createJobCard(depotId, body, actorId);
  const second = await service.createJobCard(depotId, body, actorId);

  assert.equal(first.created, true);
  assert.equal(second.created, false, "the replay did not create a card");
  assert.equal(second.card.id, first.card.id);
  assert.equal(second.card.job_number, first.card.job_number);
});

test("concurrent replays of one client_uuid still yield a single card", async () => {
  const { depotId, equipmentTypeId, actorId } = await context();
  const body = {
    ...minimal(equipmentTypeId),
    client_uuid: "bbbbbbbb-cccc-dddd-eeee-ffffffffffff",
  };

  // Both calls run before either commits, so the read-first fast path misses
  // and the partial unique index is what actually enforces idempotency.
  const results = await Promise.all([
    service.createJobCard(depotId, body, actorId),
    service.createJobCard(depotId, body, actorId),
  ]);

  assert.equal(results[0].card.id, results[1].card.id);
  assert.equal(
    results.filter((r) => r.created).length,
    1,
    "exactly one of the two racing calls reports a creation",
  );
});

test("the same client_uuid at a different depot creates its own card", async () => {
  const { equipmentTypeId, actorId } = await context();
  const depotA = await seedDepot();
  const depotB = await seedDepot();
  const body = {
    ...minimal(equipmentTypeId),
    client_uuid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
  };

  const a = await service.createJobCard(depotA, body, actorId);
  const b = await service.createJobCard(depotB, body, actorId);
  assert.notEqual(a.card.id, b.card.id);
});

test("an unknown equipment_type_id is a 400, not an unhandled 500", async () => {
  const { depotId, actorId } = await context();

  await assert.rejects(
    () =>
      service.createJobCard(
        depotId,
        {
          direction: "INBOUND",
          equipment_type_id: "00000000-0000-0000-0000-000000000000",
          chassis_number: "CHS-9",
        },
        actorId,
      ),
    (err: AppError) => err.status === 400 && err.code === "VALIDATION_ERROR",
  );
});

test("update writes present keys and clears explicit nulls", async () => {
  const { depotId, equipmentTypeId, actorId } = await context();
  const { card } = await service.createJobCard(
    depotId,
    { ...minimal(equipmentTypeId), container_number: "MSCU1234567", customer_name: "Maersk" },
    actorId,
  );

  const updated = await service.updateJobCardById(
    card.id,
    { container_number: null, customer_name: "Hapag" },
    actorId,
  );

  assert.equal(updated.container_number, null);
  assert.equal(updated.customer_name, "Hapag");
  assert.equal(updated.chassis_number, "CHS-9", "an absent key survives");
});

test("update refuses to clear the last identifier on the merged row", async () => {
  const { depotId, equipmentTypeId, actorId } = await context();
  const { card } = await service.createJobCard(depotId, minimal(equipmentTypeId), actorId);

  await assert.rejects(
    () => service.updateJobCardById(card.id, { chassis_number: null }, actorId),
    (err: AppError) =>
      err.status === 400 &&
      err.code === "VALIDATION_ERROR" &&
      /container_number or chassis_number/.test(err.details?.join(" ") ?? ""),
  );

  const unchanged = await findJobCardById(card.id);
  assert.equal(unchanged!.chassis_number, "CHS-9", "the rejected patch wrote nothing");
});

test("clearing one identifier while setting the other is allowed", async () => {
  const { depotId, equipmentTypeId, actorId } = await context();
  const { card } = await service.createJobCard(depotId, minimal(equipmentTypeId), actorId);

  const updated = await service.updateJobCardById(
    card.id,
    { chassis_number: null, container_number: "MSCU1234567" },
    actorId,
  );
  assert.equal(updated.chassis_number, null);
  assert.equal(updated.container_number, "MSCU1234567");
});

test("a stale If-Unmodified-Since is a 409 STALE_WRITE", async () => {
  const { depotId, equipmentTypeId, actorId } = await context();
  const { card } = await service.createJobCard(depotId, minimal(equipmentTypeId), actorId);

  const stale = new Date(Date.parse(card.updated_at) - 60_000).toUTCString();

  await assert.rejects(
    () => service.updateJobCardById(card.id, { customer_name: "x" }, actorId, stale),
    (err: AppError) => err.status === 409 && err.code === "STALE_WRITE",
  );
});

test("a current If-Unmodified-Since is accepted despite sub-second precision", async () => {
  const { depotId, equipmentTypeId, actorId } = await context();
  const { card } = await service.createJobCard(depotId, minimal(equipmentTypeId), actorId);

  // An HTTP-date carries one-second resolution while updated_at carries
  // microseconds, so a client echoing back what it just read is always
  // fractionally behind. Comparing raw instants would reject every honest save.
  const echoed = new Date(card.updated_at).toUTCString();
  const updated = await service.updateJobCardById(
    card.id,
    { customer_name: "ok" },
    actorId,
    echoed,
  );
  assert.equal(updated.customer_name, "ok");
});

test("an unparseable If-Unmodified-Since is a 400, not a silent bypass", async () => {
  const { depotId, equipmentTypeId, actorId } = await context();
  const { card } = await service.createJobCard(depotId, minimal(equipmentTypeId), actorId);

  await assert.rejects(
    () => service.updateJobCardById(card.id, { customer_name: "x" }, actorId, "not-a-date"),
    (err: AppError) => err.status === 400,
  );
});

test("get and update 404 on an unknown id", async () => {
  const { actorId } = await context();
  const missing = "00000000-0000-0000-0000-000000000000";

  await assert.rejects(
    () => service.getJobCardById(missing),
    (e: AppError) => e.status === 404,
  );
  await assert.rejects(
    () => service.updateJobCardById(missing, { customer_name: "x" }, actorId),
    (e: AppError) => e.status === 404,
  );
});

test("can_edit is false once a card is locked", async () => {
  const { depotId, equipmentTypeId, actorId } = await context();
  const { card } = await service.createJobCard(depotId, minimal(equipmentTypeId), actorId);

  // Phase 6 owns the submit transition; this only pins that the DTO reads
  // locked_at rather than reasoning about the status list.
  await pool.query("UPDATE job_cards SET locked_at = now(), status = 'SUBMITTED' WHERE id = $1", [
    card.id,
  ]);

  const read = await service.getJobCardById(card.id);
  assert.equal(read.can_edit, false);
});

test("the DTO serialises timestamps as ISO strings and dates as YYYY-MM-DD", async () => {
  const { depotId, equipmentTypeId, actorId } = await context();
  const { card } = await service.createJobCard(
    depotId,
    {
      ...minimal(equipmentTypeId),
      inspected_at: "2026-03-01T10:30:00Z",
      on_hire_date: "2026-03-01",
    },
    actorId,
  );

  assert.equal(card.inspected_at, "2026-03-01T10:30:00.000Z");
  assert.equal(card.on_hire_date, "2026-03-01", "a calendar date keeps no time and no zone");
  assert.match(card.created_at, /^\d{4}-\d{2}-\d{2}T.*Z$/);
});

test("the list envelope reports limit, offset, total and has_more", async () => {
  const { depotId, equipmentTypeId, actorId } = await context();
  for (let i = 0; i < 3; i += 1) {
    await service.createJobCard(
      depotId,
      { ...minimal(equipmentTypeId), chassis_number: `C${i}` },
      actorId,
    );
  }

  const page = await service.listJobCardsPage({ depotId, limit: 2, offset: 0 });
  assert.equal(page.data.length, 2);
  assert.deepEqual(page.pagination, { limit: 2, offset: 0, total: 3, has_more: true });

  const last = await service.listJobCardsPage({ depotId, limit: 2, offset: 2 });
  assert.equal(last.pagination.has_more, false);
});
