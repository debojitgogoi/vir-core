import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { pool } from "../src/db/pool";
import { closeDb, resetDb } from "./helpers/db";
import { createTestUser } from "./helpers/auth";

beforeEach(async () => {
  await resetDb();
});

after(async () => {
  await closeDb();
});

async function insertDepot(code: string, slug: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `INSERT INTO depots (slug_id, code, name) VALUES ($1, $2, $3) RETURNING id`,
    [slug, code, `${code} Depot`],
  );
  return rows[0].id;
}

test("a user cannot hold two active depot memberships", async () => {
  const user = await createTestUser({ role: "MECHANIC" });
  const depotA = await insertDepot("LAX", "AAAAAAAA");
  const depotB = await insertDepot("SEA", "BBBBBBBB");

  await pool.query(
    `INSERT INTO depot_members (depot_id, user_id) VALUES ($1, $2)`,
    [depotA, user.id],
  );

  await assert.rejects(
    () =>
      pool.query(`INSERT INTO depot_members (depot_id, user_id) VALUES ($1, $2)`, [
        depotB,
        user.id,
      ]),
    (err: { code?: string }) => err.code === "23505",
  );
});

test("a deactivated membership frees the user for reassignment", async () => {
  const user = await createTestUser({ role: "MECHANIC" });
  const depotA = await insertDepot("LAX", "AAAAAAAA");
  const depotB = await insertDepot("SEA", "BBBBBBBB");

  await pool.query(
    `INSERT INTO depot_members (depot_id, user_id) VALUES ($1, $2)`,
    [depotA, user.id],
  );
  await pool.query(
    `UPDATE depot_members SET is_active = false, unassigned_at = now()
     WHERE user_id = $1 AND is_active`,
    [user.id],
  );
  await pool.query(
    `INSERT INTO depot_members (depot_id, user_id) VALUES ($1, $2)`,
    [depotB, user.id],
  );

  const { rows } = await pool.query<{ count: string }>(
    `SELECT count(*) FROM depot_members WHERE user_id = $1`,
    [user.id],
  );
  assert.equal(rows[0].count, "2");
});

test("depot codes are unique", async () => {
  await insertDepot("LAX", "AAAAAAAA");
  await assert.rejects(
    () => insertDepot("LAX", "CCCCCCCC"),
    (err: { code?: string }) => err.code === "23505",
  );
});
