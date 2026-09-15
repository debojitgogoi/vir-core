/**
 * Parity checks: original migrate-legacy-data.ts vs migrate-legacy-data-batched.ts.
 *
 * Modes:
 *   --dry-run-only   (default) compare counts + exceptions from dry runs
 *   --live-local     also apply both against local Docker Postgres and diff content
 *   --repeat=N       re-run dry-run parity N times (default 3)
 *
 * Live local uses DATABASE_URL pointing at a disposable DB (created if needed):
 *   postgres://postgres:postgres@127.0.0.1:5432/vir_legacy_parity
 */
import { spawnSync } from "child_process";
import crypto from "crypto";
import fs from "fs";
import path from "path";
import { Client } from "pg";

const ROOT = path.join(__dirname, "..");
const TMP = path.join(ROOT, "legacy_data", "_parity_tmp");
const LIVE = process.argv.includes("--live-local");
const REPEAT = (() => {
  const arg = process.argv.find((a) => a.startsWith("--repeat="));
  return arg ? Math.max(1, Number(arg.slice("--repeat=".length)) || 1) : 3;
})();

const LOCAL_URL =
  process.env.PARITY_DATABASE_URL ??
  "postgres://postgres:postgres@127.0.0.1:5432/vir_legacy_parity";

const EQUIPMENT_TABLES = [
  "equipment_categories",
  "equipment_types",
  "equipment_prefixes",
  "components",
  "main_views",
  "subviews",
  "damage_codes",
  "repair_codes",
  "subview_damages",
  "subview_repairs",
  "misc_items",
  "main_view_misc_items",
  "main_view_components",
  "widget_types",
  "subview_fields",
  "subview_field_options",
  "quick_actions",
] as const;

interface ExceptionRow {
  rule: string;
  table: string;
  legacyId: number;
  detail: string;
}

interface Report {
  counts: Record<string, number>;
  exceptions: ExceptionRow[];
}

function ensureTmp(): void {
  fs.mkdirSync(TMP, { recursive: true });
}

function runNode(scriptRel: string, args: string[], env?: NodeJS.ProcessEnv): string {
  const result = spawnSync(
    process.execPath,
    ["-r", "ts-node/register", path.join(ROOT, scriptRel), ...args],
    {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, ...env, DOTENV_CONFIG_QUIET: "true" },
      maxBuffer: 64 * 1024 * 1024,
    },
  );
  if (result.status !== 0) {
    console.error(result.stdout);
    console.error(result.stderr);
    throw new Error(`${scriptRel} exited ${result.status}`);
  }
  return result.stdout + result.stderr;
}

function parseCountsFromStdout(stdout: string): Record<string, number> {
  const counts: Record<string, number> = {};
  // console.table(Record) prints: │ key │ value │
  const re = /│\s([a-z_]+)\s+│\s+(\d+)\s+│/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(stdout)) !== null) {
    counts[m[1]] = Number(m[2]);
  }
  if (Object.keys(counts).length < 10) {
    throw new Error(`Failed to parse counts from stdout (got ${Object.keys(counts).length} keys)`);
  }
  return counts;
}

function parseExceptionsMarkdown(filePath: string): ExceptionRow[] {
  if (!fs.existsSync(filePath)) return [];
  const text = fs.readFileSync(filePath, "utf8");
  const rows: ExceptionRow[] = [];
  let rule = "";
  for (const line of text.split("\n")) {
    const h = /^## (.+) \(\d+\)$/.exec(line);
    if (h) {
      rule = h[1];
      continue;
    }
    const row = /^\| (.+) \| (\d+) \| (.+) \|$/.exec(line);
    if (row && row[1] !== "Table") {
      rows.push({
        rule,
        table: row[1].trim(),
        legacyId: Number(row[2]),
        detail: row[3].trim(),
      });
    }
  }
  return rows;
}

function exceptionKey(e: ExceptionRow): string {
  return `${e.rule}\t${e.table}\t${e.legacyId}\t${e.detail}`;
}

function sortExceptions(list: ExceptionRow[]): ExceptionRow[] {
  return [...list].sort((a, b) => exceptionKey(a).localeCompare(exceptionKey(b)));
}

function compareReports(label: string, a: Report, b: Report): void {
  const countKeys = new Set([...Object.keys(a.counts), ...Object.keys(b.counts)]);
  const countDiffs: string[] = [];
  for (const k of [...countKeys].sort()) {
    if (a.counts[k] !== b.counts[k]) {
      countDiffs.push(`${k}: original=${a.counts[k]} batched=${b.counts[k]}`);
    }
  }
  if (countDiffs.length) {
    throw new Error(`${label}: count mismatch\n${countDiffs.join("\n")}`);
  }

  const ae = sortExceptions(a.exceptions).map(exceptionKey);
  const be = sortExceptions(b.exceptions).map(exceptionKey);
  if (ae.length !== be.length) {
    throw new Error(
      `${label}: exception count mismatch original=${ae.length} batched=${be.length}`,
    );
  }
  for (let i = 0; i < ae.length; i += 1) {
    if (ae[i] !== be[i]) {
      throw new Error(
        `${label}: exception mismatch at ${i}\n  original: ${ae[i]}\n  batched:  ${be[i]}`,
      );
    }
  }
  console.log(
    `${label}: OK — ${Object.keys(a.counts).length} count keys, ${ae.length} exceptions match`,
  );
}

function runDryParityOnce(round: number): void {
  console.log(`\n--- dry-run parity round ${round}/${REPEAT} ---`);
  const origEx = path.join(ROOT, "legacy_data", "migration-exceptions.md");
  const batEx = path.join(ROOT, "legacy_data", "migration-exceptions-batched.md");
  for (const p of [origEx, batEx]) {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  }

  const origOut = runNode("scripts/migrate-legacy-data.ts", ["--dry-run"]);
  const orig: Report = {
    counts: parseCountsFromStdout(origOut),
    exceptions: parseExceptionsMarkdown(origEx),
  };
  fs.writeFileSync(path.join(TMP, `original-r${round}.json`), JSON.stringify(orig, null, 2));

  const batArgs = [
    "--dry-run",
    `--parity-json=${path.join(TMP, `batched-r${round}.json`)}`,
    `--batch-size=${round % 2 === 0 ? 17 : 500}`, // exercise odd chunk sizes
  ];
  const batOut = runNode("scripts/migrate-legacy-data-batched.ts", batArgs);
  const batParity = JSON.parse(
    fs.readFileSync(path.join(TMP, `batched-r${round}.json`), "utf8"),
  ) as { counts: Record<string, number>; exceptions: ExceptionRow[] };
  const batFromStdout: Report = {
    counts: parseCountsFromStdout(batOut),
    exceptions: parseExceptionsMarkdown(batEx),
  };

  // Internal consistency: parity JSON vs stdout/markdown for batched
  compareReports(`round ${round} batched self-check`, batFromStdout, {
    counts: batParity.counts,
    exceptions: batParity.exceptions,
  });
  compareReports(`round ${round} original vs batched`, orig, batFromStdout);
}

async function withClient<T>(fn: (c: Client) => Promise<T>): Promise<T> {
  const c = new Client({ connectionString: LOCAL_URL });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

async function resetLocalSchema(): Promise<void> {
  const adminUrl = LOCAL_URL.replace(/\/[^/]+(\?.*)?$/, "/postgres$1");
  const dbName = new URL(LOCAL_URL).pathname.replace(/^\//, "");
  const admin = new Client({ connectionString: adminUrl });
  await admin.connect();
  try {
    await admin.query(
      `SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()`,
      [dbName],
    );
    await admin.query(`DROP DATABASE IF EXISTS ${dbName}`);
    await admin.query(`CREATE DATABASE ${dbName}`);
  } finally {
    await admin.end();
  }

  await withClient(async (c) => {
    for (const file of [
      "001_init.sql",
      "002_users_and_refresh_tokens.sql",
      "003_app_config.sql",
      "004_equipment_inspection_schema.sql",
    ]) {
      const sql = fs.readFileSync(path.join(ROOT, "migrations", file), "utf8");
      await c.query(sql);
      console.log(`Applied ${file}`);
    }
  });
}

async function truncateEquipment(): Promise<void> {
  await withClient(async (c) => {
    await c.query(
      `TRUNCATE ${EQUIPMENT_TABLES.join(", ")} RESTART IDENTITY CASCADE`,
    );
  });
}

async function snapshotContent(): Promise<Record<string, string>> {
  // Fingerprint by legacy_id graph (not raw UUIDs — those differ every run).
  const queries: Record<string, string> = {
    equipment_categories: `
      SELECT legacy_id::text || '|' || name || '|' || is_disabled::text AS line
      FROM equipment_categories ORDER BY legacy_id`,
    equipment_types: `
      SELECT t.legacy_id::text || '|' || c.legacy_id::text || '|' || t.name || '|' || t.is_disabled::text AS line
      FROM equipment_types t
      JOIN equipment_categories c ON c.id = t.equipment_category_id
      ORDER BY t.legacy_id`,
    equipment_prefixes: `
      SELECT p.legacy_id::text || '|' || c.legacy_id::text || '|' || p.prefix_name AS line
      FROM equipment_prefixes p
      JOIN equipment_categories c ON c.id = p.equipment_category_id
      ORDER BY p.legacy_id`,
    components: `
      SELECT legacy_id::text || '|' || component_code || '|' || COALESCE(component_description,'') || '|' || is_disabled::text AS line
      FROM components ORDER BY legacy_id`,
    main_views: `
      SELECT m.legacy_id::text || '|' || t.legacy_id::text || '|' || m.name || '|' || COALESCE(m.bubble_name,'')
        || '|' || COALESCE(m.label_name,'') || '|' || COALESCE(m.sequence_number::text,'') || '|' || m.is_disabled::text AS line
      FROM main_views m
      JOIN equipment_types t ON t.id = m.equipment_type_id
      ORDER BY m.legacy_id`,
    subviews: `
      SELECT s.legacy_id::text || '|' || m.legacy_id::text || '|' || COALESCE(p.legacy_id::text,'NULL')
        || '|' || COALESCE(c.legacy_id::text,'NULL') || '|' || s.name || '|' || COALESCE(s.header,'')
        || '|' || s.is_disabled::text AS line
      FROM subviews s
      JOIN main_views m ON m.id = s.main_view_id
      LEFT JOIN subviews p ON p.id = s.parent_subview_id
      LEFT JOIN components c ON c.id = s.component_id
      ORDER BY s.legacy_id`,
    damage_codes: `
      SELECT legacy_id::text || '|' || damage_code || '|' || COALESCE(damage_description,'') || '|' || is_disabled::text AS line
      FROM damage_codes ORDER BY legacy_id`,
    repair_codes: `
      SELECT legacy_id::text || '|' || repair_code || '|' || COALESCE(repair_description,'') || '|' || is_disabled::text AS line
      FROM repair_codes ORDER BY legacy_id`,
    subview_damages: `
      SELECT d.legacy_id::text || '|' || s.legacy_id::text || '|' || dc.legacy_id::text AS line
      FROM subview_damages d
      JOIN subviews s ON s.id = d.subview_id
      JOIN damage_codes dc ON dc.id = d.damage_code_id
      ORDER BY d.legacy_id`,
    subview_repairs: `
      SELECT r.legacy_id::text || '|' || s.legacy_id::text || '|' || rc.legacy_id::text AS line
      FROM subview_repairs r
      JOIN subviews s ON s.id = r.subview_id
      JOIN repair_codes rc ON rc.id = r.repair_code_id
      ORDER BY r.legacy_id`,
    misc_items: `
      SELECT m.legacy_id::text || '|' || c.legacy_id::text || '|' || m.misc_name || '|' || m.misc_code || '|' || m.is_disabled::text AS line
      FROM misc_items m
      JOIN equipment_categories c ON c.id = m.equipment_category_id
      ORDER BY m.legacy_id`,
    main_view_misc_items: `
      SELECT x.legacy_id::text || '|' || mv.legacy_id::text || '|' || mi.legacy_id::text
        || '|' || COALESCE(sv.legacy_id::text,'NULL') AS line
      FROM main_view_misc_items x
      JOIN main_views mv ON mv.id = x.main_view_id
      JOIN misc_items mi ON mi.id = x.misc_item_id
      LEFT JOIN subviews sv ON sv.id = x.display_subview_id
      ORDER BY x.legacy_id`,
    main_view_components: `
      SELECT x.legacy_id::text || '|' || mv.legacy_id::text || '|' || c.legacy_id::text AS line
      FROM main_view_components x
      JOIN main_views mv ON mv.id = x.main_view_id
      JOIN components c ON c.id = x.component_id
      ORDER BY x.legacy_id`,
    widget_types: `
      SELECT legacy_id::text || '|' || name || '|' || is_disabled::text AS line
      FROM widget_types ORDER BY legacy_id`,
    subview_fields: `
      SELECT f.legacy_id::text || '|' || s.legacy_id::text || '|' || w.legacy_id::text
        || '|' || f.label || '|' || f.field_name || '|' || f.display_order::text AS line
      FROM subview_fields f
      JOIN subviews s ON s.id = f.subview_id
      JOIN widget_types w ON w.id = f.widget_type_id
      ORDER BY f.legacy_id`,
    subview_field_options: `
      SELECT o.legacy_id::text || '|' || f.legacy_id::text || '|' || o.label_value || '|' || o.display_order::text AS line
      FROM subview_field_options o
      JOIN subview_fields f ON f.id = o.subview_field_id
      ORDER BY o.legacy_id`,
    quick_actions: `
      SELECT q.legacy_id::text || '|' || q.action_name
        || '|' || COALESCE(rc.legacy_id::text,'NULL')
        || '|' || COALESCE(c.legacy_id::text,'NULL')
        || '|' || COALESCE(mv.legacy_id::text,'NULL')
        || '|' || COALESCE(sv.legacy_id::text,'NULL')
        || '|' || q.is_disabled::text AS line
      FROM quick_actions q
      LEFT JOIN repair_codes rc ON rc.id = q.repair_code_id
      LEFT JOIN components c ON c.id = q.component_id
      LEFT JOIN main_views mv ON mv.id = q.main_view_id
      LEFT JOIN subviews sv ON sv.id = q.subview_id
      ORDER BY q.legacy_id`,
  };

  return withClient(async (c) => {
    const out: Record<string, string> = {};
    for (const [table, sql] of Object.entries(queries)) {
      const { rows } = await c.query<{ line: string }>(sql);
      const body = rows.map((r) => r.line).join("\n");
      out[table] = crypto.createHash("sha256").update(body).digest("hex") + `:${rows.length}`;
      fs.writeFileSync(path.join(TMP, `${table}.tsv`), body);
    }
    return out;
  });
}

async function runLiveParity(): Promise<void> {
  console.log("\n=== live local Postgres parity ===");
  console.log(`DB: ${LOCAL_URL.replace(/:[^:@/]+@/, ":***@")}`);
  await resetLocalSchema();

  console.log("\nApplying batched migrator…");
  const t0 = Date.now();
  runNode("scripts/migrate-legacy-data-batched.ts", ["--batch-size=500"], {
    DATABASE_URL: LOCAL_URL,
  });
  const batchedMs = Date.now() - t0;
  const snapBatched = await snapshotContent();
  fs.writeFileSync(
    path.join(TMP, "snapshot-batched.json"),
    JSON.stringify(snapBatched, null, 2),
  );
  console.log(`Batched apply wall time: ${(batchedMs / 1000).toFixed(1)}s`);

  await truncateEquipment();

  console.log("\nApplying original migrator…");
  const t1 = Date.now();
  runNode("scripts/migrate-legacy-data.ts", [], { DATABASE_URL: LOCAL_URL });
  const originalMs = Date.now() - t1;
  const snapOriginal = await snapshotContent();
  fs.writeFileSync(
    path.join(TMP, "snapshot-original.json"),
    JSON.stringify(snapOriginal, null, 2),
  );
  console.log(`Original apply wall time: ${(originalMs / 1000).toFixed(1)}s`);

  const keys = new Set([...Object.keys(snapBatched), ...Object.keys(snapOriginal)]);
  const diffs: string[] = [];
  for (const k of [...keys].sort()) {
    if (snapBatched[k] !== snapOriginal[k]) {
      diffs.push(`${k}: batched=${snapBatched[k]} original=${snapOriginal[k]}`);
    }
  }
  if (diffs.length) {
    throw new Error(`Live content mismatch:\n${diffs.join("\n")}`);
  }
  console.log(
    `Live content: OK — ${keys.size} fingerprints match. Speedup ≈ ${(originalMs / Math.max(batchedMs, 1)).toFixed(1)}x`,
  );

  // Second live pass with tiny batches to catch chunk-boundary bugs
  await truncateEquipment();
  console.log("\nRe-applying batched with --batch-size=7…");
  runNode("scripts/migrate-legacy-data-batched.ts", ["--batch-size=7"], {
    DATABASE_URL: LOCAL_URL,
  });
  const snapTiny = await snapshotContent();
  const tinyDiffs: string[] = [];
  for (const k of [...keys].sort()) {
    if (snapTiny[k] !== snapOriginal[k]) {
      tinyDiffs.push(`${k}: tiny=${snapTiny[k]} original=${snapOriginal[k]}`);
    }
  }
  if (tinyDiffs.length) {
    throw new Error(`Tiny-batch content mismatch:\n${tinyDiffs.join("\n")}`);
  }
  console.log("Tiny-batch content: OK");
}

async function main(): Promise<void> {
  ensureTmp();
  for (let i = 1; i <= REPEAT; i += 1) {
    runDryParityOnce(i);
  }
  // Cross-round stability: all original dry-run reports identical
  const r1 = JSON.parse(fs.readFileSync(path.join(TMP, "original-r1.json"), "utf8")) as Report;
  for (let i = 2; i <= REPEAT; i += 1) {
    const ri = JSON.parse(
      fs.readFileSync(path.join(TMP, `original-r${i}.json`), "utf8"),
    ) as Report;
    compareReports(`stability original r1 vs r${i}`, r1, ri);
  }

  if (LIVE) {
    await runLiveParity();
  } else {
    console.log("\n(Skipping --live-local; pass it to compare real Postgres contents.)");
  }

  console.log("\nAll parity checks passed.");
}

main().catch((err) => {
  console.error("Parity failed:", err);
  process.exitCode = 1;
});
