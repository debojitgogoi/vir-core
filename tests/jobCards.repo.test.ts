import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import * as repo from "../src/db/jobCards.repo";
import { closeDb, resetDb } from "./helpers/db";
import { createTestUser } from "./helpers/auth";
import { seedDepot, seedEquipmentType } from "./helpers/fixtures";
import { generateJobNumber } from "../src/utils/jobNumber";

beforeEach(async () => {
  await resetDb();
});

after(async () => {
  await closeDb();
});

async function insertCard(
  depotId: string,
  equipmentTypeId: string,
  overrides: Record<string, unknown> = {},
): Promise<repo.JobCardRow> {
  return repo.insertJobCard({
    jobNumber: await generateJobNumber(),
    depotId,
    clientUuid: null,
    createdBy: null,
    values: {
      direction: "INBOUND",
      equipment_type_id: equipmentTypeId,
      chassis_number: "CHS-100",
      ...overrides,
    },
  });
}

test("insert returns the full row with server-assigned defaults", async () => {
  const depotId = await seedDepot();
  const typeId = await seedEquipmentType();
  const user = await createTestUser({ role: "MECHANIC" });

  const row = await repo.insertJobCard({
    jobNumber: await generateJobNumber(),
    depotId,
    clientUuid: null,
    createdBy: user.id,
    values: {
      direction: "OUTBOUND",
      equipment_type_id: typeId,
      container_number: "MSCU1234567",
      genset_status: "UNDER_MOUNT",
      size: 40,
      manufacture_year: 2019,
    },
  });

  assert.equal(row.status, "DRAFT");
  assert.equal(row.locked_at, null);
  assert.equal(row.created_by, user.id);
  assert.equal(row.updated_by, user.id);
  assert.equal(row.size, 40);
  assert.equal(row.genset_status, "UNDER_MOUNT");
  assert.ok(row.created_at instanceof Date);
});

test("a DATE column round-trips as a plain YYYY-MM-DD string", async () => {
  const depotId = await seedDepot();
  const typeId = await seedEquipmentType();

  const row = await insertCard(depotId, typeId, { on_hire_date: "2026-03-01" });
  assert.equal(
    row.on_hire_date,
    "2026-03-01",
    "parsing a DATE into a Date object would shift the day across timezones",
  );
});

test("findJobCardByClientUuid is scoped to the depot", async () => {
  const depotA = await seedDepot();
  const depotB = await seedDepot();
  const typeId = await seedEquipmentType();
  const key = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";

  await repo.insertJobCard({
    jobNumber: await generateJobNumber(),
    depotId: depotA,
    clientUuid: key,
    createdBy: null,
    values: { direction: "INBOUND", equipment_type_id: typeId, chassis_number: "C1" },
  });

  assert.ok(await repo.findJobCardByClientUuid(depotA, key));
  assert.equal(
    await repo.findJobCardByClientUuid(depotB, key),
    null,
    "the same key at another depot is a different card",
  );
});

test("updateJobCard sets present keys, clears explicit nulls, and ignores absent ones", async () => {
  const depotId = await seedDepot();
  const typeId = await seedEquipmentType();
  const editor = await createTestUser({ role: "MECHANIC" });
  const card = await insertCard(depotId, typeId, {
    container_number: "MSCU1234567",
    customer_name: "Maersk",
    pool_point: "LAX-3",
  });

  const updated = await repo.updateJobCard(
    card.id,
    { customer_name: "Hapag", container_number: null },
    editor.id,
  );

  assert.equal(updated!.customer_name, "Hapag", "a present key is written");
  assert.equal(updated!.container_number, null, "an explicit null clears the column");
  assert.equal(updated!.pool_point, "LAX-3", "an absent key is untouched");
  assert.equal(updated!.updated_by, editor.id);
});

test("updateJobCard with an empty patch is a no-op that still returns the row", async () => {
  const depotId = await seedDepot();
  const typeId = await seedEquipmentType();
  const card = await insertCard(depotId, typeId);

  const updated = await repo.updateJobCard(card.id, {}, null);
  assert.equal(updated!.id, card.id);
  assert.deepEqual(
    updated!.updated_at,
    card.updated_at,
    "no write happened, so the updated_at trigger did not fire",
  );
});

test("updateJobCard ignores a key outside the column allowlist", async () => {
  const depotId = await seedDepot();
  const typeId = await seedEquipmentType();
  const card = await insertCard(depotId, typeId);

  const updated = await repo.updateJobCard(
    card.id,
    {
      status: "SUBMITTED",
      locked_at: new Date().toISOString(),
      job_number: "VIR-HACKHACK",
      customer_name: "OK",
    },
    null,
  );

  assert.equal(updated!.status, "DRAFT", "a server-owned column is not patchable");
  assert.equal(updated!.locked_at, null);
  assert.equal(updated!.job_number, card.job_number);
  assert.equal(updated!.customer_name, "OK", "the allowed key still applied");
});

test("updateJobCard returns null for an id that does not exist", async () => {
  const missing = await repo.updateJobCard(
    "00000000-0000-0000-0000-000000000000",
    { customer_name: "x" },
    null,
  );
  assert.equal(missing, null);
});

test("list filters by status and direction and reports the unpaged total", async () => {
  const depotId = await seedDepot();
  const typeId = await seedEquipmentType();
  await insertCard(depotId, typeId, { direction: "INBOUND" });
  await insertCard(depotId, typeId, { direction: "OUTBOUND" });
  await insertCard(depotId, typeId, { direction: "OUTBOUND" });

  const all = await repo.listJobCards({ depotId, limit: 25, offset: 0 });
  assert.equal(all.total, 3);

  const outbound = await repo.listJobCards({
    depotId,
    direction: "OUTBOUND",
    limit: 25,
    offset: 0,
  });
  assert.equal(outbound.total, 2);
  assert.equal(outbound.rows.length, 2);

  const drafts = await repo.listJobCards({ depotId, status: "DRAFT", limit: 25, offset: 0 });
  assert.equal(drafts.total, 3);
});

test("list is scoped to its depot", async () => {
  const depotA = await seedDepot();
  const depotB = await seedDepot();
  const typeId = await seedEquipmentType();
  await insertCard(depotA, typeId);
  await insertCard(depotB, typeId);

  const page = await repo.listJobCards({ depotId: depotA, limit: 25, offset: 0 });
  assert.equal(page.total, 1);
});

test("list paginates while reporting the full total", async () => {
  const depotId = await seedDepot();
  const typeId = await seedEquipmentType();
  for (let i = 0; i < 5; i += 1) await insertCard(depotId, typeId);

  const page = await repo.listJobCards({ depotId, limit: 2, offset: 2 });
  assert.equal(page.rows.length, 2);
  assert.equal(page.total, 5, "total counts every match, not the page");
});

test("list reports an accurate total for a page past the end of the results", async () => {
  const depotId = await seedDepot();
  const typeId = await seedEquipmentType();
  for (let i = 0; i < 3; i += 1) await insertCard(depotId, typeId);

  const page = await repo.listJobCards({ depotId, limit: 25, offset: 100 });
  assert.equal(page.rows.length, 0);
  assert.equal(
    page.total,
    3,
    "count(*) OVER () yields no row to read here, so the total comes from a fallback count",
  );
});

test("list rows do not leak the count(*) OVER () artifact", async () => {
  const depotId = await seedDepot();
  const typeId = await seedEquipmentType();
  await insertCard(depotId, typeId);

  const { rows } = await repo.listJobCards({ depotId, limit: 25, offset: 0 });
  assert.ok(
    !Object.prototype.hasOwnProperty.call(rows[0], "total_count"),
    "the windowed count is stripped before the row is returned",
  );
});

test("q matches job_number, container, chassis and customer, case-insensitively", async () => {
  const depotId = await seedDepot();
  const typeId = await seedEquipmentType();
  const target = await insertCard(depotId, typeId, {
    container_number: "MSCU1234567",
    customer_name: "Hapag Lloyd",
    chassis_number: null,
  });
  await insertCard(depotId, typeId, { chassis_number: "OTHER-1", customer_name: "Maersk" });

  for (const term of ["mscu123", "HAPAG", target.job_number.toLowerCase()]) {
    const found = await repo.listJobCards({ depotId, q: term, limit: 25, offset: 0 });
    assert.equal(found.total, 1, `"${term}" matched exactly the target card`);
    assert.equal(found.rows[0].id, target.id);
  }
});

test("q treats % and _ as literal characters, not wildcards", async () => {
  const depotId = await seedDepot();
  const typeId = await seedEquipmentType();
  await insertCard(depotId, typeId, { customer_name: "Maersk" });

  const wildcard = await repo.listJobCards({ depotId, q: "%", limit: 25, offset: 0 });
  assert.equal(wildcard.total, 0, "a bare % must not match every row");

  const underscore = await repo.listJobCards({ depotId, q: "_", limit: 25, offset: 0 });
  assert.equal(underscore.total, 0, "a bare _ must not match every single character");
});

test("a from/to window filters by created_at", async () => {
  const depotId = await seedDepot();
  const typeId = await seedEquipmentType();
  await insertCard(depotId, typeId);

  const past = await repo.listJobCards({
    depotId,
    to: "2000-01-01T00:00:00Z",
    limit: 25,
    offset: 0,
  });
  assert.equal(past.total, 0, "a card created now is outside a window that closed in 2000");

  const present = await repo.listJobCards({
    depotId,
    from: "2000-01-01T00:00:00Z",
    limit: 25,
    offset: 0,
  });
  assert.equal(present.total, 1);
});

test("list is ordered newest first", async () => {
  const depotId = await seedDepot();
  const typeId = await seedEquipmentType();
  const first = await insertCard(depotId, typeId, { customer_name: "first" });
  const second = await insertCard(depotId, typeId, { customer_name: "second" });

  const { rows } = await repo.listJobCards({ depotId, limit: 25, offset: 0 });
  assert.equal(rows[0].id, second.id, "most recently created card leads");
  assert.equal(rows[1].id, first.id);
});
