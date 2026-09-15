import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import * as repo from "../src/db/depots.repo";
import { closeDb, resetDb } from "./helpers/db";
import { createTestUser } from "./helpers/auth";

beforeEach(async () => {
  await resetDb();
});

after(async () => {
  await closeDb();
});

test("insertDepot then findDepotById round-trips", async () => {
  const created = await repo.insertDepot({
    slugId: "AAAAAAAA",
    code: "LAX",
    name: "Los Angeles",
    timezone: "America/Los_Angeles",
    address: null,
  });

  const found = await repo.findDepotById(created.id);
  assert.equal(found?.code, "LAX");
  assert.equal(found?.timezone, "America/Los_Angeles");
  assert.equal(found?.is_disabled, false);
});

test("listDepots paginates and reports the total", async () => {
  for (let i = 0; i < 3; i += 1) {
    await repo.insertDepot({
      slugId: `SLUG000${i}`,
      code: `D${i}`,
      name: `Depot ${i}`,
      timezone: "UTC",
      address: null,
    });
  }

  const page = await repo.listDepots({ limit: 2, offset: 0 });
  assert.equal(page.rows.length, 2);
  assert.equal(page.total, 3);

  // Verify that internal pagination artifact (total_count) is stripped
  assert.strictEqual((page.rows[0] as unknown as Record<string, unknown>).total_count, undefined);
});

test("assignUserToDepot deactivates any prior active membership", async () => {
  const user = await createTestUser({ role: "MECHANIC" });
  const a = await repo.insertDepot({ slugId: "AAAAAAAA", code: "LAX", name: "LA", timezone: "UTC", address: null });
  const b = await repo.insertDepot({ slugId: "BBBBBBBB", code: "SEA", name: "Seattle", timezone: "UTC", address: null });

  await repo.assignUserToDepot(a.id, user.id);
  await repo.assignUserToDepot(b.id, user.id);

  const active = await repo.findActiveDepotForUser(user.id);
  assert.equal(active?.code, "SEA");
});

test("deactivateMembership leaves the user with no active depot", async () => {
  const user = await createTestUser({ role: "MECHANIC" });
  const a = await repo.insertDepot({ slugId: "AAAAAAAA", code: "LAX", name: "LA", timezone: "UTC", address: null });

  await repo.assignUserToDepot(a.id, user.id);
  const removed = await repo.deactivateMembership(a.id, user.id);

  assert.equal(removed, true);
  assert.equal(await repo.findActiveDepotForUser(user.id), null);
});

test("listActiveMembers returns the depot's current users", async () => {
  const user = await createTestUser({ role: "MECHANIC", name: "Dana" });
  const a = await repo.insertDepot({ slugId: "AAAAAAAA", code: "LAX", name: "LA", timezone: "UTC", address: null });
  await repo.assignUserToDepot(a.id, user.id);

  const members = await repo.listActiveMembers(a.id);
  assert.equal(members.length, 1);
  assert.equal(members[0].name, "Dana");
  assert.equal(members[0].role, "MECHANIC");
});
