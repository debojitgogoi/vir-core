/**
 * Which validation rule a subview field's answers obey.
 *
 * `widget_types.name` is verbatim legacy text — `scripts/migrate-legacy-data.ts`
 * copies `UIComponent_Master.Name` unchanged — so nothing in this repository
 * enumerates the possible values. Matching is therefore best-effort by design:
 * an unrecognized name resolves to UNKNOWN and accepts any JSON scalar rather
 * than rejecting an answer a real inspector gave. Adding a name to the table
 * below is the whole cost of tightening one.
 *
 * The option check is deliberately not driven from here. Whether a field is
 * option-backed is answered objectively by whether it has
 * `subview_field_options` rows, so that half of the rule stays exact even when
 * the widget kind is UNKNOWN.
 */
export type WidgetKind = "NUMBER" | "DATE" | "BOOLEAN" | "TEXT" | "UNKNOWN";

/**
 * Uppercased with every non-alphanumeric character removed, so "Text Box",
 * "text_box" and "TextBox" are one key. Legacy names were typed by hand over
 * years and vary in exactly these ways.
 */
function normalize(name: string): string {
  return name.toUpperCase().replace(/[^A-Z0-9]/g, "");
}

const KINDS: Readonly<Record<string, WidgetKind>> = {
  NUMBER: "NUMBER",
  NUMBERBOX: "NUMBER",
  NUMERIC: "NUMBER",
  INTEGER: "NUMBER",
  DECIMAL: "NUMBER",

  DATE: "DATE",
  DATEPICKER: "DATE",
  DATEBOX: "DATE",

  CHECKBOX: "BOOLEAN",
  BOOLEAN: "BOOLEAN",
  TOGGLE: "BOOLEAN",
  SWITCH: "BOOLEAN",

  TEXT: "TEXT",
  TEXTBOX: "TEXT",
  TEXTAREA: "TEXT",
  TEXTFIELD: "TEXT",
  STRING: "TEXT",
  LABEL: "TEXT",
};

export function resolveWidgetKind(name: string): WidgetKind {
  return KINDS[normalize(name)] ?? "UNKNOWN";
}
