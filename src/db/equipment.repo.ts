import { pool } from "./pool";
import { isValidSlugId } from "../utils/slug-id";

export interface EquipmentCategoryRow {
  id: string;
  slug_id: string;
  name: string;
  is_disabled: boolean;
}

export interface EquipmentPrefixRow {
  id: string;
  equipment_category_id: string;
  prefix_name: string;
}

export interface EquipmentTypeRow {
  id: string;
  slug_id: string;
  equipment_category_id: string;
  name: string;
  is_disabled: boolean;
}

export interface MainViewRow {
  id: string;
  slug_id: string;
  equipment_type_id: string;
  name: string;
  bubble_name: string | null;
  label_name: string | null;
  sequence_number: number | null;
  is_disabled: boolean;
}

export interface SubviewRow {
  id: string;
  slug_id: string;
  main_view_id: string;
  parent_subview_id: string | null;
  component_id: string | null;
  name: string;
  header: string | null;
  is_disabled: boolean;
}

export async function getEquipmentCategoryBySlugId(
  slug_id: string,
): Promise<EquipmentCategoryRow | null> {
  if (!isValidSlugId(slug_id)) return null;

  const { rows } = await pool.query<EquipmentCategoryRow>(
    `SELECT id, slug_id, name, is_disabled
     FROM equipment_categories
     WHERE slug_id = $1`,
    [slug_id],
  );
  return rows[0] ?? null;
}

export interface DamageCodeRow {
  subview_id: string;
  id: string;
  damage_code: string;
  damage_description: string | null;
}

export interface RepairCodeRow {
  subview_id: string;
  id: string;
  repair_code: string;
  repair_description: string | null;
}

export interface QuickActionRow {
  id: string;
  action_name: string;
  repair_code_id: string | null;
  component_id: string | null;
  main_view_id: string | null;
  subview_id: string | null;
}

export interface SubviewFieldOptionRow {
  id: string;
  subview_field_id: string;
  label_value: string;
  display_order: number;
}

export interface SubviewFieldRow {
  id: string;
  subview_id: string;
  label: string;
  field_name: string;
  display_order: number;
  widget_type_id: string;
  widget_type_name: string;
}

export async function listEquipmentCategories(): Promise<EquipmentCategoryRow[]> {
  const { rows } = await pool.query<EquipmentCategoryRow>(
    `SELECT id, slug_id, name, is_disabled
     FROM equipment_categories
     WHERE is_disabled = false
     ORDER BY name`,
  );
  return rows;
}

export async function listEquipmentPrefixesForCategories(
  categoryIds: string[],
): Promise<EquipmentPrefixRow[]> {
  if (categoryIds.length === 0) return [];
  const { rows } = await pool.query<EquipmentPrefixRow>(
    `SELECT id, equipment_category_id, prefix_name
     FROM equipment_prefixes
     WHERE equipment_category_id = ANY($1::uuid[])
     ORDER BY prefix_name`,
    [categoryIds],
  );
  return rows;
}

/** A single prefix, for cross-checking against the equipment type a job card names. */
export async function getEquipmentPrefix(id: string): Promise<EquipmentPrefixRow | null> {
  const { rows } = await pool.query<EquipmentPrefixRow>(
    `SELECT id, equipment_category_id, prefix_name
     FROM equipment_prefixes
     WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function listEquipmentTypesForCategories(
  categoryIds: string[],
): Promise<EquipmentTypeRow[]> {
  if (categoryIds.length === 0) return [];
  const { rows } = await pool.query<EquipmentTypeRow>(
    `SELECT id, slug_id, equipment_category_id, name, is_disabled
     FROM equipment_types
     WHERE equipment_category_id = ANY($1::uuid[]) AND is_disabled = false
     ORDER BY name`,
    [categoryIds],
  );
  return rows;
}

export async function getEquipmentType(id: string): Promise<EquipmentTypeRow | null> {
  const { rows } = await pool.query<EquipmentTypeRow>(
    `SELECT id, slug_id, equipment_category_id, name, is_disabled
     FROM equipment_types
     WHERE id = $1`,
    [id],
  );
  return rows[0] ?? null;
}

export async function getEquipmentTypeBySlugId(
  slug_id: string,
): Promise<EquipmentTypeRow | null> {
  if (!isValidSlugId(slug_id)) return null;

  const { rows } = await pool.query<EquipmentTypeRow>(
    `SELECT id, slug_id, equipment_category_id, name, is_disabled
     FROM equipment_types
     WHERE slug_id = $1`,
    [slug_id],
  );
  return rows[0] ?? null;
}

export async function listMainViewsForType(equipmentTypeId: string): Promise<MainViewRow[]> {
  const { rows } = await pool.query<MainViewRow>(
    `SELECT id, slug_id, equipment_type_id, name, bubble_name, label_name, sequence_number, is_disabled
     FROM main_views
     WHERE equipment_type_id = $1 AND is_disabled = false
     ORDER BY sequence_number NULLS LAST, name`,
    [equipmentTypeId],
  );
  return rows;
}

export async function listSubviewsForMainViews(mainViewIds: string[]): Promise<SubviewRow[]> {
  if (mainViewIds.length === 0) return [];
  const { rows } = await pool.query<SubviewRow>(
    `SELECT id, slug_id, main_view_id, parent_subview_id, component_id, name, header, is_disabled
     FROM subviews
     WHERE main_view_id = ANY($1::uuid[]) AND is_disabled = false
     ORDER BY name`,
    [mainViewIds],
  );
  return rows;
}

export async function listDamageCodesForSubviews(subviewIds: string[]): Promise<DamageCodeRow[]> {
  if (subviewIds.length === 0) return [];
  const { rows } = await pool.query<DamageCodeRow>(
    `SELECT sd.subview_id, dc.id, dc.damage_code, dc.damage_description
     FROM subview_damages sd
     JOIN damage_codes dc ON dc.id = sd.damage_code_id
     WHERE sd.subview_id = ANY($1::uuid[]) AND dc.is_disabled = false
     ORDER BY dc.damage_code`,
    [subviewIds],
  );
  return rows;
}

export async function listRepairCodesForSubviews(subviewIds: string[]): Promise<RepairCodeRow[]> {
  if (subviewIds.length === 0) return [];
  const { rows } = await pool.query<RepairCodeRow>(
    `SELECT sr.subview_id, rc.id, rc.repair_code, rc.repair_description
     FROM subview_repairs sr
     JOIN repair_codes rc ON rc.id = sr.repair_code_id
     WHERE sr.subview_id = ANY($1::uuid[]) AND rc.is_disabled = false
     ORDER BY rc.repair_code`,
    [subviewIds],
  );
  return rows;
}

export async function listQuickActionsForViews(
  mainViewIds: string[],
  subviewIds: string[],
): Promise<QuickActionRow[]> {
  if (mainViewIds.length === 0 && subviewIds.length === 0) return [];
  const { rows } = await pool.query<QuickActionRow>(
    `SELECT id, action_name, repair_code_id, component_id, main_view_id, subview_id
     FROM quick_actions
     WHERE is_disabled = false
       AND (main_view_id = ANY($1::uuid[]) OR subview_id = ANY($2::uuid[]))
     ORDER BY action_name`,
    [mainViewIds, subviewIds],
  );
  return rows;
}

export async function listFieldsForSubviews(subviewIds: string[]): Promise<SubviewFieldRow[]> {
  if (subviewIds.length === 0) return [];
  const { rows } = await pool.query<SubviewFieldRow>(
    `SELECT sf.id, sf.subview_id, sf.label, sf.field_name, sf.display_order,
            wt.id AS widget_type_id, wt.name AS widget_type_name
     FROM subview_fields sf
     JOIN widget_types wt ON wt.id = sf.widget_type_id
     WHERE sf.subview_id = ANY($1::uuid[])
     ORDER BY sf.display_order, sf.label`,
    [subviewIds],
  );
  return rows;
}

// Joins through subview_fields.subview_id (rather than taking field ids
// directly) so this query only depends on subviewIds — letting it run
// alongside the other subview-keyed detail queries instead of waiting on
// the fields query to resolve first.
export async function listFieldOptionsForSubviews(
  subviewIds: string[],
): Promise<SubviewFieldOptionRow[]> {
  if (subviewIds.length === 0) return [];
  const { rows } = await pool.query<SubviewFieldOptionRow>(
    `SELECT o.id, o.subview_field_id, o.label_value, o.display_order
     FROM subview_field_options o
     JOIN subview_fields sf ON sf.id = o.subview_field_id
     WHERE sf.subview_id = ANY($1::uuid[])
     ORDER BY o.display_order, o.label_value`,
    [subviewIds],
  );
  return rows;
}
