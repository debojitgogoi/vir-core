import path from "path";
import fs from "fs";
import { DatabaseSync } from "node:sqlite";
import type { PoolClient } from "pg";

const DRY_RUN = process.argv.includes("--dry-run");
const VERBOSE = process.argv.includes("--verbose");

const SQLITE_PATH = path.join(__dirname, "..", "legacy_data", "vir.sqlite");
const EXCEPTIONS_PATH = path.join(
  __dirname,
  "..",
  "legacy_data",
  "migration-exceptions.md",
);

// Single "migration run time" used for every row whose legacy Datetime is
// blank/unparseable (migration-plan.md §3.5).
const RUN_TIME = new Date();

const TOTAL_STEPS = 17;
let currentStep = 0;
let stepStartedAt = 0;
const runStartedAt = Date.now();

function formatMs(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function beginStep(label: string): void {
  currentStep += 1;
  stepStartedAt = Date.now();
  console.log(`\n[${currentStep}/${TOTAL_STEPS}] ${label}…`);
}

function endStep(target: string, count: number, note?: string): void {
  const elapsed = formatMs(Date.now() - stepStartedAt);
  const suffix = note ? ` (${note})` : "";
  console.log(
    `[${currentStep}/${TOTAL_STEPS}] ✓ ${target}: ${count} row(s)${suffix} [${elapsed}]`,
  );
}

function parseLegacyDatetime(raw: unknown): Date {
  if (typeof raw !== "string" || raw.trim() === "") return RUN_TIME;
  const iso = raw.trim().replace(" ", "T") + "Z";
  const parsed = new Date(iso);
  return Number.isNaN(parsed.getTime()) ? RUN_TIME : parsed;
}

function slugify(label: string): string {
  return label
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

interface Exception {
  rule: string;
  table: string;
  legacyId: number;
  detail: string;
}
const exceptions: Exception[] = [];
function logException(rule: string, table: string, legacyId: number, detail: string) {
  exceptions.push({ rule, table, legacyId, detail });
  if (VERBOSE) {
    console.log(`  ↳ skip [${rule}] ${table}#${legacyId}: ${detail}`);
  }
}

// ---------------------------------------------------------------------
// Insert helper: builds `INSERT INTO t (...) VALUES (...) RETURNING id`
// and returns the new UUID. Executes for real, or just returns a fake
// uuid-shaped string in --dry-run so downstream maps still work.
// ---------------------------------------------------------------------
let dryRunCounter = 0;
async function insertRow(
  client: PoolClient | null,
  table: string,
  columns: string[],
  values: unknown[],
): Promise<string> {
  if (DRY_RUN || !client) {
    dryRunCounter += 1;
    return `dry-run-${dryRunCounter}`;
  }
  const placeholders = columns.map((_, i) => `$${i + 1}`).join(", ");
  const sql = `INSERT INTO ${table} (${columns.join(", ")}) VALUES (${placeholders}) RETURNING id`;
  const { rows } = await client.query(sql, values);
  return rows[0].id as string;
}

async function run(): Promise<void> {
  console.log("=== Legacy data migration ===");
  console.log(`Mode:     ${DRY_RUN ? "DRY RUN (no Postgres writes)" : "APPLY (writes to Postgres)"}`);
  console.log(`Verbose:  ${VERBOSE ? "on (--verbose)" : "off (pass --verbose for per-skip detail)"}`);
  console.log(`SQLite:   ${SQLITE_PATH}`);
  if (fs.existsSync(SQLITE_PATH)) {
    const { size } = fs.statSync(SQLITE_PATH);
    console.log(`SQLite size: ${(size / (1024 * 1024)).toFixed(2)} MB`);
  } else {
    console.log("SQLite size: (file missing)");
  }

  const db = new DatabaseSync(SQLITE_PATH, { readOnly: true });
  console.log("Opened SQLite database (read-only).");

  let client: PoolClient | null = null;
  if (!DRY_RUN) {
    // Loaded lazily so --dry-run never needs DATABASE_URL / a live DB.
    console.log("Connecting to Postgres…");
    const { pool } = await import("../src/db/pool");
    client = await pool.connect();
    await client.query("BEGIN");
    console.log("Postgres transaction started (BEGIN).");
  } else {
    console.log("Skipping Postgres connection (dry run).");
  }

  try {
    if (!DRY_RUN && client) {
      const { rows } = await client.query("SELECT COUNT(*) c FROM equipment_categories");
      if (Number(rows[0].c) > 0) {
        throw new Error(
          "equipment_categories already has rows — refusing to run the legacy data " +
            "migration twice. Truncate the 17 equipment-inspection tables first if you " +
            "really want to re-run it.",
        );
      }
      console.log("Pre-check OK: equipment_categories is empty.");
    }

    const counts: Record<string, number> = {};

    // 1. equipment_categories <- EquipmentType -------------------------
    beginStep("equipment_categories ← EquipmentType");
    const categoryMap = new Map<number, string>(); // legacy EquipmentType.ID -> UUID
    for (const r of db.prepare("SELECT * FROM EquipmentType").all() as any[]) {
      const dt = parseLegacyDatetime(r.Datetime);
      const id = await insertRow(
        client,
        "equipment_categories",
        ["legacy_id", "name", "is_disabled", "created_at", "updated_at"],
        [r.ID, r.EquipmentType, false, dt, dt],
      );
      categoryMap.set(r.ID, id);
    }
    counts.equipment_categories = categoryMap.size;
    endStep("equipment_categories", counts.equipment_categories);

    // equipment_types <- EquipmentSubType, and remember each subtype's
    // resolved category UUID for equipment_prefixes' FK-chain lookup.
    beginStep("equipment_types ← EquipmentSubType");
    const equipmentTypeMap = new Map<number, string>(); // legacy EquipmentSubType.ID -> UUID
    const subtypeCategoryMap = new Map<number, string>(); // legacy EquipmentSubType.ID -> category UUID
    for (const r of db.prepare("SELECT * FROM EquipmentSubType").all() as any[]) {
      const categoryId = categoryMap.get(r.EquipmentTypeID_FK);
      if (!categoryId) {
        logException(
          "orphaned FK",
          "EquipmentSubType",
          r.ID,
          `EquipmentTypeID_FK ${r.EquipmentTypeID_FK} does not resolve — row skipped`,
        );
        continue;
      }
      const name = String(r.EquipmentSubTypeName).replace(/’/g, "ft");
      const dt = parseLegacyDatetime(r.Datetime);
      const id = await insertRow(
        client,
        "equipment_types",
        ["legacy_id", "equipment_category_id", "name", "is_disabled", "created_at", "updated_at"],
        [r.ID, categoryId, name, false, dt, dt],
      );
      equipmentTypeMap.set(r.ID, id);
      subtypeCategoryMap.set(r.ID, categoryId);
    }
    counts.equipment_types = equipmentTypeMap.size;
    endStep("equipment_types", counts.equipment_types);

    // equipment_prefixes <- Prefix_Master (FK-chain: subtype -> category).
    beginStep("equipment_prefixes ← Prefix_Master");
    // Not documented in migration-plan.md, but the live data has a true
    // duplicate: legacy IDs 9 and 23 are both EquipmentSubTypeID_FK=1,
    // Prefix_Name='YMLZ' — identical in every column but ID, not two
    // distinct prefixes sharing a code (unlike the component_code/misc_code
    // cases). equipment_prefixes.UNIQUE(equipment_category_id, prefix_name)
    // is left in place (no schema change); de-duplicate on insert using the
    // same "keep the lower legacy ID, skip + log the higher" rule already
    // used for main_view_components's 27 duplicate pairs (§1.17). Sort by
    // ID ascending so "already inserted this pair" always means "keep the
    // earlier row".
    const prefixRows = (db.prepare("SELECT * FROM Prefix_Master").all() as any[]).sort(
      (a, b) => a.ID - b.ID,
    );
    const seenCategoryPrefixPairs = new Set<string>();
    let prefixCount = 0;
    for (const r of prefixRows) {
      const categoryId = subtypeCategoryMap.get(r.EquipmentSubTypeID_FK);
      if (!categoryId) {
        logException(
          "orphaned FK",
          "Prefix_Master",
          r.ID,
          `EquipmentSubTypeID_FK ${r.EquipmentSubTypeID_FK} does not resolve — row skipped`,
        );
        continue;
      }
      const pairKey = `${categoryId}::${r.Prefix_Name}`;
      if (seenCategoryPrefixPairs.has(pairKey)) {
        logException(
          "duplicate pair, lower legacy ID kept",
          "Prefix_Master",
          r.ID,
          `(equipment_category ${r.EquipmentSubTypeID_FK}, prefix_name ${r.Prefix_Name}) already migrated from a lower legacy ID — row skipped`,
        );
        continue;
      }
      seenCategoryPrefixPairs.add(pairKey);
      const dt = parseLegacyDatetime(r.Datetime);
      await insertRow(
        client,
        "equipment_prefixes",
        ["legacy_id", "equipment_category_id", "prefix_name", "created_at", "updated_at"],
        [r.ID, categoryId, r.Prefix_Name, dt, dt],
      );
      prefixCount += 1;
    }
    counts.equipment_prefixes = prefixCount;
    endStep("equipment_prefixes", counts.equipment_prefixes);

    // 2. components <- Component_Master (created before main_views/subviews)
    beginStep("components ← Component_Master");
    const componentMap = new Map<number, string>(); // legacy Component_Master.ID -> UUID
    for (const r of db.prepare("SELECT * FROM Component_Master").all() as any[]) {
      const dt = parseLegacyDatetime(r.Datetime);
      const id = await insertRow(
        client,
        "components",
        [
          "legacy_id",
          "component_code",
          "component_description",
          "is_disabled",
          "created_at",
          "updated_at",
        ],
        [r.ID, r.ComponentCode, r.ComponentDesc, false, dt, dt],
      );
      componentMap.set(r.ID, id);
    }
    counts.components = componentMap.size;
    endStep("components", counts.components);

    // main_views <- EquipmentMainView
    beginStep("main_views ← EquipmentMainView");
    const mainViewMap = new Map<number, string>(); // legacy EquipmentMainView.ID -> UUID
    for (const r of db.prepare("SELECT * FROM EquipmentMainView").all() as any[]) {
      const equipmentTypeId = equipmentTypeMap.get(r.EquipmentSubTypeID_FK);
      if (!equipmentTypeId) {
        logException(
          "orphaned FK",
          "EquipmentMainView",
          r.ID,
          `EquipmentSubTypeID_FK ${r.EquipmentSubTypeID_FK} does not resolve — row skipped`,
        );
        continue;
      }
      const dt = parseLegacyDatetime(r.Datetime);
      const id = await insertRow(
        client,
        "main_views",
        [
          "legacy_id",
          "equipment_type_id",
          "name",
          "bubble_name",
          "label_name",
          "sequence_number",
          "is_disabled",
          "created_at",
          "updated_at",
        ],
        [r.ID, equipmentTypeId, r.Name, r.BubbleName, r.LabelName, r.SequenceNumber, false, dt, dt],
      );
      mainViewMap.set(r.ID, id);
    }
    counts.main_views = mainViewMap.size;
    endStep("main_views", counts.main_views);

    // subviews <- EquipmentSubView, pass 1 (parent_subview_id always NULL here)
    beginStep("subviews ← EquipmentSubView (pass 1)");
    const subviewMap = new Map<number, string>(); // legacy EquipmentSubView.ID -> UUID
    const subviewRows = db.prepare("SELECT * FROM EquipmentSubView").all() as any[];
    for (const r of subviewRows) {
      const mainViewId = mainViewMap.get(r.EquipmentMainViewID_FK);
      if (!mainViewId) {
        logException(
          "orphaned FK",
          "EquipmentSubView",
          r.ID,
          `EquipmentMainViewID_FK ${r.EquipmentMainViewID_FK} does not resolve — row skipped`,
        );
        continue;
      }
      // 0, -1, and SQL NULL are all "unset" sentinels here (migration-plan.md
      // §3.2 documents 0/-1 as 51 rows; the live data additionally has 21
      // rows with a genuine NULL FK, uncounted in that doc but the same
      // "no component" case — treated identically, not logged as an
      // exception). Only a non-sentinel value that still fails to resolve
      // (e.g. legacy ID 374, which has no matching component) is a real
      // orphan worth logging.
      let componentId: string | null = null;
      if (r.ComponentID_FK !== 0 && r.ComponentID_FK !== -1 && r.ComponentID_FK !== null) {
        const resolved = componentMap.get(r.ComponentID_FK);
        if (resolved) {
          componentId = resolved;
        } else {
          logException(
            "orphaned FK",
            "EquipmentSubView",
            r.ID,
            `ComponentID_FK ${r.ComponentID_FK} does not resolve — component_id set to NULL`,
          );
        }
      }
      const dt = parseLegacyDatetime(r.Datetime);
      const id = await insertRow(
        client,
        "subviews",
        [
          "legacy_id",
          "main_view_id",
          "parent_subview_id",
          "component_id",
          "name",
          "header",
          "is_disabled",
          "created_at",
          "updated_at",
        ],
        [r.ID, mainViewId, null, componentId, r.Name, r.Header, false, dt, dt],
      );
      subviewMap.set(r.ID, id);
    }
    counts.subviews = subviewMap.size;
    endStep("subviews", counts.subviews);

    // subviews pass 2: resolve parent_subview_id. Trigger disabled around
    // the bulk UPDATE so it doesn't overwrite the updated_at set on insert
    // (schema-design.md's own bulk-load note).
    beginStep("subviews parent links (pass 2)");
    let parentLinksSet = 0;
    if (!DRY_RUN && client) {
      await client.query("ALTER TABLE subviews DISABLE TRIGGER trg_subviews_set_updated_at");
    }
    for (const r of subviewRows) {
      if (r.ParentID === 0) continue;
      const childId = subviewMap.get(r.ID);
      const parentId = subviewMap.get(r.ParentID);
      if (!childId) continue; // child itself was skipped above (orphaned main view)
      if (!parentId) {
        logException(
          "orphaned FK",
          "EquipmentSubView",
          r.ID,
          `ParentID ${r.ParentID} does not resolve — parent_subview_id left NULL`,
        );
        continue;
      }
      if (!DRY_RUN && client) {
        await client.query("UPDATE subviews SET parent_subview_id = $1 WHERE id = $2", [
          parentId,
          childId,
        ]);
      }
      parentLinksSet += 1;
    }
    if (!DRY_RUN && client) {
      await client.query("ALTER TABLE subviews ENABLE TRIGGER trg_subviews_set_updated_at");
    }
    counts.subviews_parent_links = parentLinksSet;
    endStep(
      "subviews_parent_links",
      counts.subviews_parent_links,
      DRY_RUN ? "counted only; no UPDATE in dry run" : undefined,
    );

    // 3. damage_codes / repair_codes -----------------------------------
    beginStep("damage_codes ← Damage_MST");
    const damageCodeMap = new Map<number, string>();
    for (const r of db.prepare("SELECT * FROM Damage_MST").all() as any[]) {
      const dt = parseLegacyDatetime(r.Datetime);
      const id = await insertRow(
        client,
        "damage_codes",
        ["legacy_id", "damage_code", "damage_description", "is_disabled", "created_at", "updated_at"],
        [r.ID, r.DamageCode, r.DamageDesc, false, dt, dt],
      );
      damageCodeMap.set(r.ID, id);
    }
    counts.damage_codes = damageCodeMap.size;
    endStep("damage_codes", counts.damage_codes);

    // Repairs_MST -> repair_codes, with the two documented code renames
    // (migration-plan.md §1.8): legacy ID 80 RT->RN, legacy ID 84 SI->PE.
    beginStep("repair_codes ← Repairs_MST");
    const REPAIR_CODE_RENAMES: Record<number, string> = { 80: "RN", 84: "PE" };
    const repairCodeMap = new Map<number, string>();
    for (const r of db.prepare("SELECT * FROM Repairs_MST").all() as any[]) {
      const repairCode = REPAIR_CODE_RENAMES[r.ID] ?? r.RepairCode;
      const dt = parseLegacyDatetime(r.Datetime);
      const id = await insertRow(
        client,
        "repair_codes",
        ["legacy_id", "repair_code", "repair_description", "is_disabled", "created_at", "updated_at"],
        [r.ID, repairCode, r.RepairDesc, false, dt, dt],
      );
      repairCodeMap.set(r.ID, id);
    }
    counts.repair_codes = repairCodeMap.size;
    endStep("repair_codes", counts.repair_codes);

    // subview_damages <- EquipmentSubView_Damage (skip DamageID_FK = -1).
    beginStep("subview_damages ← EquipmentSubView_Damage");
    // Not documented in migration-plan.md, but 11 (subview, damage_code)
    // pairs remain duplicated even after excluding -1 sentinel rows (the
    // doc's §1.9 claims exclusion resolves every duplicate — it doesn't,
    // for these 11). Same "keep the lower legacy ID" de-dup rule as
    // main_view_components/equipment_prefixes; sort by ID ascending first.
    const subviewDamageRows = (
      db.prepare("SELECT * FROM EquipmentSubView_Damage").all() as any[]
    ).sort((a, b) => a.ID - b.ID);
    const seenSubviewDamagePairs = new Set<string>();
    let subviewDamagesCount = 0;
    for (const r of subviewDamageRows) {
      if (r.DamageID_FK === -1) continue; // sentinel, §3.2
      const subviewId = subviewMap.get(r.EquipmentSubViewID_FK);
      const damageCodeId = damageCodeMap.get(r.DamageID_FK);
      if (!subviewId || !damageCodeId) {
        logException(
          "orphaned FK",
          "EquipmentSubView_Damage",
          r.ID,
          `subview ${r.EquipmentSubViewID_FK} or damage code ${r.DamageID_FK} does not resolve — row skipped`,
        );
        continue;
      }
      const pairKey = `${r.EquipmentSubViewID_FK}::${r.DamageID_FK}`;
      if (seenSubviewDamagePairs.has(pairKey)) {
        logException(
          "duplicate pair, lower legacy ID kept",
          "EquipmentSubView_Damage",
          r.ID,
          `(subview ${r.EquipmentSubViewID_FK}, damage code ${r.DamageID_FK}) already migrated from a lower legacy ID — row skipped`,
        );
        continue;
      }
      seenSubviewDamagePairs.add(pairKey);
      const dt = parseLegacyDatetime(r.Datetime);
      await insertRow(
        client,
        "subview_damages",
        ["legacy_id", "subview_id", "damage_code_id", "created_at", "updated_at"],
        [r.ID, subviewId, damageCodeId, dt, dt],
      );
      subviewDamagesCount += 1;
    }
    counts.subview_damages = subviewDamagesCount;
    endStep("subview_damages", counts.subview_damages);

    // subview_repairs <- EquipmentSubView_Repair (skip RepairID_FK = -1)
    beginStep("subview_repairs ← EquipmentSubView_Repair");
    let subviewRepairsCount = 0;
    for (const r of db.prepare("SELECT * FROM EquipmentSubView_Repair").all() as any[]) {
      if (r.RepairID_FK === -1) continue; // sentinel, §3.2
      const subviewId = subviewMap.get(r.EquipmentSubViewID_FK);
      const repairCodeId = repairCodeMap.get(r.RepairID_FK);
      if (!subviewId || !repairCodeId) {
        logException(
          "orphaned FK",
          "EquipmentSubView_Repair",
          r.ID,
          `subview ${r.EquipmentSubViewID_FK} or repair code ${r.RepairID_FK} does not resolve — row skipped`,
        );
        continue;
      }
      const dt = parseLegacyDatetime(r.Datetime);
      await insertRow(
        client,
        "subview_repairs",
        ["legacy_id", "subview_id", "repair_code_id", "created_at", "updated_at"],
        [r.ID, subviewId, repairCodeId, dt, dt],
      );
      subviewRepairsCount += 1;
    }
    counts.subview_repairs = subviewRepairsCount;
    endStep("subview_repairs", counts.subview_repairs);

    // 4. misc_items <- Misc_Master ---------------------------------------
    beginStep("misc_items ← Misc_Master");
    const miscItemMap = new Map<number, string>();
    for (const r of db.prepare("SELECT * FROM Misc_Master").all() as any[]) {
      const categoryId = categoryMap.get(r.EquipmentTypeID_FK);
      if (!categoryId) {
        logException(
          "orphaned FK",
          "Misc_Master",
          r.ID,
          `EquipmentTypeID_FK ${r.EquipmentTypeID_FK} does not resolve — row skipped`,
        );
        continue;
      }
      const dt = parseLegacyDatetime(r.Datetime);
      const id = await insertRow(
        client,
        "misc_items",
        [
          "legacy_id",
          "equipment_category_id",
          "misc_name",
          "misc_code",
          "is_disabled",
          "created_at",
          "updated_at",
        ],
        [r.ID, categoryId, r.Misc_Name, r.Misc_Code, false, dt, dt],
      );
      miscItemMap.set(r.ID, id);
    }
    counts.misc_items = miscItemMap.size;
    endStep("misc_items", counts.misc_items);

    // main_view_misc_items <- EquipmentMainView_Misc. misc_item_id stays
    // NOT NULL, so an unresolvable MiscID_FK excludes the row (§1.12/§3.3),
    // it isn't nulled like the other orphan cases.
    //
    // Not documented in migration-plan.md, but since display_subview_id is
    // always NULL for every migrated row here (§1.12 — the legacy table has
    // no subview-level column at all), the schema's
    // ux_main_view_misc_items_main_level partial unique index effectively
    // requires (main_view_id, misc_item_id) to be unique, and one legacy
    // pair (main_view 1, misc_item 16 — legacy rows 1 and 7) repeats. Same
    // "keep the lower legacy ID" de-dup rule as elsewhere in this script.
    beginStep("main_view_misc_items ← EquipmentMainView_Misc");
    const mainViewMiscRows = (
      db.prepare("SELECT * FROM EquipmentMainView_Misc").all() as any[]
    ).sort((a, b) => a.ID - b.ID);
    const seenMainViewMiscPairs = new Set<string>();
    let mainViewMiscCount = 0;
    for (const r of mainViewMiscRows) {
      const mainViewId = mainViewMap.get(r.EquipmentMainViewID_FK);
      const miscItemId = miscItemMap.get(r.MiscID_FK);
      if (!mainViewId) {
        logException(
          "orphaned FK",
          "EquipmentMainView_Misc",
          r.ID,
          `EquipmentMainViewID_FK ${r.EquipmentMainViewID_FK} does not resolve — row skipped`,
        );
        continue;
      }
      if (!miscItemId) {
        logException(
          "excluded (misc_item_id NOT NULL)",
          "EquipmentMainView_Misc",
          r.ID,
          `MiscID_FK ${r.MiscID_FK} does not resolve — row excluded per §1.12`,
        );
        continue;
      }
      const pairKey = `${r.EquipmentMainViewID_FK}::${r.MiscID_FK}`;
      if (seenMainViewMiscPairs.has(pairKey)) {
        logException(
          "duplicate pair, lower legacy ID kept",
          "EquipmentMainView_Misc",
          r.ID,
          `(main_view ${r.EquipmentMainViewID_FK}, misc item ${r.MiscID_FK}) already migrated from a lower legacy ID — row skipped`,
        );
        continue;
      }
      seenMainViewMiscPairs.add(pairKey);
      const dt = parseLegacyDatetime(r.Datetime);
      await insertRow(
        client,
        "main_view_misc_items",
        ["legacy_id", "main_view_id", "misc_item_id", "display_subview_id", "created_at", "updated_at"],
        [r.ID, mainViewId, miscItemId, null, dt, dt],
      );
      mainViewMiscCount += 1;
    }
    counts.main_view_misc_items = mainViewMiscCount;
    endStep("main_view_misc_items", counts.main_view_misc_items);

    // main_view_components <- Equipment_Misc. Skip ComponentID_FK = 0
    // sentinel, and de-dup (main_view, component) pairs keeping the lower
    // legacy ID (§1.17) — sort by ID ascending so "already inserted this
    // pair" always means "keep the earlier row, skip this one".
    beginStep("main_view_components ← Equipment_Misc");
    const equipmentMiscRows = (db.prepare("SELECT * FROM Equipment_Misc").all() as any[]).sort(
      (a, b) => a.ID - b.ID,
    );
    const seenMainViewComponentPairs = new Set<string>();
    let mainViewComponentsCount = 0;
    for (const r of equipmentMiscRows) {
      if (r.ComponentID_FK === 0) continue; // sentinel, §3.2
      const mainViewId = mainViewMap.get(r.EquipmentMainViewID_FK);
      const componentId = componentMap.get(r.ComponentID_FK);
      if (!mainViewId || !componentId) {
        logException(
          "orphaned FK",
          "Equipment_Misc",
          r.ID,
          `main view ${r.EquipmentMainViewID_FK} or component ${r.ComponentID_FK} does not resolve — row skipped`,
        );
        continue;
      }
      const pairKey = `${r.EquipmentMainViewID_FK}::${r.ComponentID_FK}`;
      if (seenMainViewComponentPairs.has(pairKey)) {
        logException(
          "duplicate pair, lower legacy ID kept",
          "Equipment_Misc",
          r.ID,
          `(main_view ${r.EquipmentMainViewID_FK}, component ${r.ComponentID_FK}) already migrated from a lower legacy ID — row skipped per §1.17`,
        );
        continue;
      }
      seenMainViewComponentPairs.add(pairKey);
      const dt = parseLegacyDatetime(r.Datetime);
      await insertRow(
        client,
        "main_view_components",
        ["legacy_id", "main_view_id", "component_id", "created_at", "updated_at"],
        [r.ID, mainViewId, componentId, dt, dt],
      );
      mainViewComponentsCount += 1;
    }
    counts.main_view_components = mainViewComponentsCount;
    endStep("main_view_components", counts.main_view_components);

    // 5. widget_types <- UIComponent_Master (verbatim names, §1.13) ------
    beginStep("widget_types ← UIComponent_Master");
    const widgetTypeMap = new Map<number, string>();
    for (const r of db.prepare("SELECT * FROM UIComponent_Master").all() as any[]) {
      const dt = parseLegacyDatetime(r.Datetime);
      const id = await insertRow(
        client,
        "widget_types",
        ["legacy_id", "name", "is_disabled", "created_at", "updated_at"],
        [r.ID, r.Name, false, dt, dt],
      );
      widgetTypeMap.set(r.ID, id);
    }
    counts.widget_types = widgetTypeMap.size;
    endStep("widget_types", counts.widget_types);

    // subview_fields <- EquipmentSubView_ExtraBoxItem (field_name = slugify(Label), §1.14)
    beginStep("subview_fields ← EquipmentSubView_ExtraBoxItem");
    const subviewFieldMap = new Map<number, string>(); // legacy EquipmentSubView_ExtraBoxItem.ID -> UUID
    for (const r of db.prepare("SELECT * FROM EquipmentSubView_ExtraBoxItem").all() as any[]) {
      const subviewId = subviewMap.get(r.EquipmentSubViewID_FK);
      const widgetTypeId = widgetTypeMap.get(r.UIComponent_Master_FK);
      if (!subviewId || !widgetTypeId) {
        logException(
          "orphaned FK",
          "EquipmentSubView_ExtraBoxItem",
          r.ID,
          `subview ${r.EquipmentSubViewID_FK} or widget type ${r.UIComponent_Master_FK} does not resolve — row skipped`,
        );
        continue;
      }
      const dt = parseLegacyDatetime(r.Datetime);
      const id = await insertRow(
        client,
        "subview_fields",
        [
          "legacy_id",
          "subview_id",
          "widget_type_id",
          "label",
          "field_name",
          "display_order",
          "created_at",
          "updated_at",
        ],
        [r.ID, subviewId, widgetTypeId, r.Label, slugify(r.Label), r.Sequence, dt, dt],
      );
      subviewFieldMap.set(r.ID, id);
    }
    counts.subview_fields = subviewFieldMap.size;
    endStep("subview_fields", counts.subview_fields);

    // subview_field_options <- UIBox_Details. display_order = rank by
    // legacy ID ascending within each field (§1.15).
    beginStep("subview_field_options ← UIBox_Details");
    const uiBoxRows = (db.prepare("SELECT * FROM UIBox_Details").all() as any[]).sort(
      (a, b) => a.ID - b.ID,
    );
    const orderCounters = new Map<number, number>(); // subview_field legacy ID -> next display_order
    let subviewFieldOptionsCount = 0;
    for (const r of uiBoxRows) {
      const fieldId = subviewFieldMap.get(r.EquipmentSubView_ExtraBoxItemID_FK);
      if (!fieldId) {
        logException(
          "orphaned FK",
          "UIBox_Details",
          r.ID,
          `EquipmentSubView_ExtraBoxItemID_FK ${r.EquipmentSubView_ExtraBoxItemID_FK} does not resolve — row skipped`,
        );
        continue;
      }
      const nextOrder = orderCounters.get(r.EquipmentSubView_ExtraBoxItemID_FK) ?? 0;
      orderCounters.set(r.EquipmentSubView_ExtraBoxItemID_FK, nextOrder + 1);
      const dt = parseLegacyDatetime(r.Datetime);
      await insertRow(
        client,
        "subview_field_options",
        ["legacy_id", "subview_field_id", "label_value", "display_order", "created_at", "updated_at"],
        [r.ID, fieldId, r.LabelValue, nextOrder, dt, dt],
      );
      subviewFieldOptionsCount += 1;
    }
    counts.subview_field_options = subviewFieldOptionsCount;
    endStep("subview_field_options", counts.subview_field_options);

    // 6. quick_actions <- Action_MST (§1.16) -------------------------------
    beginStep("quick_actions ← Action_MST");
    let quickActionsCount = 0;
    for (const r of db.prepare("SELECT * FROM Action_MST").all() as any[]) {
      let componentId: string | null = null;
      if (r.ComponentCode !== null && String(r.ComponentCode).trim() !== "") {
        const resolved = componentMap.get(Number(r.ComponentCode));
        if (resolved) {
          componentId = resolved;
        } else {
          logException(
            "orphaned FK",
            "Action_MST",
            r.ID,
            `ComponentCode ${r.ComponentCode} does not resolve to a component ID — component_id set to NULL`,
          );
        }
      }
      let repairCodeId: string | null = null;
      if (r.RepairCode !== null && String(r.RepairCode).trim() !== "") {
        const resolved = repairCodeMap.get(Number(r.RepairCode));
        if (resolved) {
          repairCodeId = resolved;
        } else {
          logException(
            "unresolvable RepairCode, nulled",
            "Action_MST",
            r.ID,
            `RepairCode ${r.RepairCode} does not resolve to a repair code ID — repair_code_id set to NULL per §1.16`,
          );
        }
      }
      let mainViewId: string | null = null;
      let subviewId: string | null = null;
      if (r.IsSubView === "TRUE") {
        const resolved = subviewMap.get(r.MainViewID_FK);
        if (resolved) {
          subviewId = resolved;
        } else {
          logException(
            "orphaned FK",
            "Action_MST",
            r.ID,
            `IsSubView=TRUE but subview ${r.MainViewID_FK} does not resolve — row skipped`,
          );
          continue;
        }
      } else {
        const resolved = mainViewMap.get(r.MainViewID_FK);
        if (resolved) {
          mainViewId = resolved;
        } else {
          logException(
            "orphaned FK",
            "Action_MST",
            r.ID,
            `IsSubView=FALSE but main view ${r.MainViewID_FK} does not resolve — row skipped`,
          );
          continue;
        }
      }
      await insertRow(
        client,
        "quick_actions",
        [
          "legacy_id",
          "action_name",
          "repair_code_id",
          "component_id",
          "main_view_id",
          "subview_id",
          "is_disabled",
          "created_at",
          "updated_at",
        ],
        [r.ID, r.Action, repairCodeId, componentId, mainViewId, subviewId, false, RUN_TIME, RUN_TIME],
      );
      quickActionsCount += 1;
    }
    counts.quick_actions = quickActionsCount;
    endStep("quick_actions", counts.quick_actions);

    console.log(
      `\n=== Summary (${formatMs(Date.now() - runStartedAt)} total) ===`,
    );
    console.log(DRY_RUN ? "--dry-run summary (no DB writes) --" : "Row counts inserted:");
    console.table(counts);

    if (exceptions.length > 0) {
      writeExceptionsReport(exceptions);
      console.log(
        `\n${exceptions.length} exception(s) logged to ${path.relative(process.cwd(), EXCEPTIONS_PATH)}`,
      );
      if (VERBOSE) {
        const byTable = new Map<string, number>();
        for (const e of exceptions) {
          byTable.set(e.table, (byTable.get(e.table) ?? 0) + 1);
        }
        console.log("Exception counts by legacy table:");
        for (const [table, n] of [...byTable.entries()].sort((a, b) => b[1] - a[1])) {
          console.log(`  ${table}: ${n}`);
        }
      }
    } else {
      console.log("\nNo exceptions.");
    }

    if (!DRY_RUN && client) {
      await client.query("COMMIT");
      console.log("\nLegacy data migration committed.");
    } else {
      console.log("\nDry run complete — nothing was written to Postgres.");
    }
  } catch (err) {
    if (!DRY_RUN && client) {
      await client.query("ROLLBACK");
    }
    throw err;
  } finally {
    db.close();
    if (client) client.release();
    if (!DRY_RUN) {
      const { pool } = await import("../src/db/pool");
      await pool.end();
    }
  }
}

function writeExceptionsReport(items: Exception[]): void {
  const byRule = new Map<string, Exception[]>();
  for (const item of items) {
    if (!byRule.has(item.rule)) byRule.set(item.rule, []);
    byRule.get(item.rule)!.push(item);
  }
  const lines: string[] = [
    "# Legacy data migration — exceptions report",
    "",
    `Generated ${new Date().toISOString()} by \`scripts/migrate-legacy-data.ts\`.`,
    `${items.length} row(s) affected by a documented skip/null-and-log rule` +
      " (see legacy_data/migrated_db_structure/migration-plan.md §3.3).",
    "",
  ];
  for (const [rule, rows] of byRule) {
    lines.push(`## ${rule} (${rows.length})`, "");
    lines.push("| Table | Legacy ID | Detail |", "|---|---|---|");
    for (const row of rows) {
      lines.push(`| ${row.table} | ${row.legacyId} | ${row.detail} |`);
    }
    lines.push("");
  }
  fs.writeFileSync(EXCEPTIONS_PATH, lines.join("\n"));
}

run().catch((err) => {
  console.error("Legacy data migration failed:", err);
  process.exitCode = 1;
});
