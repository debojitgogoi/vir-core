/**
 * Validating and snapshotting a line item's custom field answers.
 *
 * Pure: it takes the answers a client sent plus the field definitions loaded
 * for the item's subview, and returns what should be stored. Nothing here
 * touches the database, so the whole rule set is testable without one.
 *
 * The snapshot is the point. `field_name`, `label` and `widget` are copied
 * from master data at write time and never trusted from the client, so
 * renaming or deleting a field definition later cannot rewrite what a past
 * card says about a chassis.
 */

import { AppError, ERROR_CODES } from "../middleware/errors";
import { isRealCalendarDate } from "../utils/date";
import { resolveWidgetKind, WidgetKind } from "../utils/widgetKind";

export interface FieldOption {
  id: string;
  label_value: string;
}

export interface FieldDefinition {
  id: string;
  field_name: string;
  label: string;
  widget_type_name: string;
  options: FieldOption[];
}

/** What a client is permitted to say about one answer. */
export interface CustomFieldAnswerInput {
  subview_field_id: string;
  value?: unknown;
  option_id?: string | null;
}

/** What gets stored: the client's choice plus the server's snapshot of it. */
export interface CustomFieldAnswer {
  subview_field_id: string;
  field_name: string;
  label: string;
  widget: string;
  value: unknown;
  option_id: string | null;
}

const isScalar = (value: unknown): boolean =>
  value === null || ["string", "number", "boolean"].includes(typeof value);

type Coerced = { value: unknown } | { error: string };

function coerce(kind: WidgetKind, value: unknown): Coerced {
  if (value === undefined || value === null) return { value: null };

  switch (kind) {
    case "NUMBER": {
      // Number("") is 0 and Number(true) is 1; neither is an answer someone
      // gave, so both are refused before the finiteness check can bless them.
      if (typeof value === "boolean") return { error: "must be a number" };
      const text = typeof value === "number" ? value : String(value).trim();
      if (text === "") return { value: null };
      const parsed = Number(text);
      if (!Number.isFinite(parsed)) return { error: "must be a number" };
      return { value: parsed };
    }

    case "DATE": {
      if (typeof value !== "string" || !isRealCalendarDate(value)) {
        return { error: "must be a real calendar date in YYYY-MM-DD form" };
      }
      return { value };
    }

    case "BOOLEAN": {
      if (typeof value === "boolean") return { value };
      if (value === "true" || value === "false") return { value: value === "true" };
      return { error: "must be true or false" };
    }

    case "TEXT": {
      if (typeof value !== "string") return { error: "must be text" };
      const trimmed = value.trim();
      if (trimmed.length > 2000) return { error: "must be 2000 characters or fewer" };
      // Blank is an answer left alone, not an answer of "". The same rule the
      // intake schemas apply, so a query never has to test for both.
      return { value: trimmed.length === 0 ? null : trimmed };
    }

    default:
      // UNKNOWN: the widget name told us nothing, so accept any JSON scalar.
      // An object or array is still refused — custom_fields is a flat list of
      // answers, and nesting would defeat the GIN index the spec leaves room
      // for, as well as any reporting query that reads a value out.
      return isScalar(value)
        ? { value }
        : { error: "must be a text, number or boolean value" };
  }
}

/**
 * @throws AppError 400 VALIDATION_ERROR carrying **every** failing answer, not
 * just the first. A tablet uploading a filled form should learn all of what is
 * wrong in one round trip.
 */
export function validateCustomFields(
  answers: CustomFieldAnswerInput[],
  definitions: FieldDefinition[],
): CustomFieldAnswer[] {
  const byId = new Map(definitions.map((definition) => [definition.id, definition]));
  const violations: string[] = [];
  const seen = new Set<string>();
  const result: CustomFieldAnswer[] = [];

  answers.forEach((answer, index) => {
    // Dotted, matching what fromZod emits for a nested array index.
    const at = `custom_fields.${index}`;
    const definition = byId.get(answer.subview_field_id);

    if (!definition) {
      violations.push(`${at}.subview_field_id: no such field on this item's subview`);
      return;
    }
    if (seen.has(definition.id)) {
      violations.push(`${at}.subview_field_id: answered more than once`);
      return;
    }
    seen.add(definition.id);

    const optionId = answer.option_id ?? null;

    // Whether a field is option-backed is a fact about master data rather than
    // a guess from the widget's name, so this half of the rule stays exact
    // even for a widget kind we do not recognize.
    if (definition.options.length > 0) {
      const option = definition.options.find((candidate) => candidate.id === optionId);
      if (!option) {
        violations.push(`${at}.option_id: must be one of this field's options`);
        return;
      }
      result.push({
        subview_field_id: definition.id,
        field_name: definition.field_name,
        label: definition.label,
        widget: definition.widget_type_name,
        // Server-owned: the client chooses which option, never what it says.
        value: option.label_value,
        option_id: option.id,
      });
      return;
    }

    if (optionId !== null) {
      violations.push(`${at}.option_id: this field has no options`);
      return;
    }

    const coerced = coerce(resolveWidgetKind(definition.widget_type_name), answer.value);
    if ("error" in coerced) {
      violations.push(`${at}.value: ${coerced.error}`);
      return;
    }

    result.push({
      subview_field_id: definition.id,
      field_name: definition.field_name,
      label: definition.label,
      widget: definition.widget_type_name,
      value: coerced.value,
      option_id: null,
    });
  });

  if (violations.length > 0) {
    throw new AppError(
      400,
      "Custom field answers failed validation",
      violations,
      ERROR_CODES.VALIDATION_ERROR,
    );
  }

  return result;
}
