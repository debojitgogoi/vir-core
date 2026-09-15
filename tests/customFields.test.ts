import assert from "node:assert/strict";
import { test } from "node:test";
import { resolveWidgetKind } from "../src/utils/widgetKind";
import { FieldDefinition, validateCustomFields } from "../src/services/customFields";
import { AppError } from "../src/middleware/errors";

const def = (over: Partial<FieldDefinition> = {}): FieldDefinition => ({
  id: "11111111-1111-1111-1111-111111111111",
  field_name: "tread_depth",
  label: "Tread depth (32nds)",
  widget_type_name: "Number",
  options: [],
  ...over,
});

test("widget names are normalized before matching, so spelling variants agree", () => {
  assert.equal(resolveWidgetKind("Number"), "NUMBER");
  assert.equal(resolveWidgetKind("number_box"), "NUMBER");
  assert.equal(resolveWidgetKind("Text Box"), "TEXT");
  assert.equal(resolveWidgetKind("TextArea"), "TEXT");
  assert.equal(resolveWidgetKind("CheckBox"), "BOOLEAN");
  assert.equal(resolveWidgetKind("Date Picker"), "DATE");
});

test("an unrecognized widget name resolves to UNKNOWN rather than to a guess", () => {
  assert.equal(
    resolveWidgetKind("Wibble"),
    "UNKNOWN",
    "widget_types.name is verbatim legacy text; guessing would reject real answers",
  );
  assert.equal(resolveWidgetKind(""), "UNKNOWN");
});

test("the server snapshots field_name, label and widget, ignoring what the client sent", () => {
  const [answer] = validateCustomFields(
    [
      {
        subview_field_id: def().id,
        value: 6,
        // A client that sends these does not get to have them honoured.
        field_name: "renamed_by_client",
        label: "Something else",
      } as never,
    ],
    [def()],
  );

  assert.equal(answer.field_name, "tread_depth");
  assert.equal(answer.label, "Tread depth (32nds)");
  assert.equal(answer.widget, "Number");
  assert.equal(answer.value, 6);
});

test("a NUMBER field coerces a numeric string and refuses a non-numeric one", () => {
  assert.equal(
    validateCustomFields([{ subview_field_id: def().id, value: "6" }], [def()])[0].value,
    6,
  );
  assert.throws(
    () => validateCustomFields([{ subview_field_id: def().id, value: "deep" }], [def()]),
    (err: AppError) => err.status === 400 && err.code === "VALIDATION_ERROR",
  );
});

test("a NUMBER field refuses a boolean rather than reading it as 1", () => {
  assert.throws(
    () => validateCustomFields([{ subview_field_id: def().id, value: true }], [def()]),
    "Number(true) is 1, which would store an answer nobody gave",
  );
});

test("an omitted or blank answer is null, not a coercion failure", () => {
  assert.equal(validateCustomFields([{ subview_field_id: def().id }], [def()])[0].value, null);
  assert.equal(
    validateCustomFields([{ subview_field_id: def().id, value: "" }], [def()])[0].value,
    null,
    "Number('') is 0; a field the inspector skipped must not read as zero tread",
  );
});

test("a DATE field refuses an impossible calendar date", () => {
  const field = def({ widget_type_name: "Date" });

  assert.equal(
    validateCustomFields([{ subview_field_id: field.id, value: "2026-03-01" }], [field])[0].value,
    "2026-03-01",
  );
  assert.throws(
    () => validateCustomFields([{ subview_field_id: field.id, value: "2026-02-31" }], [field]),
    (err: AppError) => err.status === 400,
  );
});

test("a BOOLEAN field takes true/false and the strings for them, nothing else", () => {
  const field = def({ widget_type_name: "CheckBox" });

  assert.equal(
    validateCustomFields([{ subview_field_id: field.id, value: "true" }], [field])[0].value,
    true,
  );
  assert.throws(() =>
    validateCustomFields([{ subview_field_id: field.id, value: "yes" }], [field]),
  );
});

test("a TEXT field trims, and a whitespace-only answer becomes null", () => {
  const field = def({ widget_type_name: "TextBox" });

  assert.equal(
    validateCustomFields([{ subview_field_id: field.id, value: "  rust  " }], [field])[0].value,
    "rust",
  );
  assert.equal(
    validateCustomFields([{ subview_field_id: field.id, value: "   " }], [field])[0].value,
    null,
  );
});

test("an UNKNOWN widget accepts any JSON scalar but still refuses an object", () => {
  const field = def({ widget_type_name: "Wibble" });

  assert.equal(
    validateCustomFields([{ subview_field_id: field.id, value: "anything" }], [field])[0].value,
    "anything",
  );
  assert.throws(
    () => validateCustomFields([{ subview_field_id: field.id, value: { a: 1 } }], [field]),
    "custom_fields is a flat list of answers; nesting would defeat every query into it",
  );
});

test("an option-backed field takes its value from master data, not from the client", () => {
  const field = def({
    widget_type_name: "DropDown",
    options: [
      { id: "opt-1", label_value: "Severe" },
      { id: "opt-2", label_value: "Minor" },
    ],
  });

  const [answer] = validateCustomFields(
    [{ subview_field_id: field.id, option_id: "opt-2", value: "Severe" }],
    [field],
  );

  assert.equal(answer.option_id, "opt-2");
  assert.equal(answer.value, "Minor", "the client does not get to say what the option means");
});

test("an option-backed field is checked even when its widget kind is UNKNOWN", () => {
  const field = def({
    widget_type_name: "Wibble",
    options: [{ id: "opt-1", label_value: "Severe" }],
  });

  assert.throws(
    () => validateCustomFields([{ subview_field_id: field.id, option_id: "opt-9" }], [field]),
    "having options is a fact about master data, not a guess from the widget name",
  );
});

test("an option-backed field refuses a missing option_id", () => {
  const field = def({ options: [{ id: "opt-1", label_value: "Severe" }] });

  assert.throws(() =>
    validateCustomFields([{ subview_field_id: field.id, value: "Severe" }], [field]),
  );
});

test("a field with no options refuses an option_id", () => {
  assert.throws(() =>
    validateCustomFields([{ subview_field_id: def().id, option_id: "opt-1" }], [def()]),
  );
});

test("an answer naming a field outside this subview is refused", () => {
  assert.throws(
    () =>
      validateCustomFields(
        [{ subview_field_id: "22222222-2222-2222-2222-222222222222", value: 1 }],
        [def()],
      ),
    (err: AppError) => err.status === 400,
  );
});

test("two answers for the same field are refused", () => {
  assert.throws(
    () =>
      validateCustomFields(
        [
          { subview_field_id: def().id, value: 1 },
          { subview_field_id: def().id, value: 2 },
        ],
        [def()],
      ),
    (err: AppError) => err.status === 400,
  );
});

test("every failing answer is reported at once, not one per round trip", () => {
  const a = def({ id: "a", field_name: "a" });
  const b = def({ id: "b", field_name: "b" });

  try {
    validateCustomFields(
      [
        { subview_field_id: "a", value: "nope" },
        { subview_field_id: "b", value: "also nope" },
      ],
      [a, b],
    );
    assert.fail("expected a rejection");
  } catch (err) {
    assert.equal((err as AppError).details?.length, 2);
    assert.ok((err as AppError).details?.[1].startsWith("custom_fields.1"));
  }
});

test("no answers is valid — an item may record only a note", () => {
  assert.deepEqual(validateCustomFields([], [def()]), []);
});
