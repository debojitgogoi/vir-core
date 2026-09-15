import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { pool } from "../src/db/pool";
import { backfillDepots } from "../scripts/backfill-depots";
import { closeDb, resetDb } from "./helpers/db";
import { createTestUser } from "./helpers/auth";

beforeEach(async () => {
  await resetDb();
});

after(async () => {
  await closeDb();
});

async function setLocation(userId: string, location: string | null): Promise<void> {
  await pool.query("UPDATE users SET location = $1 WHERE id = $2", [location, userId]);
}

test("each distinct location becomes one depot with its users assigned", async () => {
  const a = await createTestUser({ role: "MECHANIC" });
  const b = await createTestUser({ role: "MECHANIC" });
  const c = await createTestUser({ role: "ESTIMATOR" });
  await setLocation(a.id, "Los Angeles");
  await setLocation(b.id, "los angeles ");
  await setLocation(c.id, "Seattle");

  const result = await backfillDepots();

  assert.equal(result.depotsCreated, 2, "case and whitespace variants collapse");
  assert.equal(result.usersAssigned, 3);

  const { rows } = await pool.query<{ count: string }>(
    `SELECT count(*) FROM depot_members WHERE is_active`,
  );
  assert.equal(rows[0].count, "3");
});

test("users without a location are skipped", async () => {
  const a = await createTestUser({ role: "MECHANIC" });
  await setLocation(a.id, null);

  const result = await backfillDepots();

  assert.equal(result.depotsCreated, 0);
  assert.equal(result.usersAssigned, 0);
});

test("running twice is idempotent", async () => {
  const a = await createTestUser({ role: "MECHANIC" });
  await setLocation(a.id, "Los Angeles");

  await backfillDepots();
  const second = await backfillDepots();

  assert.equal(second.depotsCreated, 0);
  assert.equal(second.usersAssigned, 0, "an already-assigned user is left alone");
});
