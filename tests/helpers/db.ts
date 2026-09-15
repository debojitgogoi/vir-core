import { pool } from "../../src/db/pool";

/**
 * Tables cleared between tests, in no particular order — CASCADE handles the
 * foreign keys. Master data from migrations 004/006 is deliberately left
 * alone; tests that need an equipment type insert their own, and give it a
 * generated name, because nothing truncates equipment_categories between runs
 * and its name is UNIQUE.
 *
 * Note that TRUNCATE ... CASCADE also empties any table with a foreign key
 * into these — equipment_type_models references users, so it is cleared too.
 * That is fine for a test database and is the reason bootstrap.ts refuses to
 * run against a URL that is not obviously a test one.
 */
const TRANSACTIONAL_TABLES = [
  "inspection_item_media",
  "inspection_item_damages",
  "inspection_item_repairs",
  "inspection_items",
  "job_card_signatures",
  "job_card_media",
  "media_assets",
  "job_card_events",
  "job_cards",
  "depot_members",
  "depots",
  "refresh_tokens",
  "users",
];

/**
 * Filtered to tables that currently exist before truncating: this list names
 * tables from migrations this phase has not written yet (depots/job_cards
 * land in later tasks), and Postgres refuses to TRUNCATE a relation that
 * isn't there, CASCADE or not. Once those migrations land the filter is a
 * no-op — every name in the list resolves and all of them get truncated.
 */
export async function resetDb(): Promise<void> {
  const { rows } = await pool.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = ANY($1)",
    [TRANSACTIONAL_TABLES],
  );
  if (rows.length === 0) return;
  const existing = rows.map((r) => r.tablename);
  await pool.query(`TRUNCATE ${existing.join(", ")} CASCADE`);
}

export async function closeDb(): Promise<void> {
  await pool.end();
}
