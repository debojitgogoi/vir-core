import path from "path";
import fs from "fs";
import { DatabaseSync } from "node:sqlite";
import type { PoolClient } from "pg";

const DRY_RUN = process.argv.includes("--dry-run");
const VERBOSE = process.argv.includes("--verbose");

/** Multi-row INSERT chunk size. Caps bind params well under Postgres' ~65535 limit. */
function parseBatchSize(): number {
  const arg = process.argv.find((a) => a.startsWith("--batch-size="));
  if (!arg) return 500;
  const n = Number(arg.slice("--batch-size=".length));
  if (!Number.isInteger(n) || n < 1 || n > 2000) {
    throw new Error(`Invalid --batch-size=${arg}: use an integer 1..2000`);
  }
  return n;
}
const BATCH_SIZE = parseBatchSize();

const SQLITE_PATH = path.join(__dirname, "..", "legacy_data", "vir.sqlite");
const EXCEPTIONS_PATH = path.join(
  __dirname,
  "..",
  "legacy_data",
  "migration-exceptions-batched.md",
);
const PARITY_JSON_ARG = process.argv.find((a) => a.startsWith("--parity-json="));
const PARITY_JSON_PATH = PARITY_JSON_ARG
  ? path.resolve(PARITY_JSON_ARG.slice("--parity-json=".length))
  : null;

// Single "migration run time" used for every row whose legacy Datetime is
// blank/unparseable (migration-plan.md §3.5).
const RUN_TIME = new Date();

const TOTAL_STEPS = 18;
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
// Batched insert: same rows/values as the row-at-a-time migrator, fewer
// round-trips. Filter/skip/de-dup stay in JS; only the flush is batched.
// RETURNING id order matches VALUES order (Postgres guarantee).
// ---------------------------------------------------------------------
let dryRunCounter = 0;

/** Exported for unit tests — builds one multi-row INSERT chunk. */
export function buildInsertChunkSql(
  table: string,
  columns: string[],
  rowCount: number,
  startParam = 1,
): { sql: string; nextParam: number } {
  if (rowCount < 1) throw new Error("buildInsertChunkSql: rowCount must be >= 1");
  const width = columns.length;
  const valueGroups: string[] = [];
  let p = startParam;
  for (let r = 0; r < rowCount; r += 1) {
    const slots: string[] = [];
    for (let c = 0; c < width; c += 1) {
      slots.push(`$${p}`);
      p += 1;
    }
    valueGroups.push(`(${slots.join(", ")})`);
  }
  const sql =
    `INSERT INTO ${table} (${columns.join(", ")}) VALUES ${valueGroups.join(", ")} RETURNING id`;
  return { sql, nextParam: p };
}

async function insertBatch(
  client: PoolClient | null,
  table: string,
  columns: string[],
  rows: unknown[][],
): Promise<string[]> {
  if (rows.length === 0) return [];

  if (DRY_RUN || !client) {
    const ids: string[] = [];
    for (let i = 0; i < rows.length; i += 1) {
      dryRunCounter += 1;
      ids.push(`dry-run-${dryRunCounter}`);
    }
    return ids;
  }

  const maxParams = 65000;
  const width = columns.length;
  const maxRowsByParams = Math.max(1, Math.floor(maxParams / width));
  const chunkSize = Math.min(BATCH_SIZE, maxRowsByParams);
  const ids: string[] = [];

  for (let offset = 0; offset < rows.length; offset += chunkSize) {
    const chunk = rows.slice(offset, offset + chunkSize);
    const { sql } = buildInsertChunkSql(table, columns, chunk.length);
    const params: unknown[] = [];
    for (const row of chunk) {
      if (row.length !== width) {
        throw new Error(
          `insertBatch ${table}: row width ${row.length} != columns ${width}`,
        );
      }
      params.push(...row);
    }
    const { rows: returned } = await client.query(sql, params);
    if (returned.length !== chunk.length) {
      throw new Error(
        `insertBatch ${table}: expected ${chunk.length} RETURNING rows, got ${returned.length}`,
      );
    }
    for (const r of returned) ids.push(r.id as string);
  }

  if (ids.length !== rows.length) {
    throw new Error(
      `insertBatch ${table}: id count ${ids.length} != row count ${rows.length}`,
    );
  }
  return ids;
}

async function updateParentLinksBatch(
  client: PoolClient,
  links: Array<{ childId: string; parentId: string }>,
): Promise<void> {
  if (links.length === 0) return;
  const chunkSize = Math.min(BATCH_SIZE, 1000);
  for (let offset = 0; offset < links.length; offset += chunkSize) {
    const chunk = links.slice(offset, offset + chunkSize);
    const params: unknown[] = [];
    const tuples: string[] = [];
    let p = 1;
    for (const link of chunk) {
      tuples.push(`($${p}::uuid, $${p + 1}::uuid)`);
      params.push(link.childId, link.parentId);
      p += 2;
    }
    await client.query(
      `UPDATE subviews AS s
       SET parent_subview_id = v.parent_id
       FROM (VALUES ${tuples.join(", ")}) AS v(id, parent_id)
       WHERE s.id = v.id`,
      params,
    );
  }
}

async function run(): Promise<void> {
  console.log("=== Legacy data migration (batched) ===");
  console.log(`Mode:     ${DRY_RUN ? "DRY RUN (no Postgres writes)" : "APPLY (writes to Postgres)"}`);
  console.log(`Verbose:  ${VERBOSE ? "on (--verbose)" : "off (pass --verbose for per-skip detail)"}`);
  console.log(`Batch:    ${BATCH_SIZE} row(s) per INSERT`);
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
    {
      const cols = ["legacy_id", "name", "is_disabled", "created_at", "updated_at"];
      const batch: unknown[][] = [];
      const legacyIds: number[] = [];
      for (const r of db.prepare("SELECT * FROM EquipmentType").all() as any[]) {
        const dt = parseLegacyDatetime(r.Datetime);
        legacyIds.push(r.ID);
        batch.push([r.ID, r.EquipmentType, false, dt, dt]);
      }
      const ids = await insertBatch(client, "equipment_categories", cols, batch);
      for (let i = 0; i < ids.length; i += 1) categoryMap.set(legacyIds[i], ids[i]);
    }
    counts.equipment_categories = categoryMap.size;
    endStep("equipment_categories", counts.equipment_categories);

    // equipment_types <- EquipmentSubType, and remember each subtype's
    // resolved category UUID for equipment_prefixes' FK-chain lookup.
    beginStep("equipment_types ← EquipmentSubType");
    const equipmentTypeMap = new Map<number, string>(); // legacy EquipmentSubType.ID -> UUID
    const subtypeCategoryMap = new Map<number, string>(); // legacy EquipmentSubType.ID -> category UUID
    {
      const cols = [
        "legacy_id",
        "equipment_category_id",
        "name",
        "is_disabled",
        "created_at",
        "updated_at",
      ];
      const batch: unknown[][] = [];
      const legacyIds: number[] = [];
      const categoryIds: string[] = [];
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
        legacyIds.push(r.ID);
        categoryIds.push(categoryId);
        batch.push([r.ID, categoryId, name, false, dt, dt]);
      }
      const ids = await insertBatch(client, "equipment_types", cols, batch);
      for (let i = 0; i < ids.length; i += 1) {
        equipmentTypeMap.set(legacyIds[i], ids[i]);
        subtypeCategoryMap.set(legacyIds[i], categoryIds[i]);
      }
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
    {
      const prefixRows = (db.prepare("SELECT * FROM Prefix_Master").all() as any[]).sort(
        (a, b) => a.ID - b.ID,
      );
      const seenCategoryPrefixPairs = new Set<string>();
      const cols = ["legacy_id", "equipment_category_id", "prefix_name", "created_at", "updated_at"];
      const batch: unknown[][] = [];
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
        batch.push([r.ID, categoryId, r.Prefix_Name, dt, dt]);
      }
      await insertBatch(client, "equipment_prefixes", cols, batch);
      counts.equipment_prefixes = batch.length;
    }
    endStep("equipment_prefixes", counts.equipment_prefixes);

    // 2. components <- Component_Master (created before main_views/subviews)
    beginStep("components ← Component_Master");
    const componentMap = new Map<number, string>(); // legacy Component_Master.ID -> UUID
    {
      const cols = [
        "legacy_id",
        "component_code",
        "component_description",
        "is_disabled",
        "created_at",
        "updated_at",
      ];
      const batch: unknown[][] = [];
      const legacyIds: number[] = [];
      for (const r of db.prepare("SELECT * FROM Component_Master").all() as any[]) {
        const dt = parseLegacyDatetime(r.Datetime);
        legacyIds.push(r.ID);
        batch.push([r.ID, r.ComponentCode, r.ComponentDesc, false, dt, dt]);
      }
      const ids = await insertBatch(client, "components", cols, batch);
      for (let i = 0; i < ids.length; i += 1) componentMap.set(legacyIds[i], ids[i]);
    }
    counts.components = componentMap.size;
    endStep("components", counts.components);

    // main_views <- EquipmentMainView
    beginStep("main_views ← EquipmentMainView");
    const mainViewMap = new Map<number, string>(); // legacy EquipmentMainView.ID -> UUID
    {
      const cols = [
        "legacy_id",
        "equipment_type_id",
        "name",
        "bubble_name",
        "label_name",
        "sequence_number",
        "is_disabled",
        "created_at",
        "updated_at",
      ];
      const batch: unknown[][] = [];
      const legacyIds: number[] = [];
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
        legacyIds.push(r.ID);
        batch.push([
          r.ID,
          equipmentTypeId,
          r.Name,
          r.BubbleName,
          r.LabelName,
          r.SequenceNumber,
          false,
          dt,
          dt,
        ]);
      }
      const ids = await insertBatch(client, "main_views", cols, batch);
      for (let i = 0; i < ids.length; i += 1) mainViewMap.set(legacyIds[i], ids[i]);
    }
    counts.main_views = mainViewMap.size;
    endStep("main_views", counts.main_views);

    // subviews <- EquipmentSubView, pass 1 (parent_subview_id always NULL here)
    beginStep("subviews ← EquipmentSubView (pass 1)");
    const subviewMap = new Map<number, string>(); // legacy EquipmentSubView.ID -> UUID
    const subviewRows = db.prepare("SELECT * FROM EquipmentSubView").all() as any[];
    {
      const cols = [
        "legacy_id",
        "main_view_id",
        "parent_subview_id",
        "component_id",
        "name",
        "header",
        "is_disabled",
        "created_at",
        "updated_at",
      ];
      const batch: unknown[][] = [];
      const legacyIds: number[] = [];
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
        legacyIds.push(r.ID);
        batch.push([r.ID, mainViewId, null, componentId, r.Name, r.Header, false, dt, dt]);
      }
      const ids = await insertBatch(client, "subviews", cols, batch);
      for (let i = 0; i < ids.length; i += 1) subviewMap.set(legacyIds[i], ids[i]);
    }
    counts.subviews = subviewMap.size;
    endStep("subviews", counts.subviews);

    // subviews pass 2: resolve parent_subview_id. Trigger disabled around
    // the bulk UPDATE so it doesn't overwrite the updated_at set on insert
    // (schema-design.md's own bulk-load note).
    beginStep("subviews parent links (pass 2)");
    let parentLinksSet = 0;
    {
      const links: Array<{ childId: string; parentId: string }> = [];
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
        links.push({ childId, parentId });
      }
      parentLinksSet = links.length;
      if (!DRY_RUN && client) {
        await client.query("ALTER TABLE subviews DISABLE TRIGGER trg_subviews_set_updated_at");
        await updateParentLinksBatch(client, links);
        await client.query("ALTER TABLE subviews ENABLE TRIGGER trg_subviews_set_updated_at");
      }
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
    {
      const cols = [
        "legacy_id",
        "damage_code",
        "damage_description",
        "is_disabled",
        "created_at",
        "updated_at",
      ];
      const batch: unknown[][] = [];
      const legacyIds: number[] = [];
      for (const r of db.prepare("SELECT * FROM Damage_MST").all() as any[]) {
        const dt = parseLegacyDatetime(r.Datetime);
        legacyIds.push(r.ID);
        batch.push([r.ID, r.DamageCode, r.DamageDesc, false, dt, dt]);
      }
      const ids = await insertBatch(client, "damage_codes", cols, batch);
      for (let i = 0; i < ids.length; i += 1) damageCodeMap.set(legacyIds[i], ids[i]);
    }
    counts.damage_codes = damageCodeMap.size;
    endStep("damage_codes", counts.damage_codes);

    // Repairs_MST -> repair_codes, with the two documented code renames
    // (migration-plan.md §1.8): legacy ID 80 RT->RN, legacy ID 84 SI->PE.
    beginStep("repair_codes ← Repairs_MST");
    const REPAIR_CODE_RENAMES: Record<number, string> = { 80: "RN", 84: "PE" };
    const repairCodeMap = new Map<number, string>();
    {
      const cols = [
        "legacy_id",
        "repair_code",
        "repair_description",
        "is_disabled",
        "created_at",
        "updated_at",
      ];
      const batch: unknown[][] = [];
      const legacyIds: number[] = [];
      for (const r of db.prepare("SELECT * FROM Repairs_MST").all() as any[]) {
        const repairCode = REPAIR_CODE_RENAMES[r.ID] ?? r.RepairCode;
        const dt = parseLegacyDatetime(r.Datetime);
        legacyIds.push(r.ID);
        batch.push([r.ID, repairCode, r.RepairDesc, false, dt, dt]);
      }
      const ids = await insertBatch(client, "repair_codes", cols, batch);
      for (let i = 0; i < ids.length; i += 1) repairCodeMap.set(legacyIds[i], ids[i]);
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
    {
      const subviewDamageRows = (
        db.prepare("SELECT * FROM EquipmentSubView_Damage").all() as any[]
      ).sort((a, b) => a.ID - b.ID);
      const seenSubviewDamagePairs = new Set<string>();
      const cols = ["legacy_id", "subview_id", "damage_code_id", "created_at", "updated_at"];
      const batch: unknown[][] = [];
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
        batch.push([r.ID, subviewId, damageCodeId, dt, dt]);
      }
      await insertBatch(client, "subview_damages", cols, batch);
      counts.subview_damages = batch.length;
    }
    endStep("subview_damages", counts.subview_damages);

    // subview_repairs <- EquipmentSubView_Repair (skip RepairID_FK = -1)
    beginStep("subview_repairs ← EquipmentSubView_Repair");
    {
      const cols = ["legacy_id", "subview_id", "repair_code_id", "created_at", "updated_at"];
      const batch: unknown[][] = [];
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
        batch.push([r.ID, subviewId, repairCodeId, dt, dt]);
      }
      await insertBatch(client, "subview_repairs", cols, batch);
      counts.subview_repairs = batch.length;
    }
    endStep("subview_repairs", counts.subview_repairs);

    // 4. misc_items <- Misc_Master ---------------------------------------
    beginStep("misc_items ← Misc_Master");
    const miscItemMap = new Map<number, string>();
    {
      const cols = [
        "legacy_id",
        "equipment_category_id",
        "misc_name",
        "misc_code",
        "is_disabled",
        "created_at",
        "updated_at",
      ];
      const batch: unknown[][] = [];
      const legacyIds: number[] = [];
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
        legacyIds.push(r.ID);
        batch.push([r.ID, categoryId, r.Misc_Name, r.Misc_Code, false, dt, dt]);
      }
      const ids = await insertBatch(client, "misc_items", cols, batch);
      for (let i = 0; i < ids.length; i += 1) miscItemMap.set(legacyIds[i], ids[i]);
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
    {
      const mainViewMiscRows = (
        db.prepare("SELECT * FROM EquipmentMainView_Misc").all() as any[]
      ).sort((a, b) => a.ID - b.ID);
      const seenMainViewMiscPairs = new Set<string>();
      const cols = [
        "legacy_id",
        "main_view_id",
        "misc_item_id",
        "display_subview_id",
        "created_at",
        "updated_at",
      ];
      const batch: unknown[][] = [];
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
        batch.push([r.ID, mainViewId, miscItemId, null, dt, dt]);
      }
      await insertBatch(client, "main_view_misc_items", cols, batch);
      counts.main_view_misc_items = batch.length;
    }
    endStep("main_view_misc_items", counts.main_view_misc_items);

    // main_view_components <- Equipment_Misc. Skip ComponentID_FK = 0
    // sentinel, and de-dup (main_view, component) pairs keeping the lower
    // legacy ID (§1.17) — sort by ID ascending so "already inserted this
    // pair" always means "keep the earlier row, skip this one".
    beginStep("main_view_components ← Equipment_Misc");
    {
      const equipmentMiscRows = (db.prepare("SELECT * FROM Equipment_Misc").all() as any[]).sort(
        (a, b) => a.ID - b.ID,
      );
      const seenMainViewComponentPairs = new Set<string>();
      const cols = ["legacy_id", "main_view_id", "component_id", "created_at", "updated_at"];
      const batch: unknown[][] = [];
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
        batch.push([r.ID, mainViewId, componentId, dt, dt]);
      }
      await insertBatch(client, "main_view_components", cols, batch);
      counts.main_view_components = batch.length;
    }
    endStep("main_view_components", counts.main_view_components);

    // 5. widget_types <- UIComponent_Master (verbatim names, §1.13) ------
    beginStep("widget_types ← UIComponent_Master");
    const widgetTypeMap = new Map<number, string>();
    {
      const cols = ["legacy_id", "name", "is_disabled", "created_at", "updated_at"];
      const batch: unknown[][] = [];
      const legacyIds: number[] = [];
      for (const r of db.prepare("SELECT * FROM UIComponent_Master").all() as any[]) {
        const dt = parseLegacyDatetime(r.Datetime);
        legacyIds.push(r.ID);
        batch.push([r.ID, r.Name, false, dt, dt]);
      }
      const ids = await insertBatch(client, "widget_types", cols, batch);
      for (let i = 0; i < ids.length; i += 1) widgetTypeMap.set(legacyIds[i], ids[i]);
    }
    counts.widget_types = widgetTypeMap.size;
    endStep("widget_types", counts.widget_types);

    // subview_fields <- EquipmentSubView_ExtraBoxItem (field_name = slugify(Label), §1.14)
    beginStep("subview_fields ← EquipmentSubView_ExtraBoxItem");
    const subviewFieldMap = new Map<number, string>(); // legacy EquipmentSubView_ExtraBoxItem.ID -> UUID
    {
      const cols = [
        "legacy_id",
        "subview_id",
        "widget_type_id",
        "label",
        "field_name",
        "display_order",
        "created_at",
        "updated_at",
      ];
      const batch: unknown[][] = [];
      const legacyIds: number[] = [];
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
        legacyIds.push(r.ID);
        batch.push([
          r.ID,
          subviewId,
          widgetTypeId,
          r.Label,
          slugify(r.Label),
          r.Sequence,
          dt,
          dt,
        ]);
      }
      const ids = await insertBatch(client, "subview_fields", cols, batch);
      for (let i = 0; i < ids.length; i += 1) subviewFieldMap.set(legacyIds[i], ids[i]);
    }
    counts.subview_fields = subviewFieldMap.size;
    endStep("subview_fields", counts.subview_fields);

    // subview_field_options <- UIBox_Details. display_order = rank by
    // legacy ID ascending within each field (§1.15).
    beginStep("subview_field_options ← UIBox_Details");
    {
      const uiBoxRows = (db.prepare("SELECT * FROM UIBox_Details").all() as any[]).sort(
        (a, b) => a.ID - b.ID,
      );
      const orderCounters = new Map<number, number>(); // subview_field legacy ID -> next display_order
      const cols = [
        "legacy_id",
        "subview_field_id",
        "label_value",
        "display_order",
        "created_at",
        "updated_at",
      ];
      const batch: unknown[][] = [];
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
        batch.push([r.ID, fieldId, r.LabelValue, nextOrder, dt, dt]);
      }
      await insertBatch(client, "subview_field_options", cols, batch);
      counts.subview_field_options = batch.length;
    }
    endStep("subview_field_options", counts.subview_field_options);

    // 6. quick_actions <- Action_MST (§1.16) -------------------------------
    beginStep("quick_actions ← Action_MST");
    {
      const cols = [
        "legacy_id",
        "action_name",
        "repair_code_id",
        "component_id",
        "main_view_id",
        "subview_id",
        "is_disabled",
        "created_at",
        "updated_at",
      ];
      const batch: unknown[][] = [];
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
        batch.push([
          r.ID,
          r.Action,
          repairCodeId,
          componentId,
          mainViewId,
          subviewId,
          false,
          RUN_TIME,
          RUN_TIME,
        ]);
      }
      await insertBatch(client, "quick_actions", cols, batch);
      counts.quick_actions = batch.length;
    }
    endStep("quick_actions", counts.quick_actions);

    console.log(
      `\n=== Summary (${formatMs(Date.now() - runStartedAt)} total) ===`,
    );
    console.log(DRY_RUN ? "--dry-run summary (no DB writes) --" : "Row counts inserted:");
    console.table(counts);

    if (PARITY_JSON_PATH) {
      const report = {
        script: "migrate-legacy-data-batched.ts",
        dryRun: DRY_RUN,
        batchSize: BATCH_SIZE,
        counts,
        exceptions: exceptions.map((e) => ({
          rule: e.rule,
          table: e.table,
          legacyId: e.legacyId,
          detail: e.detail,
        })),
      };
      fs.writeFileSync(PARITY_JSON_PATH, JSON.stringify(report, null, 2));
      console.log(`Parity JSON written: ${PARITY_JSON_PATH}`);
    }

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
    `Generated ${new Date().toISOString()} by \`scripts/migrate-legacy-data-batched.ts\`.`,
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

if (require.main === module) {
  run().catch((err) => {
    console.error("Legacy data migration (batched) failed:", err);
    process.exitCode = 1;
  });
}
