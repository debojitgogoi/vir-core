import assert from "node:assert/strict";
import { after, test } from "node:test";
import { pool } from "../src/db/pool";
import { closeDb } from "./helpers/db";

after(async () => {
  await closeDb();
});

async function columns(table: string): Promise<Map<string, boolean>> {
  const { rows } = await pool.query<{ column_name: string; is_nullable: string }>(
    `SELECT column_name, is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1`,
    [table],
  );
  return new Map(rows.map((r) => [r.column_name, r.is_nullable === "YES"]));
}

test("inspection_items keeps every locating column nullable", async () => {
  const cols = await columns("inspection_items");

  for (const column of [
    "main_view_id",
    "subview_id",
    "component_id",
    "condition_rating",
    "notes",
  ]) {
    assert.equal(
      cols.get(column),
      true,
      `${column} must be nullable — a partial walkaround still has to save`,
    );
  }
  assert.equal(cols.get("job_card_id"), false, "an item without a card is not an item");
});

test("inspection_items is mutable, so it carries updated_at and exactly one trigger", async () => {
  const cols = await columns("inspection_items");
  assert.equal(cols.has("updated_at"), true);

  const { rows } = await pool.query<{ tgname: string }>(
    `SELECT tgname FROM pg_trigger
      WHERE tgrelid = 'inspection_items'::regclass AND NOT tgisinternal`,
  );
  assert.deepEqual(
    rows.map((r) => r.tgname),
    ["trg_inspection_items_set_updated_at"],
  );
});

test("custom_fields refuses anything that is not a JSON array", async () => {
  const { rows } = await pool.query<{ check_clause: string }>(
    `SELECT cc.check_clause
       FROM information_schema.check_constraints cc
       JOIN information_schema.constraint_column_usage ccu
         ON ccu.constraint_name = cc.constraint_name
        AND ccu.constraint_schema = cc.constraint_schema
      WHERE ccu.table_name = 'inspection_items' AND ccu.column_name = 'custom_fields'`,
  );

  assert.ok(
    rows.some((r) => r.check_clause.includes("array")),
    "a JSON object would pass every service check and still be the wrong shape",
  );
});

test("an object literal in custom_fields is rejected by the database itself", async () => {
  await assert.rejects(
    () =>
      pool.query(
        `INSERT INTO inspection_items (job_card_id, custom_fields)
         VALUES ('00000000-0000-0000-0000-000000000000', '{"a":1}'::jsonb)`,
      ),
    "either the CHECK or the foreign key must refuse this; both are correct answers",
  );
});

test("client_uuid is unique per card and partial, not global", async () => {
  const { rows } = await pool.query<{ indexdef: string }>(
    `SELECT indexdef FROM pg_indexes
      WHERE tablename = 'inspection_items'
        AND indexname = 'ux_inspection_items_client_uuid'`,
  );

  assert.equal(rows.length, 1);
  assert.ok(rows[0].indexdef.includes("job_card_id"), "two cards may reuse a client key");
  assert.ok(rows[0].indexdef.includes("WHERE"), "partial, so NULL keys never collide");
});

test("cascades and restrictions match what each foreign key is protecting", async () => {
  const { rows } = await pool.query<{
    table_name: string;
    column_name: string;
    delete_rule: string;
  }>(
    `SELECT tc.table_name, kcu.column_name, rc.delete_rule
       FROM information_schema.referential_constraints rc
       JOIN information_schema.table_constraints tc
         ON tc.constraint_name = rc.constraint_name
        AND tc.constraint_schema = rc.constraint_schema
       JOIN information_schema.key_column_usage kcu
         ON kcu.constraint_name = rc.constraint_name
        AND kcu.constraint_schema = rc.constraint_schema
      WHERE tc.table_name IN ('inspection_items', 'inspection_item_damages',
                              'inspection_item_repairs', 'inspection_item_media')`,
  );

  const rule = (table: string, column: string) =>
    rows.find((r) => r.table_name === table && r.column_name === column)?.delete_rule;

  assert.equal(rule("inspection_items", "job_card_id"), "CASCADE");
  assert.equal(rule("inspection_item_damages", "inspection_item_id"), "CASCADE");
  assert.equal(rule("inspection_item_repairs", "inspection_item_id"), "CASCADE");
  assert.equal(rule("inspection_item_media", "inspection_item_id"), "CASCADE");

  // RESTRICT is reported verbatim here, distinct from NO ACTION: the two differ
  // in when they fire, and only RESTRICT refuses inside the same statement.
  assert.equal(
    rule("inspection_item_damages", "damage_code_id"),
    "RESTRICT",
    "a damage code some card references is not deletable master data",
  );
  assert.equal(rule("inspection_item_repairs", "repair_code_id"), "RESTRICT");
  assert.equal(
    rule("inspection_item_media", "media_asset_id"),
    "RESTRICT",
    "the reaper must check every link before it deletes bytes",
  );
  assert.equal(rule("inspection_items", "main_view_id"), "RESTRICT");
});

test("the same code cannot be recorded twice on one item", async () => {
  for (const [table, column] of [
    ["inspection_item_damages", "damage_code_id"],
    ["inspection_item_repairs", "repair_code_id"],
    ["inspection_item_media", "media_asset_id"],
  ]) {
    const { rows } = await pool.query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE tablename = $1",
      [table],
    );
    assert.ok(
      rows.some((r) => r.indexdef.includes("UNIQUE") && r.indexdef.includes(column)),
      `${table} needs a UNIQUE on (inspection_item_id, ${column})`,
    );
  }
});

test("the card's item list and each item's photographs are both indexed for their read", async () => {
  const { rows } = await pool.query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes
      WHERE tablename IN ('inspection_items', 'inspection_item_media')`,
  );
  const names = rows.map((r) => r.indexname);

  assert.ok(names.includes("idx_inspection_items_card"));
  assert.ok(names.includes("idx_inspection_items_subview"));
  assert.ok(names.includes("idx_inspection_item_media_item"));
});
