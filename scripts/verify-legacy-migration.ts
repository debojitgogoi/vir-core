import path from "path";
import { DatabaseSync } from "node:sqlite";

/**
 * Read-only migration audit: vir.sqlite (source) vs Postgres (target).
 *
 * - Opens vir.sqlite with readOnly: true.
 * - Opens a Postgres transaction with `BEGIN TRANSACTION READ ONLY` and
 *   always ROLLBACKs at the end (belt-and-suspenders: no statement in this
 *   file is anything but SELECT).
 * - Independently re-derives, from the raw legacy rows, which rows should
 *   have migrated / been skipped / been nulled, per the rules in
 *   legacy_data/migrated_db_structure/migration-plan.md — it does NOT
 *   trust legacy_data/migration-exceptions.md as ground truth, only uses
 *   it as a secondary cross-check.
 * - `Prefix_Master` / `equipment_prefixes` is excluded from scope per the
 *   request.
 * - Comparison direction: driven by what's actually IN the Postgres schema,
 *   never by what's in vir.sqlite. Legacy columns the migration plan
 *   deliberately dropped (image paths, hotspot/bubble coordinates, cost/time
 *   fields — migration-plan.md §4.1) have no Postgres column to compare
 *   against and are correctly never checked; they must never surface as a
 *   "missing"/"mismatch" finding. Each table's real Postgres column list is
 *   fetched from information_schema (`pgColumnNames`) and every column found
 *   there — other than pure infra (`id`, `legacy_id`, `created_at`,
 *   `updated_at`) — is asserted to have been compared (`assertCovered`); if
 *   Postgres ever grows a column this script's hand-written checks don't
 *   know about yet, that's surfaced as a "column not compared" finding
 *   instead of silently skipping it.
 *
 * Usage: npm run verify:legacy-migration  (see package.json)
 */

const SQLITE_PATH = path.join(__dirname, "..", "legacy_data", "vir.sqlite");

interface Finding {
  table: string;
  kind: string;
  detail: string;
}
const findings: Finding[] = [];
function report(table: string, kind: string, detail: string) {
  findings.push({ table, kind, detail });
}

function rowsOf(db: InstanceType<typeof DatabaseSync>, sql: string): any[] {
  return db.prepare(sql).all() as any[];
}

// Legacy IsDisabled is blank/NULL for every row in the current data (verified
// directly against vir.sqlite), which is why the migration script hardcodes
// `false` rather than reading the column. Deriving the expected value from
// the raw source here (instead of assuming "always false") keeps this a real
// check of vir.sqlite's values, not a restatement of the migration plan.
function expectDisabled(raw: unknown): boolean {
  return raw === 1 || raw === true || raw === "1" || raw === "true" || raw === "TRUE";
}

async function main(): Promise<void> {
  const db = new DatabaseSync(SQLITE_PATH, { readOnly: true });

  const { pool } = await import("../src/db/pool");
  const client = await pool.connect();
  await client.query("BEGIN TRANSACTION READ ONLY");

  try {
    // ---- Column coverage tracking: the audit is driven by what's actually
    // in the Postgres schema, never by what's in vir.sqlite. A legacy column
    // the migration plan deliberately dropped (§4.1) has no Postgres column
    // to compare against, so it's simply absent from `pgColumnNames` below
    // and never generates a finding. `assertCovered` is the other half: it
    // catches the opposite mistake — a real Postgres column this script
    // forgot to check.
    const INFRA_COLUMNS = new Set(["id", "legacy_id", "created_at", "updated_at"]);
    async function pgColumnNames(table: string): Promise<Set<string>> {
      const { rows } = await client.query(
        "SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = $1",
        [table],
      );
      return new Set(rows.map((r: any) => r.column_name as string));
    }
    function assertCovered(table: string, allColumns: Set<string>, comparedColumns: string[]) {
      const compared = new Set(comparedColumns);
      for (const col of allColumns) {
        if (INFRA_COLUMNS.has(col)) continue;
        if (!compared.has(col)) {
          report(table, "column not compared", `Postgres column '${col}' exists but this audit has no check for it`);
        }
      }
    }

    // ---- Load every Postgres table we care about, keyed by legacy_id ----
    // SELECT * (not a hand-picked list) so the row data always reflects the
    // real, current Postgres schema — `assertCovered` then confirms every
    // column it returns was actually checked.
    async function pgByLegacyId(table: string): Promise<{ map: Map<number, any>; columns: Set<string> }> {
      const columns = await pgColumnNames(table);
      const { rows } = await client.query(`SELECT * FROM ${table}`);
      const map = new Map<number, any>();
      for (const r of rows) {
        if (r.legacy_id === null) continue; // rows with no legacy origin, not in scope
        const key = Number(r.legacy_id);
        if (map.has(key)) {
          report(table, "duplicate legacy_id in Postgres", `legacy_id ${key} appears more than once`);
        }
        map.set(key, r);
      }
      return { map, columns };
    }

    const { map: pgCategories, columns: pgCategoriesCols } = await pgByLegacyId("equipment_categories");
    const { map: pgTypes, columns: pgTypesCols } = await pgByLegacyId("equipment_types");
    const { map: pgMainViews, columns: pgMainViewsCols } = await pgByLegacyId("main_views");
    const { map: pgSubviews, columns: pgSubviewsCols } = await pgByLegacyId("subviews");
    const { map: pgComponents, columns: pgComponentsCols } = await pgByLegacyId("components");
    const { map: pgDamageCodes, columns: pgDamageCodesCols } = await pgByLegacyId("damage_codes");
    const { map: pgRepairCodes, columns: pgRepairCodesCols } = await pgByLegacyId("repair_codes");
    const { map: pgSubviewDamages, columns: pgSubviewDamagesCols } = await pgByLegacyId("subview_damages");
    const { map: pgSubviewRepairs, columns: pgSubviewRepairsCols } = await pgByLegacyId("subview_repairs");
    const { map: pgMiscItems, columns: pgMiscItemsCols } = await pgByLegacyId("misc_items");
    const { map: pgMainViewMisc, columns: pgMainViewMiscCols } = await pgByLegacyId("main_view_misc_items");
    const { map: pgMainViewComponents, columns: pgMainViewComponentsCols } =
      await pgByLegacyId("main_view_components");
    const { map: pgWidgetTypes, columns: pgWidgetTypesCols } = await pgByLegacyId("widget_types");
    const { map: pgSubviewFields, columns: pgSubviewFieldsCols } = await pgByLegacyId("subview_fields");
    const { map: pgSubviewFieldOptions, columns: pgSubviewFieldOptionsCols } =
      await pgByLegacyId("subview_field_options");
    const { map: pgQuickActions, columns: pgQuickActionsCols } = await pgByLegacyId("quick_actions");

    // -------------------------------------------------------------------
    // 1. EquipmentType -> equipment_categories (1:1, no exclusions)
    // -------------------------------------------------------------------
    {
      const table = "EquipmentType -> equipment_categories";
      const legacy = rowsOf(db, "SELECT * FROM EquipmentType");
      for (const r of legacy) {
        const pg = pgCategories.get(r.ID);
        if (!pg) {
          report(table, "missing row", `legacy ID ${r.ID} ('${r.EquipmentType}') not found in Postgres`);
          continue;
        }
        if (pg.name !== r.EquipmentType) {
          report(table, "value mismatch", `legacy ID ${r.ID}: name '${pg.name}' !== legacy '${r.EquipmentType}'`);
        }
        const expectDisabledVal = expectDisabled(r.IsDisabled);
        if (pg.is_disabled !== expectDisabledVal) {
          report(table, "value mismatch", `legacy ID ${r.ID}: is_disabled '${pg.is_disabled}' !== expected '${expectDisabledVal}' (legacy IsDisabled='${r.IsDisabled}')`);
        }
      }
      for (const legacyId of pgCategories.keys()) {
        if (!legacy.some((r) => r.ID === legacyId)) {
          report(table, "extra row", `Postgres legacy_id ${legacyId} has no source row in EquipmentType`);
        }
      }
      assertCovered(table, pgCategoriesCols, ["name", "is_disabled"]);
    }

    // -------------------------------------------------------------------
    // 2. EquipmentSubType -> equipment_types
    // -------------------------------------------------------------------
    {
      const table = "EquipmentSubType -> equipment_types";
      const legacy = rowsOf(db, "SELECT * FROM EquipmentSubType");
      for (const r of legacy) {
        const expectCategoryId = pgCategories.get(r.EquipmentTypeID_FK)?.id ?? null;
        const pg = pgTypes.get(r.ID);
        if (!expectCategoryId) {
          if (pg) report(table, "unexpected row", `legacy ID ${r.ID}: orphaned FK ${r.EquipmentTypeID_FK} but row exists in Postgres`);
          continue;
        }
        if (!pg) {
          report(table, "missing row", `legacy ID ${r.ID} not found in Postgres`);
          continue;
        }
        const expectName = String(r.EquipmentSubTypeName).replace(/’/g, "ft");
        if (pg.name !== expectName) {
          report(table, "value mismatch", `legacy ID ${r.ID}: name '${pg.name}' !== expected '${expectName}'`);
        }
        if (pg.equipment_category_id !== expectCategoryId) {
          report(table, "FK mismatch", `legacy ID ${r.ID}: equipment_category_id does not resolve to legacy category ${r.EquipmentTypeID_FK}`);
        }
        const expectDisabledVal = expectDisabled(r.IsDisabled);
        if (pg.is_disabled !== expectDisabledVal) {
          report(table, "value mismatch", `legacy ID ${r.ID}: is_disabled '${pg.is_disabled}' !== expected '${expectDisabledVal}' (legacy IsDisabled='${r.IsDisabled}')`);
        }
      }
      for (const legacyId of pgTypes.keys()) {
        if (!legacy.some((r) => r.ID === legacyId)) {
          report(table, "extra row", `Postgres legacy_id ${legacyId} has no source row in EquipmentSubType`);
        }
      }
      assertCovered(table, pgTypesCols, ["equipment_category_id", "name", "is_disabled"]);
    }

    // -------------------------------------------------------------------
    // (Prefix_Master -> equipment_prefixes intentionally excluded from scope)
    // -------------------------------------------------------------------

    // -------------------------------------------------------------------
    // 3. Component_Master -> components
    // -------------------------------------------------------------------
    {
      const table = "Component_Master -> components";
      const legacy = rowsOf(db, "SELECT * FROM Component_Master");
      for (const r of legacy) {
        const pg = pgComponents.get(r.ID);
        if (!pg) {
          report(table, "missing row", `legacy ID ${r.ID} not found in Postgres`);
          continue;
        }
        if (pg.component_code !== r.ComponentCode) {
          report(table, "value mismatch", `legacy ID ${r.ID}: component_code '${pg.component_code}' !== '${r.ComponentCode}'`);
        }
        if ((pg.component_description ?? null) !== (r.ComponentDesc ?? null)) {
          report(table, "value mismatch", `legacy ID ${r.ID}: component_description differs`);
        }
        if (pg.is_disabled !== false) {
          report(table, "value mismatch", `legacy ID ${r.ID}: is_disabled should be false (no legacy source), got ${pg.is_disabled}`);
        }
      }
      if (legacy.length !== pgComponents.size) {
        report(table, "count mismatch", `legacy ${legacy.length} rows vs Postgres ${pgComponents.size} rows`);
      }
      assertCovered(table, pgComponentsCols, ["component_code", "component_description", "is_disabled"]);
    }

    // -------------------------------------------------------------------
    // 4. EquipmentMainView -> main_views
    // -------------------------------------------------------------------
    {
      const table = "EquipmentMainView -> main_views";
      const legacy = rowsOf(db, "SELECT * FROM EquipmentMainView");
      for (const r of legacy) {
        const expectTypeId = pgTypes.get(r.EquipmentSubTypeID_FK)?.id ?? null;
        const pg = pgMainViews.get(r.ID);
        if (!expectTypeId) {
          if (pg) report(table, "unexpected row", `legacy ID ${r.ID}: orphaned FK but row exists in Postgres`);
          continue;
        }
        if (!pg) {
          report(table, "missing row", `legacy ID ${r.ID} not found in Postgres`);
          continue;
        }
        if (pg.equipment_type_id !== expectTypeId) {
          report(table, "FK mismatch", `legacy ID ${r.ID}: equipment_type_id does not resolve correctly`);
        }
        if (pg.name !== r.Name) report(table, "value mismatch", `legacy ID ${r.ID}: name differs`);
        if ((pg.bubble_name ?? null) !== (r.BubbleName ?? null)) report(table, "value mismatch", `legacy ID ${r.ID}: bubble_name differs`);
        if ((pg.label_name ?? null) !== (r.LabelName ?? null)) report(table, "value mismatch", `legacy ID ${r.ID}: label_name differs`);
        if ((pg.sequence_number ?? null) !== (r.SequenceNumber ?? null)) report(table, "value mismatch", `legacy ID ${r.ID}: sequence_number differs`);
        const expectDisabledVal = expectDisabled(r.IsDisabled);
        if (pg.is_disabled !== expectDisabledVal) report(table, "value mismatch", `legacy ID ${r.ID}: is_disabled '${pg.is_disabled}' !== expected '${expectDisabledVal}' (legacy IsDisabled='${r.IsDisabled}')`);
      }
      for (const legacyId of pgMainViews.keys()) {
        if (!legacy.some((r) => r.ID === legacyId)) report(table, "extra row", `Postgres legacy_id ${legacyId} has no source row`);
      }
      assertCovered(table, pgMainViewsCols, [
        "equipment_type_id",
        "name",
        "bubble_name",
        "label_name",
        "sequence_number",
        "is_disabled",
      ]);
    }

    // -------------------------------------------------------------------
    // 5. EquipmentSubView -> subviews (two-pass parent resolution)
    // -------------------------------------------------------------------
    {
      const table = "EquipmentSubView -> subviews";
      const legacy = rowsOf(db, "SELECT * FROM EquipmentSubView");
      const legacyById = new Map<number, any>(legacy.map((r) => [r.ID, r]));
      for (const r of legacy) {
        const expectMainViewId = pgMainViews.get(r.EquipmentMainViewID_FK)?.id ?? null;
        const pg = pgSubviews.get(r.ID);
        if (!expectMainViewId) {
          if (pg) report(table, "unexpected row", `legacy ID ${r.ID}: main view orphaned but row exists`);
          continue;
        }
        if (!pg) {
          report(table, "missing row", `legacy ID ${r.ID} not found in Postgres`);
          continue;
        }
        if (pg.main_view_id !== expectMainViewId) {
          report(table, "FK mismatch", `legacy ID ${r.ID}: main_view_id does not resolve correctly`);
        }
        // component_id: 0/-1/NULL are sentinels -> NULL; 374 is the one
        // documented genuine orphan -> NULL; anything else must resolve.
        if (r.ComponentID_FK !== 0 && r.ComponentID_FK !== -1 && r.ComponentID_FK !== null) {
          const expectComponentId = pgComponents.get(r.ComponentID_FK)?.id ?? null;
          if (expectComponentId && pg.component_id !== expectComponentId) {
            report(table, "FK mismatch", `legacy ID ${r.ID}: component_id does not resolve to legacy component ${r.ComponentID_FK}`);
          }
          if (!expectComponentId && pg.component_id !== null) {
            report(table, "FK mismatch", `legacy ID ${r.ID}: ComponentID_FK ${r.ComponentID_FK} is an orphan but component_id is not NULL`);
          }
        } else if (pg.component_id !== null) {
          report(table, "FK mismatch", `legacy ID ${r.ID}: sentinel ComponentID_FK ${r.ComponentID_FK} but component_id is not NULL`);
        }
        // parent_subview_id
        if (r.ParentID && r.ParentID !== 0) {
          const parentLegacy = legacyById.get(r.ParentID);
          const parentPg = parentLegacy ? pgSubviews.get(parentLegacy.ID) : undefined;
          if (parentPg && pg.parent_subview_id !== parentPg.id) {
            report(table, "FK mismatch", `legacy ID ${r.ID}: parent_subview_id does not resolve to legacy parent ${r.ParentID}`);
          }
          if (!parentPg && pg.parent_subview_id !== null) {
            report(table, "FK mismatch", `legacy ID ${r.ID}: ParentID ${r.ParentID} does not resolve but parent_subview_id is not NULL`);
          }
        } else if (pg.parent_subview_id !== null) {
          report(table, "FK mismatch", `legacy ID ${r.ID}: ParentID unset but parent_subview_id is not NULL`);
        }
        if (pg.name !== r.Name) report(table, "value mismatch", `legacy ID ${r.ID}: name differs`);
        if ((pg.header ?? null) !== (r.Header ?? null)) report(table, "value mismatch", `legacy ID ${r.ID}: header differs`);
        const expectDisabledVal = expectDisabled(r.IsDisabled);
        if (pg.is_disabled !== expectDisabledVal) report(table, "value mismatch", `legacy ID ${r.ID}: is_disabled '${pg.is_disabled}' !== expected '${expectDisabledVal}' (legacy IsDisabled='${r.IsDisabled}')`);
      }
      for (const legacyId of pgSubviews.keys()) {
        if (!legacyById.has(legacyId)) report(table, "extra row", `Postgres legacy_id ${legacyId} has no source row`);
      }
      assertCovered(table, pgSubviewsCols, [
        "main_view_id",
        "parent_subview_id",
        "component_id",
        "name",
        "header",
        "is_disabled",
      ]);
    }

    // -------------------------------------------------------------------
    // 6. Damage_MST -> damage_codes
    // -------------------------------------------------------------------
    {
      const table = "Damage_MST -> damage_codes";
      const legacy = rowsOf(db, "SELECT * FROM Damage_MST");
      for (const r of legacy) {
        const pg = pgDamageCodes.get(r.ID);
        if (!pg) { report(table, "missing row", `legacy ID ${r.ID} not found in Postgres`); continue; }
        if (pg.damage_code !== r.DamageCode) report(table, "value mismatch", `legacy ID ${r.ID}: damage_code differs`);
        if ((pg.damage_description ?? null) !== (r.DamageDesc ?? null)) report(table, "value mismatch", `legacy ID ${r.ID}: damage_description differs`);
        if (pg.is_disabled !== false) report(table, "value mismatch", `legacy ID ${r.ID}: is_disabled should be false (no legacy source column), got ${pg.is_disabled}`);
      }
      if (legacy.length !== pgDamageCodes.size) report(table, "count mismatch", `legacy ${legacy.length} vs Postgres ${pgDamageCodes.size}`);
      assertCovered(table, pgDamageCodesCols, ["damage_code", "damage_description", "is_disabled"]);
    }

    // -------------------------------------------------------------------
    // 7. Repairs_MST -> repair_codes (2 documented renames: 80->RN, 84->PE)
    // -------------------------------------------------------------------
    {
      const table = "Repairs_MST -> repair_codes";
      const RENAMES: Record<number, string> = { 80: "RN", 84: "PE" };
      const legacy = rowsOf(db, "SELECT * FROM Repairs_MST");
      for (const r of legacy) {
        const pg = pgRepairCodes.get(r.ID);
        if (!pg) { report(table, "missing row", `legacy ID ${r.ID} not found in Postgres`); continue; }
        const expectCode = RENAMES[r.ID] ?? r.RepairCode;
        if (pg.repair_code !== expectCode) {
          report(table, "value mismatch", `legacy ID ${r.ID}: repair_code '${pg.repair_code}' !== expected '${expectCode}'`);
        }
        if ((pg.repair_description ?? null) !== (r.RepairDesc ?? null)) report(table, "value mismatch", `legacy ID ${r.ID}: repair_description differs`);
        if (pg.is_disabled !== false) report(table, "value mismatch", `legacy ID ${r.ID}: is_disabled should be false (no legacy source column), got ${pg.is_disabled}`);
      }
      if (legacy.length !== pgRepairCodes.size) report(table, "count mismatch", `legacy ${legacy.length} vs Postgres ${pgRepairCodes.size}`);
      assertCovered(table, pgRepairCodesCols, ["repair_code", "repair_description", "is_disabled"]);
    }

    // -------------------------------------------------------------------
    // 8. EquipmentSubView_Damage -> subview_damages (-1 sentinel skipped,
    //    dedup (subview,damage) pairs keeping lower legacy ID)
    // -------------------------------------------------------------------
    {
      const table = "EquipmentSubView_Damage -> subview_damages";
      const legacy = (rowsOf(db, "SELECT * FROM EquipmentSubView_Damage") as any[]).sort((a, b) => a.ID - b.ID);
      const seen = new Set<string>();
      let expectedCount = 0;
      for (const r of legacy) {
        const pg = pgSubviewDamages.get(r.ID);
        if (r.DamageID_FK === -1) {
          if (pg) report(table, "unexpected row", `legacy ID ${r.ID}: sentinel -1 but row exists in Postgres`);
          continue;
        }
        const subviewId = pgSubviews.get(r.EquipmentSubViewID_FK)?.id;
        const damageId = pgDamageCodes.get(r.DamageID_FK)?.id;
        if (!subviewId || !damageId) {
          if (pg) report(table, "unexpected row", `legacy ID ${r.ID}: orphaned FK but row exists in Postgres`);
          continue;
        }
        const pairKey = `${r.EquipmentSubViewID_FK}::${r.DamageID_FK}`;
        if (seen.has(pairKey)) {
          if (pg) report(table, "unexpected row", `legacy ID ${r.ID}: duplicate pair should have been skipped but row exists`);
          continue;
        }
        seen.add(pairKey);
        expectedCount += 1;
        if (!pg) { report(table, "missing row", `legacy ID ${r.ID} not found in Postgres`); continue; }
        if (pg.subview_id !== subviewId || pg.damage_code_id !== damageId) {
          report(table, "FK mismatch", `legacy ID ${r.ID}: subview_id/damage_code_id does not resolve correctly`);
        }
      }
      if (expectedCount !== pgSubviewDamages.size) {
        report(table, "count mismatch", `expected ${expectedCount} migrated rows vs Postgres ${pgSubviewDamages.size}`);
      }
      assertCovered(table, pgSubviewDamagesCols, ["subview_id", "damage_code_id"]);
    }

    // -------------------------------------------------------------------
    // 9. EquipmentSubView_Repair -> subview_repairs (-1 sentinel skipped)
    // -------------------------------------------------------------------
    {
      const table = "EquipmentSubView_Repair -> subview_repairs";
      const legacy = rowsOf(db, "SELECT * FROM EquipmentSubView_Repair");
      let expectedCount = 0;
      for (const r of legacy) {
        const pg = pgSubviewRepairs.get(r.ID);
        if (r.RepairID_FK === -1) {
          if (pg) report(table, "unexpected row", `legacy ID ${r.ID}: sentinel -1 but row exists in Postgres`);
          continue;
        }
        const subviewId = pgSubviews.get(r.EquipmentSubViewID_FK)?.id;
        const repairId = pgRepairCodes.get(r.RepairID_FK)?.id;
        if (!subviewId || !repairId) {
          if (pg) report(table, "unexpected row", `legacy ID ${r.ID}: orphaned FK but row exists in Postgres`);
          continue;
        }
        expectedCount += 1;
        if (!pg) { report(table, "missing row", `legacy ID ${r.ID} not found in Postgres`); continue; }
        if (pg.subview_id !== subviewId || pg.repair_code_id !== repairId) {
          report(table, "FK mismatch", `legacy ID ${r.ID}: subview_id/repair_code_id does not resolve correctly`);
        }
      }
      if (expectedCount !== pgSubviewRepairs.size) {
        report(table, "count mismatch", `expected ${expectedCount} migrated rows vs Postgres ${pgSubviewRepairs.size}`);
      }
      assertCovered(table, pgSubviewRepairsCols, ["subview_id", "repair_code_id"]);
    }

    // -------------------------------------------------------------------
    // 10. Misc_Master -> misc_items
    // -------------------------------------------------------------------
    {
      const table = "Misc_Master -> misc_items";
      const legacy = rowsOf(db, "SELECT * FROM Misc_Master");
      for (const r of legacy) {
        const expectCategoryId = pgCategories.get(r.EquipmentTypeID_FK)?.id ?? null;
        const pg = pgMiscItems.get(r.ID);
        if (!expectCategoryId) {
          if (pg) report(table, "unexpected row", `legacy ID ${r.ID}: orphaned category FK but row exists`);
          continue;
        }
        if (!pg) { report(table, "missing row", `legacy ID ${r.ID} not found in Postgres`); continue; }
        if (pg.equipment_category_id !== expectCategoryId) report(table, "FK mismatch", `legacy ID ${r.ID}: equipment_category_id incorrect`);
        if (pg.misc_name !== r.Misc_Name) report(table, "value mismatch", `legacy ID ${r.ID}: misc_name differs`);
        if (pg.misc_code !== r.Misc_Code) report(table, "value mismatch", `legacy ID ${r.ID}: misc_code differs`);
        if (pg.is_disabled !== false) report(table, "value mismatch", `legacy ID ${r.ID}: is_disabled should be false (no legacy source), got ${pg.is_disabled}`);
      }
      if (legacy.length !== pgMiscItems.size) report(table, "count mismatch", `legacy ${legacy.length} vs Postgres ${pgMiscItems.size}`);
      assertCovered(table, pgMiscItemsCols, ["equipment_category_id", "misc_name", "misc_code", "is_disabled"]);
    }

    // -------------------------------------------------------------------
    // 11. EquipmentMainView_Misc -> main_view_misc_items (3 excluded
    //     orphans, 1 dedup pair)
    // -------------------------------------------------------------------
    {
      const table = "EquipmentMainView_Misc -> main_view_misc_items";
      const legacy = (rowsOf(db, "SELECT * FROM EquipmentMainView_Misc") as any[]).sort((a, b) => a.ID - b.ID);
      const seen = new Set<string>();
      let expectedCount = 0;
      for (const r of legacy) {
        const pg = pgMainViewMisc.get(r.ID);
        const mainViewId = pgMainViews.get(r.EquipmentMainViewID_FK)?.id;
        const miscItemId = pgMiscItems.get(r.MiscID_FK)?.id;
        if (!mainViewId || !miscItemId) {
          if (pg) report(table, "unexpected row", `legacy ID ${r.ID}: unresolvable FK but row exists in Postgres`);
          continue;
        }
        const pairKey = `${r.EquipmentMainViewID_FK}::${r.MiscID_FK}`;
        if (seen.has(pairKey)) {
          if (pg) report(table, "unexpected row", `legacy ID ${r.ID}: duplicate pair should have been skipped but row exists`);
          continue;
        }
        seen.add(pairKey);
        expectedCount += 1;
        if (!pg) { report(table, "missing row", `legacy ID ${r.ID} not found in Postgres`); continue; }
        if (pg.main_view_id !== mainViewId || pg.misc_item_id !== miscItemId) {
          report(table, "FK mismatch", `legacy ID ${r.ID}: main_view_id/misc_item_id does not resolve correctly`);
        }
        if (pg.display_subview_id !== null) {
          report(table, "value mismatch", `legacy ID ${r.ID}: display_subview_id should always be NULL, got ${pg.display_subview_id}`);
        }
      }
      if (expectedCount !== pgMainViewMisc.size) {
        report(table, "count mismatch", `expected ${expectedCount} migrated rows vs Postgres ${pgMainViewMisc.size}`);
      }
      assertCovered(table, pgMainViewMiscCols, ["main_view_id", "misc_item_id", "display_subview_id"]);
    }

    // -------------------------------------------------------------------
    // 12. Equipment_Misc -> main_view_components (0 sentinel skipped,
    //     27 dedup pairs keeping lower legacy ID)
    // -------------------------------------------------------------------
    {
      const table = "Equipment_Misc -> main_view_components";
      const legacy = (rowsOf(db, "SELECT * FROM Equipment_Misc") as any[]).sort((a, b) => a.ID - b.ID);
      const seen = new Set<string>();
      let expectedCount = 0;
      for (const r of legacy) {
        const pg = pgMainViewComponents.get(r.ID);
        if (r.ComponentID_FK === 0) {
          if (pg) report(table, "unexpected row", `legacy ID ${r.ID}: sentinel 0 but row exists in Postgres`);
          continue;
        }
        const mainViewId = pgMainViews.get(r.EquipmentMainViewID_FK)?.id;
        const componentId = pgComponents.get(r.ComponentID_FK)?.id;
        if (!mainViewId || !componentId) {
          if (pg) report(table, "unexpected row", `legacy ID ${r.ID}: orphaned FK but row exists in Postgres`);
          continue;
        }
        const pairKey = `${r.EquipmentMainViewID_FK}::${r.ComponentID_FK}`;
        if (seen.has(pairKey)) {
          if (pg) report(table, "unexpected row", `legacy ID ${r.ID}: duplicate pair should have been skipped but row exists`);
          continue;
        }
        seen.add(pairKey);
        expectedCount += 1;
        if (!pg) { report(table, "missing row", `legacy ID ${r.ID} not found in Postgres`); continue; }
        if (pg.main_view_id !== mainViewId || pg.component_id !== componentId) {
          report(table, "FK mismatch", `legacy ID ${r.ID}: main_view_id/component_id does not resolve correctly`);
        }
      }
      if (expectedCount !== pgMainViewComponents.size) {
        report(table, "count mismatch", `expected ${expectedCount} migrated rows vs Postgres ${pgMainViewComponents.size}`);
      }
      assertCovered(table, pgMainViewComponentsCols, ["main_view_id", "component_id"]);
    }

    // -------------------------------------------------------------------
    // 13. UIComponent_Master -> widget_types (verbatim names)
    // -------------------------------------------------------------------
    {
      const table = "UIComponent_Master -> widget_types";
      const legacy = rowsOf(db, "SELECT * FROM UIComponent_Master");
      for (const r of legacy) {
        const pg = pgWidgetTypes.get(r.ID);
        if (!pg) { report(table, "missing row", `legacy ID ${r.ID} not found in Postgres`); continue; }
        if (pg.name !== r.Name) report(table, "value mismatch", `legacy ID ${r.ID}: name '${pg.name}' !== '${r.Name}'`);
        if (pg.is_disabled !== false) report(table, "value mismatch", `legacy ID ${r.ID}: is_disabled should be false (no legacy source), got ${pg.is_disabled}`);
      }
      if (legacy.length !== pgWidgetTypes.size) report(table, "count mismatch", `legacy ${legacy.length} vs Postgres ${pgWidgetTypes.size}`);
      assertCovered(table, pgWidgetTypesCols, ["name", "is_disabled"]);
    }

    // -------------------------------------------------------------------
    // 14. EquipmentSubView_ExtraBoxItem -> subview_fields (field_name = slugify(Label))
    // -------------------------------------------------------------------
    function slugify(label: string): string {
      return label.toLowerCase().trim().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
    }
    {
      const table = "EquipmentSubView_ExtraBoxItem -> subview_fields";
      const legacy = rowsOf(db, "SELECT * FROM EquipmentSubView_ExtraBoxItem");
      for (const r of legacy) {
        const subviewId = pgSubviews.get(r.EquipmentSubViewID_FK)?.id;
        const widgetTypeId = pgWidgetTypes.get(r.UIComponent_Master_FK)?.id;
        const pg = pgSubviewFields.get(r.ID);
        if (!subviewId || !widgetTypeId) {
          if (pg) report(table, "unexpected row", `legacy ID ${r.ID}: orphaned FK but row exists in Postgres`);
          continue;
        }
        if (!pg) { report(table, "missing row", `legacy ID ${r.ID} not found in Postgres`); continue; }
        if (pg.subview_id !== subviewId || pg.widget_type_id !== widgetTypeId) {
          report(table, "FK mismatch", `legacy ID ${r.ID}: subview_id/widget_type_id does not resolve correctly`);
        }
        if (pg.label !== r.Label) report(table, "value mismatch", `legacy ID ${r.ID}: label differs`);
        const expectFieldName = slugify(r.Label);
        if (pg.field_name !== expectFieldName) report(table, "value mismatch", `legacy ID ${r.ID}: field_name '${pg.field_name}' !== expected '${expectFieldName}'`);
        if ((pg.display_order ?? null) !== (r.Sequence ?? null)) report(table, "value mismatch", `legacy ID ${r.ID}: display_order differs`);
      }
      const orphanCount = legacy.filter(
        (r) => !pgSubviews.get(r.EquipmentSubViewID_FK)?.id || !pgWidgetTypes.get(r.UIComponent_Master_FK)?.id,
      ).length;
      const expectedCount = legacy.length - orphanCount;
      if (expectedCount !== pgSubviewFields.size) report(table, "count mismatch", `expected ${expectedCount} vs Postgres ${pgSubviewFields.size}`);
      assertCovered(table, pgSubviewFieldsCols, [
        "subview_id",
        "widget_type_id",
        "label",
        "field_name",
        "display_order",
      ]);
    }

    // -------------------------------------------------------------------
    // 15. UIBox_Details -> subview_field_options (display_order = rank by ID asc per field)
    // -------------------------------------------------------------------
    {
      const table = "UIBox_Details -> subview_field_options";
      const legacy = (rowsOf(db, "SELECT * FROM UIBox_Details") as any[]).sort((a, b) => a.ID - b.ID);
      const orderCounters = new Map<number, number>();
      let expectedCount = 0;
      for (const r of legacy) {
        const fieldId = pgSubviewFields.get(r.EquipmentSubView_ExtraBoxItemID_FK)?.id;
        const pg = pgSubviewFieldOptions.get(r.ID);
        if (!fieldId) {
          if (pg) report(table, "unexpected row", `legacy ID ${r.ID}: orphaned FK but row exists in Postgres`);
          continue;
        }
        expectedCount += 1;
        const nextOrder = orderCounters.get(r.EquipmentSubView_ExtraBoxItemID_FK) ?? 0;
        orderCounters.set(r.EquipmentSubView_ExtraBoxItemID_FK, nextOrder + 1);
        if (!pg) { report(table, "missing row", `legacy ID ${r.ID} not found in Postgres`); continue; }
        if (pg.subview_field_id !== fieldId) report(table, "FK mismatch", `legacy ID ${r.ID}: subview_field_id incorrect`);
        if (pg.label_value !== r.LabelValue) report(table, "value mismatch", `legacy ID ${r.ID}: label_value differs`);
        if (Number(pg.display_order) !== nextOrder) report(table, "value mismatch", `legacy ID ${r.ID}: display_order ${pg.display_order} !== expected ${nextOrder}`);
      }
      if (expectedCount !== pgSubviewFieldOptions.size) report(table, "count mismatch", `expected ${expectedCount} vs Postgres ${pgSubviewFieldOptions.size}`);
      assertCovered(table, pgSubviewFieldOptionsCols, ["subview_field_id", "label_value", "display_order"]);
    }

    // -------------------------------------------------------------------
    // 16. Action_MST -> quick_actions
    // -------------------------------------------------------------------
    {
      const table = "Action_MST -> quick_actions";
      const legacy = rowsOf(db, "SELECT * FROM Action_MST");
      let expectedCount = 0;
      for (const r of legacy) {
        const pg = pgQuickActions.get(r.ID);
        let expectMainViewId: string | null = null;
        let expectSubviewId: string | null = null;
        let routable = true;
        if (r.IsSubView === "TRUE") {
          expectSubviewId = pgSubviews.get(r.MainViewID_FK)?.id ?? null;
          if (!expectSubviewId) routable = false;
        } else {
          expectMainViewId = pgMainViews.get(r.MainViewID_FK)?.id ?? null;
          if (!expectMainViewId) routable = false;
        }
        if (!routable) {
          if (pg) report(table, "unexpected row", `legacy ID ${r.ID}: unroutable main_view/subview FK but row exists in Postgres`);
          continue;
        }
        expectedCount += 1;
        if (!pg) { report(table, "missing row", `legacy ID ${r.ID} not found in Postgres`); continue; }
        if (pg.action_name !== r.Action) report(table, "value mismatch", `legacy ID ${r.ID}: action_name differs`);
        if (pg.main_view_id !== expectMainViewId) report(table, "FK mismatch", `legacy ID ${r.ID}: main_view_id incorrect`);
        if (pg.subview_id !== expectSubviewId) report(table, "FK mismatch", `legacy ID ${r.ID}: subview_id incorrect`);

        // component_id: blank -> NULL; else must resolve by numeric ID
        if (r.ComponentCode !== null && String(r.ComponentCode).trim() !== "") {
          const expectComponentId = pgComponents.get(Number(r.ComponentCode))?.id ?? null;
          if (pg.component_id !== expectComponentId) {
            report(table, "FK mismatch", `legacy ID ${r.ID}: component_id does not match resolution of ComponentCode ${r.ComponentCode}`);
          }
        } else if (pg.component_id !== null) {
          report(table, "FK mismatch", `legacy ID ${r.ID}: ComponentCode blank but component_id is not NULL`);
        }

        // repair_code_id: blank or unresolvable ("200") -> NULL; else must resolve
        if (r.RepairCode !== null && String(r.RepairCode).trim() !== "") {
          const expectRepairId = pgRepairCodes.get(Number(r.RepairCode))?.id ?? null;
          if (pg.repair_code_id !== expectRepairId) {
            report(table, "FK mismatch", `legacy ID ${r.ID}: repair_code_id does not match resolution of RepairCode ${r.RepairCode}`);
          }
        } else if (pg.repair_code_id !== null) {
          report(table, "FK mismatch", `legacy ID ${r.ID}: RepairCode blank but repair_code_id is not NULL`);
        }
        if (pg.is_disabled !== false) report(table, "value mismatch", `legacy ID ${r.ID}: is_disabled should be false (no legacy source), got ${pg.is_disabled}`);
      }
      if (expectedCount !== pgQuickActions.size) report(table, "count mismatch", `expected ${expectedCount} vs Postgres ${pgQuickActions.size}`);
      assertCovered(table, pgQuickActionsCols, [
        "action_name",
        "repair_code_id",
        "component_id",
        "main_view_id",
        "subview_id",
        "is_disabled",
      ]);
    }

    // -------------------------------------------------------------------
    // Report
    // -------------------------------------------------------------------
    console.log("\n=== Legacy migration audit (read-only) ===\n");
    console.log(`Prefix_Master / equipment_prefixes excluded from scope, per request.\n`);
    if (findings.length === 0) {
      console.log("No discrepancies found across all compared tables.");
    } else {
      const byTable = new Map<string, Finding[]>();
      for (const f of findings) {
        if (!byTable.has(f.table)) byTable.set(f.table, []);
        byTable.get(f.table)!.push(f);
      }
      for (const [table, items] of byTable) {
        console.log(`\n## ${table} — ${items.length} finding(s)`);
        for (const it of items) console.log(`  [${it.kind}] ${it.detail}`);
      }
      console.log(`\nTotal: ${findings.length} finding(s) across ${byTable.size} table(s).`);
    }
  } finally {
    await client.query("ROLLBACK");
    client.release();
    db.close();
    await pool.end();
  }
}

main().catch((err) => {
  console.error("Migration audit failed:", err);
  process.exitCode = 1;
});
