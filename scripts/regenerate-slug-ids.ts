/**
 * Regenerate slug_id values on the 5 slug_id-bearing tables using the
 * application-layer generator in src/utils/slug-id.ts (nanoid-backed),
 * replacing the values migration 005 originally backfilled with Postgres's
 * own random()-based `generate_unique_slug_id()`.
 *
 * Safety properties:
 * - Only ever UPDATEs the slug_id column — no row is inserted or deleted,
 *   and no other column is touched, so there is no way for this to lose data.
 * - Each table is regenerated inside its own transaction, with the rows
 *   locked (`FOR UPDATE`) for the duration, so concurrent writers can't race
 *   with the reassignment.
 * - New values are checked for uniqueness against every slug_id already in
 *   the table (not just the batch being generated) before any UPDATE runs,
 *   so the UNIQUE constraint can never be violated mid-run.
 * - Before committing, the script re-counts the table and asserts:
 *     total rows == before-count (no rows lost/added)
 *     non-null slug_id count == total rows
 *     distinct slug_id count == total rows
 *   Any mismatch rolls the transaction back instead of committing.
 * - Defaults to a dry run (prints what it would change, writes nothing).
 *   Pass --apply to actually commit.
 *
 * Usage:
 *   ts-node scripts/regenerate-slug-ids.ts            # dry run
 *   ts-node scripts/regenerate-slug-ids.ts --apply     # actually update
 */

import { pool } from "../src/db/pool";
import { generateSlugId } from "../src/utils/slug-id";

const TABLES = [
  "equipment_categories",
  "equipment_types",
  "main_views",
  "subviews",
  "components",
] as const;

const APPLY = process.argv.includes("--apply");

async function generateUniqueSlugId(taken: Set<string>): Promise<string> {
  const MAX_ATTEMPTS = 20;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const candidate = await generateSlugId();
    if (!taken.has(candidate)) {
      taken.add(candidate);
      return candidate;
    }
  }
  throw new Error(
    `Failed to generate a unique slug_id after ${MAX_ATTEMPTS} attempts`,
  );
}

async function regenerateTable(table: string): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // Lock every row in this table for the duration of the transaction so no
    // concurrent writer can insert/update a slug_id underneath us.
    const { rows: existing } = await client.query<{ id: string; slug_id: string }>(
      `SELECT id, slug_id FROM ${table} FOR UPDATE`,
    );
    const beforeCount = existing.length;

    if (beforeCount === 0) {
      console.log(`[${table}] no rows — skipping`);
      await client.query("COMMIT");
      return;
    }

    // Seed the "taken" set with every slug_id currently in the table so a
    // freshly generated value can never collide with a row we haven't
    // reassigned yet.
    const taken = new Set(existing.map((r) => r.slug_id));

    const assignments: { id: string; slug_id: string }[] = [];
    for (const row of existing) {
      const newSlugId = await generateUniqueSlugId(taken);
      assignments.push({ id: row.id, slug_id: newSlugId });
    }

    if (!APPLY) {
      console.log(
        `[${table}] DRY RUN: would reassign ${assignments.length} slug_id(s). Sample: ${JSON.stringify(
          assignments.slice(0, 3),
        )}`,
      );
      await client.query("ROLLBACK");
      return;
    }

    for (const { id, slug_id } of assignments) {
      await client.query(`UPDATE ${table} SET slug_id = $1 WHERE id = $2`, [
        slug_id,
        id,
      ]);
    }

    // Verify no data was lost or duplicated before committing.
    const { rows: check } = await client.query<{
      total: string;
      non_null: string;
      distinct_count: string;
    }>(
      `SELECT COUNT(*) AS total,
              COUNT(slug_id) AS non_null,
              COUNT(DISTINCT slug_id) AS distinct_count
       FROM ${table}`,
    );
    const { total, non_null, distinct_count } = check[0];

    if (
      Number(total) !== beforeCount ||
      Number(non_null) !== beforeCount ||
      Number(distinct_count) !== beforeCount
    ) {
      throw new Error(
        `[${table}] verification failed after update: before=${beforeCount} total=${total} non_null=${non_null} distinct=${distinct_count} — rolling back`,
      );
    }

    await client.query("COMMIT");
    console.log(`[${table}] regenerated ${assignments.length} slug_id(s). OK.`);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

async function run(): Promise<void> {
  console.log(APPLY ? "Running in APPLY mode." : "Running in DRY RUN mode (pass --apply to commit).");
  for (const table of TABLES) {
    await regenerateTable(table);
  }
  console.log("Done.");
  await pool.end();
}

run().catch((err) => {
  console.error("slug_id regeneration failed:", err);
  process.exit(1);
});
