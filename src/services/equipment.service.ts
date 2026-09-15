import { AppError } from "../middleware/errors";
import {
  DamageCodeLookupDto,
  EquipmentCategoryDetailDto,
  EquipmentCategoryDto,
  EquipmentMainViewDto,
  EquipmentSubviewNodeDto,
  EquipmentTypeDetailsDto,
  ExtraFieldDto,
  QuickActionDto,
  RepairCodeLookupDto,
  WidgetTypeLookupDto,
} from "../types";
import * as equipmentRepo from "../db/equipment.repo";
import { MainViewRow, SubviewRow } from "../db/equipment.repo";
import {isValidSlugId} from "../utils/slug-id";

export async function listEquipmentCategoriesDto(): Promise<EquipmentCategoryDto[]> {
  const categories = await equipmentRepo.listEquipmentCategories();
  const categoryIds = categories.map((c) => c.id);

  const [prefixes, types] = await Promise.all([
    equipmentRepo.listEquipmentPrefixesForCategories(categoryIds),
    equipmentRepo.listEquipmentTypesForCategories(categoryIds),
  ]);

  return categories.map((category) => ({
    id: category.id,
    slug_id: category.slug_id,
    name: category.name,
    is_disabled: category.is_disabled,
    prefixes: prefixes
      .filter((p) => p.equipment_category_id === category.id)
      .map((p) => ({ id: p.id, prefix_name: p.prefix_name })),
    equipment_types: types
      .filter((t) => t.equipment_category_id === category.id)
      .map((t) => ({ id: t.id, slug_id: t.slug_id, name: t.name })),
  }));
}

export async function getEquipmentCategoryBySlugIdDto(
  slugId: string,
): Promise<EquipmentCategoryDetailDto> {
  const category = await equipmentRepo.getEquipmentCategoryBySlugId(slugId);
  if (!category) throw new AppError(404, "Equipment category not found");
  return {
    id: category.id,
    slug_id: category.slug_id,
    name: category.name,
    is_disabled: category.is_disabled,
  };
}

export async function getEquipmentTypeDetailsDto(
  idOrSlugId: string,
): Promise<EquipmentTypeDetailsDto> {
  // The path param may be the internal UUID or the public slug_id — resolve
  // it to the equipment type row first, since every query below (main views,
  // subviews, ...) is keyed off the internal id, not whichever identifier
  // the caller used.
  const equipmentType = isValidSlugId(idOrSlugId)
    ? await equipmentRepo.getEquipmentTypeBySlugId(idOrSlugId)
    : await equipmentRepo.getEquipmentType(idOrSlugId);
  if (!equipmentType) throw new AppError(404, "Equipment type not found");

  const mainViews = await equipmentRepo.listMainViewsForType(equipmentType.id);

  // Stage 2: depends on stage 1's main view ids.
  const mainViewIds = mainViews.map((mv) => mv.id);
  const subviews = await equipmentRepo.listSubviewsForMainViews(mainViewIds);
  const subviewIds = subviews.map((sv) => sv.id);

  // Stage 3: every query here depends only on mainViewIds/subviewIds, so they
  // all run in one batch (field options join through subview_id rather than
  // field id, so it doesn't have to wait on the fields query below).
  const [damageCodes, repairCodes, quickActions, fields, fieldOptions] = await Promise.all([
    equipmentRepo.listDamageCodesForSubviews(subviewIds),
    equipmentRepo.listRepairCodesForSubviews(subviewIds),
    equipmentRepo.listQuickActionsForViews(mainViewIds, subviewIds),
    equipmentRepo.listFieldsForSubviews(subviewIds),
    equipmentRepo.listFieldOptionsForSubviews(subviewIds),
  ]);

  // Normalized lookups: dedupe straight from the flat rows we already have,
  // so each damage/repair code or widget type appears once in the response
  // no matter how many nodes reference it.
  const damageCodeLookup: Record<string, DamageCodeLookupDto> = {};
  for (const d of damageCodes) {
    damageCodeLookup[d.id] ??= { damage_code: d.damage_code, damage_description: d.damage_description };
  }
  const repairCodeLookup: Record<string, RepairCodeLookupDto> = {};
  for (const r of repairCodes) {
    repairCodeLookup[r.id] ??= { repair_code: r.repair_code, repair_description: r.repair_description };
  }
  const widgetTypeLookup: Record<string, WidgetTypeLookupDto> = {};
  for (const f of fields) {
    widgetTypeLookup[f.widget_type_id] ??= { name: f.widget_type_name };
  }

  // Index everything by parent id for O(1) lookup while walking the tree.
  const damageIdsBySubview = groupBy(damageCodes, (d) => d.subview_id);
  const repairIdsBySubview = groupBy(repairCodes, (r) => r.subview_id);
  const quickActionsByMainView = groupBy(
    quickActions.filter((qa) => qa.main_view_id !== null),
    (qa) => qa.main_view_id as string,
  );
  const quickActionsBySubview = groupBy(
    quickActions.filter((qa) => qa.subview_id !== null),
    (qa) => qa.subview_id as string,
  );
  const optionsByField = groupBy(fieldOptions, (o) => o.subview_field_id);
  const fieldsBySubview = groupBy(fields, (f) => f.subview_id);
  const childSubviewsByParent = groupBy(
    subviews.filter((sv) => sv.parent_subview_id !== null),
    (sv) => sv.parent_subview_id as string,
  );
  const rootSubviewsByMainView = groupBy(
    subviews.filter((sv) => sv.parent_subview_id === null),
    (sv) => sv.main_view_id,
  );

  function toFieldDtos(subviewId: string): ExtraFieldDto[] {
    return (fieldsBySubview[subviewId] ?? []).map((f) => ({
      id: f.id,
      label: f.label,
      field_name: f.field_name,
      display_order: f.display_order,
      widget_type_id: f.widget_type_id,
      options: (optionsByField[f.id] ?? []).map((o) => ({
        id: o.id,
        label_value: o.label_value,
        display_order: o.display_order,
      })),
    }));
  }

  function toQuickActionDtos(rows: equipmentRepo.QuickActionRow[]): QuickActionDto[] {
    return rows.map((qa) => ({
      id: qa.id,
      action_name: qa.action_name,
      repair_code_id: qa.repair_code_id,
      component_id: qa.component_id,
    }));
  }

  function buildSubviewNode(subview: SubviewRow): EquipmentSubviewNodeDto {
    return {
      id: subview.id,
      slug_id: subview.slug_id,
      name: subview.name,
      header: subview.header,
      component_id: subview.component_id,
      children: (childSubviewsByParent[subview.id] ?? []).map(buildSubviewNode),
      damage_code_ids: (damageIdsBySubview[subview.id] ?? []).map((d) => d.id),
      repair_code_ids: (repairIdsBySubview[subview.id] ?? []).map((r) => r.id),
      quick_actions: toQuickActionDtos(quickActionsBySubview[subview.id] ?? []),
      fields: toFieldDtos(subview.id),
    };
  }

  function buildMainViewNode(mainView: MainViewRow): EquipmentMainViewDto {
    return {
      id: mainView.id,
      slug_id: mainView.slug_id,
      name: mainView.name,
      bubble_name: mainView.bubble_name,
      label_name: mainView.label_name,
      sequence_number: mainView.sequence_number,
      quick_actions: toQuickActionDtos(quickActionsByMainView[mainView.id] ?? []),
      children: (rootSubviewsByMainView[mainView.id] ?? []).map(buildSubviewNode),
    };
  }

  return {
    id: equipmentType.id,
    slug_id: equipmentType.slug_id,
    equipment_category_id: equipmentType.equipment_category_id,
    name: equipmentType.name,
    is_disabled: equipmentType.is_disabled,
    damage_codes: damageCodeLookup,
    repair_codes: repairCodeLookup,
    widget_types: widgetTypeLookup,
    main_views: mainViews.map(buildMainViewNode),
  };
}

function groupBy<T, K extends string>(rows: T[], keyOf: (row: T) => K): Record<K, T[]> {
  const result = {} as Record<K, T[]>;
  for (const row of rows) {
    const key = keyOf(row);
    (result[key] ??= []).push(row);
  }
  return result;
}
