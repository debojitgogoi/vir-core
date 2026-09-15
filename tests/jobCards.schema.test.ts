import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { pool } from "../src/db/pool";
import { closeDb, resetDb } from "./helpers/db";

beforeEach(async () => {
  await resetDb();
});

after(async () => {
  await closeDb();
});

async function seedDepotAndEquipmentType(): Promise<{
  depotId: string;
  equipmentTypeId: string;
}> {
  const depot = await pool.query<{ id: string }>(
    `INSERT INTO depots (slug_id, code, name) VALUES ('AAAAAAAA', 'LAX', 'LA') RETURNING id`,
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
  return { depotId: depot.rows[0].id, equipmentTypeId: type.rows[0].id };
}

async function insertJobCard(
  depotId: string,
  equipmentTypeId: string,
  overrides: Record<string, unknown> = {},
): Promise<string> {
  const values = {
    job_number: "VIR-ABCD1234",
    direction: "INBOUND",
    chassis_number: "CHS0001",
    ...overrides,
  } as Record<string, unknown>;

  const columns = ["depot_id", "equipment_type_id", ...Object.keys(values)];
  const params = [depotId, equipmentTypeId, ...Object.values(values)];
  const placeholders = params.map((_, i) => `$${i + 1}`).join(", ");

  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO job_cards (${columns.join(", ")}) VALUES (${placeholders}) RETURNING id`,
    params,
  );
  return rows[0].id;
}

test("a job card defaults to DRAFT", async () => {
  const { depotId, equipmentTypeId } = await seedDepotAndEquipmentType();
  const id = await insertJobCard(depotId, equipmentTypeId);

  const { rows } = await pool.query<{ status: string; locked_at: Date | null }>(
    `SELECT status, locked_at FROM job_cards WHERE id = $1`,
    [id],
  );
  assert.equal(rows[0].status, "DRAFT");
  assert.equal(rows[0].locked_at, null);
});

test("a job card must carry a container or chassis number", async () => {
  const { depotId, equipmentTypeId } = await seedDepotAndEquipmentType();
  await assert.rejects(
    () => insertJobCard(depotId, equipmentTypeId, { chassis_number: null }),
    (err: { code?: string }) => err.code === "23514",
  );
});

test("an unknown status is rejected", async () => {
  const { depotId, equipmentTypeId } = await seedDepotAndEquipmentType();
  await assert.rejects(
    () => insertJobCard(depotId, equipmentTypeId, { status: "MAYBE" }),
    (err: { code?: string }) => err.code === "23514",
  );
});

test("size and genset_status are constrained to their allowed values", async () => {
  const { depotId, equipmentTypeId } = await seedDepotAndEquipmentType();

  await assert.rejects(
    () => insertJobCard(depotId, equipmentTypeId, { size: 30 }),
    (err: { code?: string }) => err.code === "23514",
  );
  await assert.rejects(
    () => insertJobCard(depotId, equipmentTypeId, { genset_status: "RUNNING" }),
    (err: { code?: string }) => err.code === "23514",
  );

  const ok = await insertJobCard(depotId, equipmentTypeId, {
    size: 40,
    genset_status: "POWERED_RUNNING",
  });
  assert.ok(ok);
});

test("job_number is unique", async () => {
  const { depotId, equipmentTypeId } = await seedDepotAndEquipmentType();
  await insertJobCard(depotId, equipmentTypeId);
  await assert.rejects(
    () => insertJobCard(depotId, equipmentTypeId, { chassis_number: "CHS0002" }),
    (err: { code?: string }) => err.code === "23505",
  );
});

test("a job_number not matching VIR-XXXXXXXX is rejected", async () => {
  const { depotId, equipmentTypeId } = await seedDepotAndEquipmentType();

  for (const bad of ["vir-lowercase", "VIR-SHORT", "VIR-TOOMANYCHARS", "ABC-12345678"]) {
    await assert.rejects(
      () => insertJobCard(depotId, equipmentTypeId, { job_number: bad }),
      (err: { code?: string; constraint?: string }) =>
        err.code === "23514" && err.constraint === "job_number_format",
      `${bad} should violate job_number_format`,
    );
  }

  const ok = await insertJobCard(depotId, equipmentTypeId, { job_number: "VIR-0AZ9QWER" });
  assert.ok(ok);
});

test("the redundant job_number index is gone; the unique constraint remains", async () => {
  const { rows } = await pool.query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes WHERE tablename = 'job_cards'`,
  );
  const names = rows.map((r) => r.indexname);

  assert.ok(!names.includes("idx_job_cards_job_number"), "redundant index dropped");
  assert.ok(
    names.includes("job_cards_job_number_key"),
    "the UNIQUE constraint's implicit index still exists",
  );
});

test("events cascade when a job card is deleted", async () => {
  const { depotId, equipmentTypeId } = await seedDepotAndEquipmentType();
  const id = await insertJobCard(depotId, equipmentTypeId);

  await pool.query(
    `INSERT INTO job_card_events (job_card_id, from_status, to_status)
     VALUES ($1, 'DRAFT', 'IN_INSPECTION')`,
    [id],
  );
  await pool.query(`DELETE FROM job_cards WHERE id = $1`, [id]);

  const { rows } = await pool.query<{ count: string }>(
    `SELECT count(*) FROM job_card_events WHERE job_card_id = $1`,
    [id],
  );
  assert.equal(rows[0].count, "0");
});
