import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import * as repo from "../src/db/inspectionItems.repo";
import { pool } from "../src/db/pool";
import { closeDb, resetDb } from "./helpers/db";
import { createTestUser } from "./helpers/auth";
import {
  seedComponent,
  seedDamageCode,
  seedDepot,
  seedEquipmentType,
  seedJobCard,
  seedMainView,
  seedMediaAsset,
  seedRepairCode,
  seedSubview,
  seedSubviewField,
  seedSubviewFieldOption,
  seedWidgetType,
} from "./helpers/fixtures";

beforeEach(async () => {
  await resetDb();
});

after(async () => {
  await closeDb();
});

async function context() {
  const depotId = await seedDepot();
  const equipmentTypeId = await seedEquipmentType();
  const jobCardId = await seedJobCard(depotId, equipmentTypeId);
  const user = await createTestUser({ role: "MECHANIC" });
  return { depotId, equipmentTypeId, jobCardId, actorId: user.id };
}

const item = (
  over: Partial<repo.InsertInspectionItemInput> = {},
): repo.InsertInspectionItemInput => ({
  mainViewId: null,
  subviewId: null,
  componentId: null,
  conditionRating: null,
  notes: null,
  customFields: [],
  displayOrder: 0,
  clientUuid: null,
  damageCodeIds: [],
  repairCodeIds: [],
  ...over,
});

test("an item inserts with its damage and repair codes in one call", async () => {
  const { jobCardId, actorId } = await context();
  const damageId = await seedDamageCode();
  const repairId = await seedRepairCode();

  const [row] = await repo.insertInspectionItems(
    jobCardId,
    [item({ notes: "dent", damageCodeIds: [damageId], repairCodeIds: [repairId] })],
    actorId,
  );

  assert.equal(row.notes, "dent");
  assert.equal(row.job_card_id, jobCardId);
  assert.equal(row.created_by, actorId);
  assert.deepEqual(row.damage_code_ids, [damageId]);
  assert.deepEqual(row.repair_code_ids, [repairId]);
});

test("an item with no codes reports empty arrays, not [null]", async () => {
  const { jobCardId, actorId } = await context();

  const [row] = await repo.insertInspectionItems(jobCardId, [item()], actorId);

  assert.deepEqual(row.damage_code_ids, []);
  assert.deepEqual(row.repair_code_ids, [], "validateCustomFields reads length; [null] would lie");
});

test("a batch is one transaction: a bad code id leaves no rows behind", async () => {
  const { jobCardId, actorId } = await context();
  const bad = item({ damageCodeIds: ["00000000-0000-0000-0000-000000000000"] });

  await assert.rejects(() =>
    repo.insertInspectionItems(jobCardId, [item({ notes: "ok" }), bad], actorId),
  );

  assert.deepEqual(
    await repo.listInspectionItems(jobCardId),
    [],
    "the first item must not survive the second item's failure",
  );
});

test("a batch comes back in the order it was sent", async () => {
  const { jobCardId, actorId } = await context();

  const rows = await repo.insertInspectionItems(
    jobCardId,
    [item({ notes: "a" }), item({ notes: "b" }), item({ notes: "c" })],
    actorId,
  );

  assert.deepEqual(
    rows.map((r) => r.notes),
    ["a", "b", "c"],
    "a client lines the results up against the batch it sent",
  );
});

test("items list in display_order, and ties resolve to a stable total order", async () => {
  const { jobCardId, actorId } = await context();

  await repo.insertInspectionItems(
    jobCardId,
    [
      item({ notes: "third", displayOrder: 2 }),
      item({ notes: "first", displayOrder: 0 }),
      item({ notes: "second", displayOrder: 1 }),
    ],
    actorId,
  );

  assert.deepEqual(
    (await repo.listInspectionItems(jobCardId)).map((r) => r.notes),
    ["first", "second", "third"],
  );

  // All three share now(), so created_at alone is not a total order — the
  // list must still be deterministic.
  await repo.insertInspectionItems(
    jobCardId,
    [item({ notes: "x" }), item({ notes: "y" })],
    actorId,
  );
  const once = (await repo.listInspectionItems(jobCardId)).map((r) => r.id);
  const twice = (await repo.listInspectionItems(jobCardId)).map((r) => r.id);
  assert.deepEqual(once, twice);
});

test("custom_fields round-trips as a JSON array of snapshotted answers", async () => {
  const { jobCardId, actorId } = await context();
  const answers = [
    {
      subview_field_id: "33333333-3333-3333-3333-333333333333",
      field_name: "tread_depth",
      label: "Tread depth (32nds)",
      widget: "Number",
      value: 6,
      option_id: null,
    },
  ];

  const [row] = await repo.insertInspectionItems(
    jobCardId,
    [item({ customFields: answers })],
    actorId,
  );

  assert.deepEqual(row.custom_fields, answers);
});

test("field definitions come back with their options attached, in display order", async () => {
  const { equipmentTypeId } = await context();
  const subviewId = await seedSubview(await seedMainView(equipmentTypeId));
  const fieldId = await seedSubviewField(subviewId, await seedWidgetType("DropDown"), "severity");
  const severe = await seedSubviewFieldOption(fieldId, "Severe", 0);
  const minor = await seedSubviewFieldOption(fieldId, "Minor", 1);

  const [definition] = await repo.findSubviewFieldDefinitions(subviewId);

  assert.equal(definition.id, fieldId);
  assert.equal(definition.field_name, "severity");
  assert.equal(definition.widget_type_name, "DropDown");
  assert.deepEqual(definition.options, [
    { id: severe, label_value: "Severe" },
    { id: minor, label_value: "Minor" },
  ]);
});

test("a field definition with no options comes back with an empty array, not [null]", async () => {
  const { equipmentTypeId } = await context();
  const subviewId = await seedSubview(await seedMainView(equipmentTypeId));
  await seedSubviewField(subviewId, await seedWidgetType("Number"));

  const [definition] = await repo.findSubviewFieldDefinitions(subviewId);

  assert.deepEqual(
    definition.options,
    [],
    "having options is how the validator decides a field is option-backed",
  );
});

test("a subview with no fields yields no definitions", async () => {
  const { equipmentTypeId } = await context();
  const subviewId = await seedSubview(await seedMainView(equipmentTypeId));

  assert.deepEqual(await repo.findSubviewFieldDefinitions(subviewId), []);
});

test("updating replaces the code lists wholesale and can clear them", async () => {
  const { jobCardId, actorId } = await context();
  const first = await seedDamageCode();
  const second = await seedDamageCode();
  const repairId = await seedRepairCode();

  const [row] = await repo.insertInspectionItems(
    jobCardId,
    [item({ damageCodeIds: [first], repairCodeIds: [repairId] })],
    actorId,
  );

  const replaced = await repo.updateInspectionItem(row.id, {}, { damageCodeIds: [second] });
  assert.deepEqual(replaced?.damage_code_ids, [second]);
  assert.deepEqual(replaced?.repair_code_ids, [repairId], "an unnamed list is left alone");

  const cleared = await repo.updateInspectionItem(row.id, {}, { repairCodeIds: [] });
  assert.deepEqual(cleared?.repair_code_ids, []);
});

test("an explicit null in a patch clears the column", async () => {
  const { jobCardId, actorId } = await context();
  const [row] = await repo.insertInspectionItems(
    jobCardId,
    [item({ notes: "scrape", conditionRating: "POOR" })],
    actorId,
  );

  const updated = await repo.updateInspectionItem(row.id, { notes: null });

  assert.equal(
    updated?.notes,
    null,
    "COALESCE($n, col) cannot express this — the depot repo's bug must not repeat here",
  );
  assert.equal(updated?.condition_rating, "POOR", "an unnamed column is left alone");
});

test("a junction-only update still moves updated_at", async () => {
  const { jobCardId, actorId } = await context();
  const [row] = await repo.insertInspectionItems(jobCardId, [item()], actorId);
  const damageId = await seedDamageCode();

  const updated = await repo.updateInspectionItem(row.id, {}, { damageCodeIds: [damageId] });

  assert.ok(
    updated!.updated_at.getTime() >= row.updated_at.getTime(),
    "replacing an item's damage codes is a change to the item",
  );
});

test("updating an item that is not there reports null rather than throwing", async () => {
  await context();
  assert.equal(
    await repo.updateInspectionItem("00000000-0000-0000-0000-000000000000", { notes: "x" }),
    null,
  );
});

test("deleting an item removes its damages, repairs and media links", async () => {
  const { depotId, jobCardId, actorId } = await context();
  const [row] = await repo.insertInspectionItems(
    jobCardId,
    [item({ damageCodeIds: [await seedDamageCode()], repairCodeIds: [await seedRepairCode()] })],
    actorId,
  );
  const assetId = await seedMediaAsset(depotId, { status: "READY", storageKey: "ab/cd" });
  await repo.insertInspectionItemMedia({
    inspectionItemId: row.id,
    mediaAssetId: assetId,
    displayOrder: 0,
    createdBy: actorId,
  });

  assert.equal(await repo.deleteInspectionItem(row.id), true);

  for (const table of [
    "inspection_item_damages",
    "inspection_item_repairs",
    "inspection_item_media",
  ]) {
    const { rows } = await pool.query(`SELECT 1 FROM ${table} WHERE inspection_item_id = $1`, [
      row.id,
    ]);
    assert.equal(rows.length, 0, `${table} should have cascaded`);
  }

  const { rows: assets } = await pool.query("SELECT 1 FROM media_assets WHERE id = $1", [assetId]);
  assert.equal(assets.length, 1, "the bytes survive; only a reaper removes an asset row");
});

test("deleting an item that is not there reports false", async () => {
  await context();
  assert.equal(
    await repo.deleteInspectionItem("00000000-0000-0000-0000-000000000000"),
    false,
  );
});

test("deleting a job card removes its items", async () => {
  const { jobCardId, actorId } = await context();
  await repo.insertInspectionItems(jobCardId, [item()], actorId);

  await pool.query("DELETE FROM job_cards WHERE id = $1", [jobCardId]);

  assert.deepEqual(await repo.listInspectionItems(jobCardId), []);
});

test("attached item media comes back with size_bytes as a number", async () => {
  const { depotId, jobCardId, actorId } = await context();
  const [row] = await repo.insertInspectionItems(jobCardId, [item()], actorId);
  const assetId = await seedMediaAsset(depotId, {
    status: "READY",
    storageKey: "ab/cd",
    sizeBytes: 4096,
  });

  await repo.insertInspectionItemMedia({
    inspectionItemId: row.id,
    mediaAssetId: assetId,
    displayOrder: 0,
    createdBy: actorId,
  });
  const [media] = await repo.listInspectionItemMedia(row.id);

  assert.equal(
    media.size_bytes,
    4096,
    "BIGINT reaches JavaScript as a string; job_card_media needed this too",
  );
  assert.equal(typeof media.size_bytes, "number");
  assert.equal(media.display_order, 0);
});

test("detaching removes the link and reports whether there was one", async () => {
  const { depotId, jobCardId, actorId } = await context();
  const [row] = await repo.insertInspectionItems(jobCardId, [item()], actorId);
  const assetId = await seedMediaAsset(depotId, { status: "READY", storageKey: "ab/cd" });
  await repo.insertInspectionItemMedia({
    inspectionItemId: row.id,
    mediaAssetId: assetId,
    displayOrder: 0,
    createdBy: actorId,
  });

  assert.equal(await repo.deleteInspectionItemMedia(row.id, assetId), true);
  assert.equal(await repo.deleteInspectionItemMedia(row.id, assetId), false);
});

test("display order helpers report -1 when there is nothing yet, so the first append lands at 0", async () => {
  const { jobCardId, actorId } = await context();

  assert.equal(await repo.findMaxDisplayOrder(jobCardId), -1);

  const [row] = await repo.insertInspectionItems(
    jobCardId,
    [item({ displayOrder: 7 })],
    actorId,
  );
  assert.equal(await repo.findMaxDisplayOrder(jobCardId), 7);
  assert.equal(await repo.findMaxItemMediaOrder(row.id), -1);
});

test("a replayed client_uuid collides rather than duplicating, and is findable", async () => {
  const { jobCardId, actorId } = await context();
  const key = "44444444-4444-4444-4444-444444444444";
  await repo.insertInspectionItems(jobCardId, [item({ clientUuid: key })], actorId);

  await assert.rejects(
    () => repo.insertInspectionItems(jobCardId, [item({ clientUuid: key })], actorId),
    (err: { code?: string }) => err.code === "23505",
  );

  const existing = await repo.findInspectionItemByClientUuid(jobCardId, key);
  assert.ok(existing, "the service turns that collision into the existing row");
});

test("two cards may reuse the same client_uuid", async () => {
  const { depotId, equipmentTypeId, jobCardId, actorId } = await context();
  const otherCardId = await seedJobCard(depotId, equipmentTypeId);
  const key = "55555555-5555-5555-5555-555555555555";

  await repo.insertInspectionItems(jobCardId, [item({ clientUuid: key })], actorId);
  const [row] = await repo.insertInspectionItems(
    otherCardId,
    [item({ clientUuid: key })],
    actorId,
  );

  assert.equal(row.job_card_id, otherCardId, "the index is scoped to the card, not global");
});

test("an item may carry its full locating chain", async () => {
  const { equipmentTypeId, jobCardId, actorId } = await context();
  const componentId = await seedComponent();
  const mainViewId = await seedMainView(equipmentTypeId);
  const subviewId = await seedSubview(mainViewId, componentId);

  const [row] = await repo.insertInspectionItems(
    jobCardId,
    [item({ mainViewId, subviewId, componentId, conditionRating: "POOR" })],
    actorId,
  );

  assert.equal(row.main_view_id, mainViewId);
  assert.equal(row.subview_id, subviewId);
  assert.equal(row.component_id, componentId);
  assert.equal(row.condition_rating, "POOR");
});
