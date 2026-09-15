import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createInspectionItemSchema,
  createInspectionItemsSchema,
  MAX_ITEMS_PER_REQUEST,
  patchInspectionItemSchema,
} from "../src/schemas/inspectionItem.schemas";

const uuid = "11111111-1111-1111-1111-111111111111";
const otherUuid = "22222222-2222-2222-2222-222222222222";

test("the single and array schemas agree on what one item means", () => {
  const one = createInspectionItemSchema.parse({ notes: "scrape" });
  const [many] = createInspectionItemsSchema.parse([{ notes: "scrape" }]);

  assert.deepEqual(one, many);
});

test("the two forms are separate schemas so violation paths keep their meaning", () => {
  // A z.union would collapse both branches into one invalid_union issue,
  // costing the field paths a client needs and the index that says which item
  // of a batch was wrong.
  try {
    createInspectionItemsSchema.parse([{ notes: "fine" }, { display_order: -1 }]);
    assert.fail("expected a rejection");
  } catch (err) {
    const issues = (err as { issues: { path: (string | number)[] }[] }).issues;
    assert.deepEqual(issues[0].path, [1, "display_order"]);
  }

  try {
    createInspectionItemSchema.parse({ display_order: -1 });
    assert.fail("expected a rejection");
  } catch (err) {
    const issues = (err as { issues: { path: (string | number)[] }[] }).issues;
    assert.deepEqual(issues[0].path, ["display_order"], "no index the client never sent");
  }
});

test("an empty array is refused — an empty write is a client bug, not a no-op", () => {
  assert.throws(() => createInspectionItemsSchema.parse([]));
});

test("a batch is capped, so one request cannot become unbounded work", () => {
  const oversized = Array.from({ length: MAX_ITEMS_PER_REQUEST + 1 }, () => ({ notes: "x" }));

  assert.throws(() => createInspectionItemsSchema.parse(oversized));
  assert.equal(
    createInspectionItemsSchema.parse(oversized.slice(0, MAX_ITEMS_PER_REQUEST)).length,
    MAX_ITEMS_PER_REQUEST,
  );
});

test("every locating field is optional — a bare note is a valid item", () => {
  const item = createInspectionItemSchema.parse({ notes: "dent, driver side" });

  assert.equal(item.main_view_id, undefined);
  assert.equal(item.subview_id, undefined);
  assert.equal(item.damage_code_ids, undefined);
});

test("blank notes become null rather than an empty string", () => {
  const item = createInspectionItemSchema.parse({ notes: "   " });
  assert.equal(item.notes, null);
});

test("code ids must be UUIDs", () => {
  assert.throws(() => createInspectionItemSchema.parse({ damage_code_ids: ["nope"] }));
  assert.deepEqual(
    createInspectionItemSchema.parse({ damage_code_ids: [uuid] }).damage_code_ids,
    [uuid],
  );
});

test("a repeated code id is refused rather than silently deduplicated", () => {
  assert.throws(
    () => createInspectionItemSchema.parse({ repair_code_ids: [uuid, uuid] }),
    "the junction's UNIQUE would reject it anyway; saying so beats a 500",
  );
  assert.deepEqual(
    createInspectionItemSchema.parse({ repair_code_ids: [uuid, otherUuid] }).repair_code_ids,
    [uuid, otherUuid],
  );
});

test("unknown keys are rejected, so a typo'd field is not silently dropped", () => {
  assert.throws(() => createInspectionItemSchema.parse({ note: "typo" }));
});

test("a server-owned column cannot be supplied", () => {
  assert.throws(() => createInspectionItemSchema.parse({ job_card_id: uuid }));
  assert.throws(() => createInspectionItemSchema.parse({ created_by: uuid }));
  assert.throws(() => createInspectionItemSchema.parse({ id: uuid }));
});

test("custom_fields answers carry only what the client is allowed to choose", () => {
  const item = createInspectionItemSchema.parse({
    custom_fields: [{ subview_field_id: uuid, value: 6 }],
  });
  assert.equal(item.custom_fields?.[0].value, 6);

  assert.throws(
    () =>
      createInspectionItemSchema.parse({
        custom_fields: [{ subview_field_id: uuid, value: 6, label: "spoofed" }],
      }),
    "label is snapshotted from master data; a client supplying one is refused",
  );
});

test("display_order must be a non-negative integer", () => {
  assert.throws(() => createInspectionItemSchema.parse({ display_order: -1 }));
  assert.throws(() => createInspectionItemSchema.parse({ display_order: 1.5 }));
  assert.equal(createInspectionItemSchema.parse({ display_order: 0 }).display_order, 0);
});

test("an empty patch is refused — it would be a write that means nothing", () => {
  assert.throws(() => patchInspectionItemSchema.parse({}));
});

test("a patch distinguishes an absent key from an explicit null", () => {
  const patch = patchInspectionItemSchema.parse({ subview_id: null });

  assert.ok("subview_id" in patch, "the key must survive so the service can clear the column");
  assert.equal(patch.subview_id, null);
});

test("a patch may clear the code lists with an empty array", () => {
  assert.deepEqual(patchInspectionItemSchema.parse({ damage_code_ids: [] }).damage_code_ids, []);
});

test("a patch cannot re-key an existing item", () => {
  assert.throws(
    () => patchInspectionItemSchema.parse({ client_uuid: uuid }),
    "client_uuid identifies the creating request; re-keying would break idempotency",
  );
});
