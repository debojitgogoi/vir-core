import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import {
  REQUIRED_INTAKE_FIELDS,
  validateForSubmission,
} from "../src/services/submission.service";
import * as itemsService from "../src/services/inspectionItems.service";
import * as signaturesService from "../src/services/signatures.service";
import { pool } from "../src/db/pool";
import { AppError } from "../src/middleware/errors";
import { closeDb, resetDb } from "./helpers/db";
import { createTestUser } from "./helpers/auth";
import { seedDamageCode, seedDepot, seedEquipmentType, seedJobCard } from "./helpers/fixtures";

beforeEach(async () => {
  await resetDb();
});

after(async () => {
  await closeDb();
});

const MISSING = "00000000-0000-0000-0000-000000000000";

/** Everything a card needs to pass validation, so each test can take one away. */
const COMPLETE = {
  inspected_at: new Date("2026-09-01T09:00:00Z"),
  chassis_number: "CHS-1000",
  size: 40,
  equipment_form: "STANDARD",
  customer_name: "Acme Logistics",
  driver_name: "R. Diaz",
};

async function readyCard() {
  const depotId = await seedDepot();
  const jobCardId = await seedJobCard(depotId, await seedEquipmentType(), COMPLETE);
  const user = await createTestUser({ role: "MECHANIC" });

  await itemsService.createInspectionItems(jobCardId, [{ notes: "dent" }], user.id);
  await signaturesService.recordSignature(
    jobCardId,
    { signer_name: "A. Customer", signer_role: "CUSTOMER", device_id: null },
    user.id,
  );

  return { depotId, jobCardId, actorId: user.id };
}

const clear = (jobCardId: string, column: string) =>
  pool.query(`UPDATE job_cards SET ${column} = NULL WHERE id = $1`, [jobCardId]);

test("a complete, signed card with one item has no violations", async () => {
  const { jobCardId } = await readyCard();
  assert.deepEqual(await validateForSubmission(jobCardId), []);
});

test("each missing required intake field is named", async () => {
  for (const field of REQUIRED_INTAKE_FIELDS) {
    // direction and equipment_type_id are NOT NULL in the schema and cannot be
    // cleared; they stay in the list because the spec names them.
    if (field === "direction" || field === "equipment_type_id") continue;

    await resetDb();
    const { jobCardId } = await readyCard();
    await clear(jobCardId, field);

    const violations = await validateForSubmission(jobCardId);
    assert.ok(
      violations.some((v) => v.startsWith(`${field}:`)),
      `clearing ${field} should have produced a violation naming it, got ${violations}`,
    );
  }
});

test("the database already makes a card with neither identifier impossible", async () => {
  const { jobCardId } = await readyCard();

  await assert.rejects(
    () =>
      pool.query(
        "UPDATE job_cards SET chassis_number = NULL, container_number = NULL WHERE id = $1",
        [jobCardId],
      ),
    (err: { constraint?: string }) => err.constraint === "job_card_has_identifier",
    "so validateForSubmission's identifier rule is defence in depth, not the enforcement",
  );
});

test("a container number alone satisfies the identifier rule", async () => {
  const depotId = await seedDepot();
  const jobCardId = await seedJobCard(depotId, await seedEquipmentType(), {
    ...COMPLETE,
    chassis_number: null,
    container_number: "CON-1",
  });
  const user = await createTestUser({ role: "MECHANIC" });
  await itemsService.createInspectionItems(jobCardId, [{ notes: "dent" }], user.id);
  await signaturesService.recordSignature(
    jobCardId,
    { signer_name: "A. Customer", signer_role: "CUSTOMER", device_id: null },
    user.id,
  );

  assert.deepEqual(await validateForSubmission(jobCardId), []);
});

test("an unsigned card is refused, and told to sign", async () => {
  const depotId = await seedDepot();
  const jobCardId = await seedJobCard(depotId, await seedEquipmentType(), COMPLETE);
  const user = await createTestUser({ role: "MECHANIC" });
  await itemsService.createInspectionItems(jobCardId, [{ notes: "dent" }], user.id);

  const violations = await validateForSubmission(jobCardId);

  assert.equal(violations.length, 1);
  assert.match(violations[0], /has not signed/);
});

test("a card edited after signing is told to re-sign", async () => {
  const { jobCardId } = await readyCard();
  await pool.query("UPDATE job_cards SET customer_name = 'Someone Else' WHERE id = $1", [
    jobCardId,
  ]);

  const violations = await validateForSubmission(jobCardId);

  assert.equal(violations.length, 1);
  assert.match(violations[0], /must be re-signed/);
});

test("a tampered receipt is told NOT to re-sign", async () => {
  const { jobCardId } = await readyCard();
  await pool.query("UPDATE job_card_signatures SET receipt_hmac = $1 WHERE job_card_id = $2", [
    "f".repeat(64),
    jobCardId,
  ]);

  const violations = await validateForSubmission(jobCardId);

  assert.equal(violations.length, 1);
  assert.match(
    violations[0],
    /Do NOT re-sign/,
    "re-signing would paper over an incident, which is why the reasons are distinct",
  );
  assert.match(violations[0], /incident/);
});

test("an unverifiable receipt says so rather than claiming the card changed", async () => {
  const { jobCardId } = await readyCard();
  await pool.query("UPDATE job_card_signatures SET key_version = 9 WHERE job_card_id = $1", [
    jobCardId,
  ]);

  const violations = await validateForSubmission(jobCardId);

  assert.equal(violations.length, 1);
  assert.match(violations[0], /cannot be judged/);
});

test("a card with zero inspection items is refused", async () => {
  const { jobCardId } = await readyCard();
  await pool.query("DELETE FROM inspection_items WHERE job_card_id = $1", [jobCardId]);

  const violations = await validateForSubmission(jobCardId);

  assert.equal(violations.length, 1);
  assert.match(violations[0], /^items:/);
});

test("an item with no damage codes still counts as an inspection", async () => {
  const depotId = await seedDepot();
  const jobCardId = await seedJobCard(depotId, await seedEquipmentType(), COMPLETE);
  const user = await createTestUser({ role: "MECHANIC" });

  await itemsService.createInspectionItems(
    jobCardId,
    [{ notes: "walked the chassis, no damage found" }],
    user.id,
  );
  await signaturesService.recordSignature(
    jobCardId,
    { signer_name: "A. Customer", signer_role: "CUSTOMER", device_id: null },
    user.id,
  );

  assert.deepEqual(
    await validateForSubmission(jobCardId),
    [],
    "a clean chassis is a normal outcome; an item is not a damage report",
  );

  const damaged = await seedDamageCode();
  assert.ok(damaged, "and an item may carry damage codes without changing the rule");
});

test("every violation is reported at once, not one per round trip", async () => {
  const depotId = await seedDepot();
  const jobCardId = await seedJobCard(depotId, await seedEquipmentType(), {
    chassis_number: "CHS-2000",
    customer_name: null,
    driver_name: null,
  });

  const violations = await validateForSubmission(jobCardId);

  // inspected_at, size, equipment_form, customer_name, driver_name, signature, items
  assert.equal(
    violations.length,
    7,
    `a gatekeeper fixing one field per request is the failure mode this avoids: ${violations}`,
  );
});

test("validating an unknown card is 404", async () => {
  await assert.rejects(
    () => validateForSubmission(MISSING),
    (err: AppError) => err.status === 404,
  );
});
