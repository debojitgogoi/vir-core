import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import * as service from "../src/services/inspectionItems.service";
import { pool } from "../src/db/pool";
import { AppError } from "../src/middleware/errors";
import { closeDb, resetDb } from "./helpers/db";
import { createTestUser } from "./helpers/auth";
import {
  seedComponent,
  seedDamageCode,
  seedDepot,
  seedEquipmentType,
  seedJobCard,
  seedMainView,
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

const MISSING = "00000000-0000-0000-0000-000000000000";

async function context() {
  const depotId = await seedDepot();
  const equipmentTypeId = await seedEquipmentType();
  const jobCardId = await seedJobCard(depotId, equipmentTypeId);
  const user = await createTestUser({ role: "MECHANIC" });
  return { depotId, equipmentTypeId, jobCardId, actorId: user.id };
}

async function events(jobCardId: string) {
  const { rows } = await pool.query<{ from_status: string; to_status: string; actor_user_id: string }>(
    "SELECT from_status, to_status, actor_user_id FROM job_card_events WHERE job_card_id = $1",
    [jobCardId],
  );
  return rows;
}

async function statusOf(jobCardId: string) {
  const { rows } = await pool.query<{ status: string }>(
    "SELECT status FROM job_cards WHERE id = $1",
    [jobCardId],
  );
  return rows[0].status;
}

test("creating one item returns one DTO carrying its codes", async () => {
  const { jobCardId, actorId } = await context();
  const damageId = await seedDamageCode();

  const items = await service.createInspectionItems(
    jobCardId,
    [{ notes: "dent", damage_code_ids: [damageId] }],
    actorId,
  );

  assert.equal(items.length, 1);
  assert.equal(items[0].notes, "dent");
  assert.deepEqual(items[0].damage_code_ids, [damageId]);
  assert.equal(items[0].created_by, actorId);
  assert.equal(typeof items[0].created_at, "string");
});

test("creating an array returns the DTOs in the order sent", async () => {
  const { jobCardId, actorId } = await context();

  const items = await service.createInspectionItems(
    jobCardId,
    [{ notes: "a" }, { notes: "b" }, { notes: "c" }],
    actorId,
  );

  assert.deepEqual(
    items.map((i) => i.notes),
    ["a", "b", "c"],
  );
});

test("custom fields come back snapshotted from master data", async () => {
  const { equipmentTypeId, jobCardId, actorId } = await context();
  const subviewId = await seedSubview(await seedMainView(equipmentTypeId));
  const fieldId = await seedSubviewField(subviewId, await seedWidgetType("Number"), "tread_depth");

  const [item] = await service.createInspectionItems(
    jobCardId,
    [{ subview_id: subviewId, custom_fields: [{ subview_field_id: fieldId, value: "6" }] }],
    actorId,
  );

  assert.deepEqual(item.custom_fields, [
    {
      subview_field_id: fieldId,
      field_name: "tread_depth",
      label: "tread_depth",
      widget: "Number",
      value: 6,
      option_id: null,
    },
  ]);
});

test("an option-backed answer stores the option's own label, not the client's", async () => {
  const { equipmentTypeId, jobCardId, actorId } = await context();
  const subviewId = await seedSubview(await seedMainView(equipmentTypeId));
  const fieldId = await seedSubviewField(subviewId, await seedWidgetType("DropDown"));
  const optionId = await seedSubviewFieldOption(fieldId, "Severe");

  const [item] = await service.createInspectionItems(
    jobCardId,
    [
      {
        subview_id: subviewId,
        custom_fields: [{ subview_field_id: fieldId, option_id: optionId, value: "Minor" }],
      },
    ],
    actorId,
  );

  assert.equal(item.custom_fields[0].value, "Severe");
});

test("custom fields with no subview_id are refused, naming subview_id", async () => {
  const { jobCardId, actorId } = await context();

  await assert.rejects(
    () =>
      service.createInspectionItems(
        jobCardId,
        [{ custom_fields: [{ subview_field_id: MISSING, value: 1 }] }],
        actorId,
      ),
    (err: AppError) =>
      err.status === 400 && err.details!.some((d) => d.includes("subview_id")),
  );
});

test("a subview outside the given main view is refused", async () => {
  const { equipmentTypeId, jobCardId, actorId } = await context();
  const mainViewId = await seedMainView(equipmentTypeId);
  const straySubviewId = await seedSubview(await seedMainView(equipmentTypeId));

  await assert.rejects(
    () =>
      service.createInspectionItems(
        jobCardId,
        [{ main_view_id: mainViewId, subview_id: straySubviewId }],
        actorId,
      ),
    (err: AppError) => err.status === 400 && err.code === "VALIDATION_ERROR",
  );
});

test("a main view from another equipment type is refused", async () => {
  const { jobCardId, actorId } = await context();
  const foreignMainViewId = await seedMainView(await seedEquipmentType());

  await assert.rejects(
    () => service.createInspectionItems(jobCardId, [{ main_view_id: foreignMainViewId }], actorId),
    (err: AppError) =>
      err.status === 400 &&
      err.details!.some((d) => d.includes("equipment type")),
  );
});

test("an unknown damage code is a 400, not a 500 from the foreign key", async () => {
  const { jobCardId, actorId } = await context();

  await assert.rejects(
    () => service.createInspectionItems(jobCardId, [{ damage_code_ids: [MISSING] }], actorId),
    (err: AppError) => err.status === 400 && err.code === "VALIDATION_ERROR",
  );
});

test("display_order defaults to the end of the card's list", async () => {
  const { jobCardId, actorId } = await context();

  await service.createInspectionItems(jobCardId, [{ notes: "first" }], actorId);
  const [second] = await service.createInspectionItems(jobCardId, [{ notes: "second" }], actorId);

  assert.equal(second.display_order, 1, "an omitted order appends rather than landing at 0");

  const listed = await service.listInspectionItems(jobCardId);
  assert.deepEqual(
    listed.map((i) => i.notes),
    ["first", "second"],
  );
});

test("the first item moves a DRAFT card to IN_INSPECTION and records one event", async () => {
  const { jobCardId, actorId } = await context();
  assert.equal(await statusOf(jobCardId), "DRAFT");

  await service.createInspectionItems(jobCardId, [{ notes: "dent" }], actorId);

  assert.equal(await statusOf(jobCardId), "IN_INSPECTION");
  assert.deepEqual(await events(jobCardId), [
    { from_status: "DRAFT", to_status: "IN_INSPECTION", actor_user_id: actorId },
  ]);
});

test("a second item does not record a second event", async () => {
  const { jobCardId, actorId } = await context();

  await service.createInspectionItems(jobCardId, [{ notes: "one" }], actorId);
  await service.createInspectionItems(jobCardId, [{ notes: "two" }], actorId);

  assert.equal((await events(jobCardId)).length, 1);
});

test("a card already past DRAFT is left where it is", async () => {
  const { jobCardId, actorId } = await context();
  await pool.query("UPDATE job_cards SET status = 'IN_ESTIMATION' WHERE id = $1", [jobCardId]);

  await service.createInspectionItems(jobCardId, [{ notes: "dent" }], actorId);

  assert.equal(await statusOf(jobCardId), "IN_ESTIMATION");
  assert.deepEqual(await events(jobCardId), []);
});

test("a replayed client_uuid returns the existing item rather than duplicating", async () => {
  const { jobCardId, actorId } = await context();
  const key = "44444444-4444-4444-4444-444444444444";

  const [first] = await service.createInspectionItems(
    jobCardId,
    [{ notes: "dent", client_uuid: key }],
    actorId,
  );
  const [replayed] = await service.createInspectionItems(
    jobCardId,
    [{ notes: "dent", client_uuid: key }],
    actorId,
  );

  assert.equal(replayed.id, first.id);
  assert.equal((await service.listInspectionItems(jobCardId)).length, 1);
});

test("a batch with one invalid item inserts nothing, and names the failing index", async () => {
  const { jobCardId, actorId } = await context();
  const foreign = await seedMainView(await seedEquipmentType());

  await assert.rejects(
    () =>
      service.createInspectionItems(
        jobCardId,
        [{ notes: "fine" }, { main_view_id: foreign }],
        actorId,
      ),
    (err: AppError) => err.details!.some((d) => d.startsWith("1.")),
  );

  assert.deepEqual(await service.listInspectionItems(jobCardId), []);
});

test("a single-item request reports violations without an index prefix", async () => {
  const { jobCardId, actorId } = await context();
  const foreign = await seedMainView(await seedEquipmentType());

  await assert.rejects(
    () => service.createInspectionItems(jobCardId, [{ main_view_id: foreign }], actorId),
    (err: AppError) => err.details![0].startsWith("main_view_id"),
  );
});

test("creating on an unknown card is 404", async () => {
  const { actorId } = await context();

  await assert.rejects(
    () => service.createInspectionItems(MISSING, [{ notes: "x" }], actorId),
    (err: AppError) => err.status === 404,
  );
});

test("reading an item that belongs to another card is 404", async () => {
  const { depotId, equipmentTypeId, jobCardId, actorId } = await context();
  const otherCardId = await seedJobCard(depotId, equipmentTypeId);
  const [item] = await service.createInspectionItems(jobCardId, [{ notes: "dent" }], actorId);

  await assert.rejects(
    () => service.getInspectionItem(otherCardId, item.id),
    (err: AppError) => err.status === 404,
    "item ids must not be a cross-card read channel",
  );
});

test("updating replaces the code lists wholesale and can clear them", async () => {
  const { jobCardId, actorId } = await context();
  const first = await seedDamageCode();
  const second = await seedDamageCode();
  const [item] = await service.createInspectionItems(
    jobCardId,
    [{ damage_code_ids: [first], repair_code_ids: [await seedRepairCode()] }],
    actorId,
  );

  const replaced = await service.updateInspectionItem(jobCardId, item.id, {
    damage_code_ids: [second],
  });
  assert.deepEqual(replaced.damage_code_ids, [second]);
  assert.equal(replaced.repair_code_ids.length, 1, "an unnamed list is left alone");

  const cleared = await service.updateInspectionItem(jobCardId, item.id, {
    repair_code_ids: [],
  });
  assert.deepEqual(cleared.repair_code_ids, []);
});

test("patching notes to null actually clears the column", async () => {
  const { jobCardId, actorId } = await context();
  const [item] = await service.createInspectionItems(
    jobCardId,
    [{ notes: "scrape", condition_rating: "POOR" }],
    actorId,
  );

  const updated = await service.updateInspectionItem(jobCardId, item.id, { notes: null });

  assert.equal(updated.notes, null);
  assert.equal(updated.condition_rating, "POOR");
});

test("patching a component through is stored", async () => {
  const { jobCardId, actorId } = await context();
  const [item] = await service.createInspectionItems(jobCardId, [{ notes: "dent" }], actorId);
  const componentId = await seedComponent();

  const updated = await service.updateInspectionItem(jobCardId, item.id, {
    component_id: componentId,
  });

  assert.equal(updated.component_id, componentId);
});

test("a patch that moves the subview re-validates the answers against the new one", async () => {
  const { equipmentTypeId, jobCardId, actorId } = await context();
  const mainViewId = await seedMainView(equipmentTypeId);
  const fromSubview = await seedSubview(mainViewId);
  const toSubview = await seedSubview(mainViewId);
  const fieldId = await seedSubviewField(fromSubview, await seedWidgetType("Number"));

  const [item] = await service.createInspectionItems(
    jobCardId,
    [{ subview_id: fromSubview, custom_fields: [{ subview_field_id: fieldId, value: 6 }] }],
    actorId,
  );

  await assert.rejects(
    () =>
      service.updateInspectionItem(jobCardId, item.id, {
        subview_id: toSubview,
        custom_fields: [{ subview_field_id: fieldId, value: 6 }],
      }),
    (err: AppError) => err.status === 400,
    "answers from the subview the item left must not survive the move",
  );
});

test("updating an item on another card is 404", async () => {
  const { depotId, equipmentTypeId, jobCardId, actorId } = await context();
  const otherCardId = await seedJobCard(depotId, equipmentTypeId);
  const [item] = await service.createInspectionItems(jobCardId, [{ notes: "dent" }], actorId);

  await assert.rejects(
    () => service.updateInspectionItem(otherCardId, item.id, { notes: "x" }),
    (err: AppError) => err.status === 404,
  );
});

test("deleting removes the item; deleting an unknown one is 404", async () => {
  const { jobCardId, actorId } = await context();
  const [item] = await service.createInspectionItems(jobCardId, [{ notes: "dent" }], actorId);

  await service.deleteInspectionItem(jobCardId, item.id);
  assert.deepEqual(await service.listInspectionItems(jobCardId), []);

  await assert.rejects(
    () => service.deleteInspectionItem(jobCardId, item.id),
    (err: AppError) => err.status === 404,
  );
});

test("listing an unknown card is 404, not an empty list", async () => {
  await context();

  await assert.rejects(
    () => service.listInspectionItems(MISSING),
    (err: AppError) => err.status === 404,
    "a card that does not exist is a different answer from a card with no items",
  );
});
