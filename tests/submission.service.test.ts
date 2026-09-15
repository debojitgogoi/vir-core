import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { submitJobCard } from "../src/services/submission.service";
import * as itemsService from "../src/services/inspectionItems.service";
import * as signaturesService from "../src/services/signatures.service";
import { listJobCardEvents } from "../src/db/jobCardEvents.repo";
import { pool } from "../src/db/pool";
import { AppError } from "../src/middleware/errors";
import { closeDb, resetDb } from "./helpers/db";
import { createTestUser } from "./helpers/auth";
import { seedDepot, seedEquipmentType, seedJobCard } from "./helpers/fixtures";

beforeEach(async () => {
  await resetDb();
});

after(async () => {
  await closeDb();
});

const MISSING = "00000000-0000-0000-0000-000000000000";

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

async function cardRow(jobCardId: string) {
  const { rows } = await pool.query<{
    status: string;
    locked_at: Date | null;
    submitted_at: Date | null;
    submitted_by: string | null;
  }>("SELECT status, locked_at, submitted_at, submitted_by FROM job_cards WHERE id = $1", [
    jobCardId,
  ]);
  return rows[0];
}

test("submitting a ready card locks it and records who and when", async () => {
  const { jobCardId, actorId } = await readyCard();

  const dto = await submitJobCard(jobCardId, actorId);

  assert.equal(dto.status, "SUBMITTED");
  assert.equal(dto.can_edit, false);
  assert.ok(dto.submitted_at);
  assert.ok(dto.locked_at);
  assert.equal(dto.submitted_by, actorId);
});

test("the event records where the card actually came from, not a hard-coded status", async () => {
  const { jobCardId, actorId } = await readyCard();

  await submitJobCard(jobCardId, actorId);

  const events = await listJobCardEvents(jobCardId);
  assert.deepEqual(
    events.map((e) => [e.from_status, e.to_status]),
    [
      ["DRAFT", "IN_INSPECTION"],
      ["IN_INSPECTION", "SUBMITTED"],
    ],
    "the first item write moved it to IN_INSPECTION; submit must say so",
  );
  assert.equal(events[1].actor_user_id, actorId);
});

test("a card submitted straight from DRAFT records DRAFT as its previous status", async () => {
  const depotId = await seedDepot();
  const jobCardId = await seedJobCard(depotId, await seedEquipmentType(), COMPLETE);
  const user = await createTestUser({ role: "MECHANIC" });

  // Insert the item without going through the service, so the card stays DRAFT.
  await pool.query("INSERT INTO inspection_items (job_card_id, notes) VALUES ($1, 'dent')", [
    jobCardId,
  ]);
  await signaturesService.recordSignature(
    jobCardId,
    { signer_name: "A. Customer", signer_role: "CUSTOMER", device_id: null },
    user.id,
  );

  await submitJobCard(jobCardId, user.id);

  const [event] = await listJobCardEvents(jobCardId);
  assert.equal(event.from_status, "DRAFT");
});

test("an incomplete card is 422 SUBMISSION_INCOMPLETE and is left untouched", async () => {
  const { jobCardId, actorId } = await readyCard();
  await pool.query("DELETE FROM inspection_items WHERE job_card_id = $1", [jobCardId]);

  await assert.rejects(
    () => submitJobCard(jobCardId, actorId),
    (err: AppError) =>
      err.status === 422 &&
      err.code === "SUBMISSION_INCOMPLETE" &&
      (err.details?.length ?? 0) > 0,
  );

  const row = await cardRow(jobCardId);
  assert.equal(row.status, "IN_INSPECTION", "a partial transition is the failure that matters");
  assert.equal(row.locked_at, null);
  assert.equal(row.submitted_at, null);
});

test("re-submitting is 200 with the current state, and writes no second event", async () => {
  const { jobCardId, actorId } = await readyCard();

  const first = await submitJobCard(jobCardId, actorId);
  const second = await submitJobCard(jobCardId, actorId);

  assert.equal(second.status, "SUBMITTED");
  assert.equal(
    second.submitted_at,
    first.submitted_at,
    "a retry must not move the moment the card was submitted",
  );
  assert.equal(
    (await listJobCardEvents(jobCardId)).filter((e) => e.to_status === "SUBMITTED").length,
    1,
  );
});

test("a card that became invalid after submission still re-submits idempotently", async () => {
  const { jobCardId, actorId } = await readyCard();
  await submitJobCard(jobCardId, actorId);

  // The receipt is now unverifiable. The card is already submitted, so the
  // validation gate is behind it and a retry must still answer with the record.
  await pool.query("UPDATE job_card_signatures SET key_version = 9 WHERE job_card_id = $1", [
    jobCardId,
  ]);

  const again = await submitJobCard(jobCardId, actorId);
  assert.equal(again.status, "SUBMITTED");
});

test("two concurrent submits produce one transition and one event", async () => {
  const { jobCardId, actorId } = await readyCard();

  const [a, b] = await Promise.all([
    submitJobCard(jobCardId, actorId),
    submitJobCard(jobCardId, actorId),
  ]);

  assert.equal(a.status, "SUBMITTED");
  assert.equal(b.status, "SUBMITTED");
  assert.equal(
    (await listJobCardEvents(jobCardId)).filter((e) => e.to_status === "SUBMITTED").length,
    1,
    "the FOR UPDATE lock is what makes a double-tap one submission",
  );
});

test("submitting an unknown card is 404", async () => {
  const user = await createTestUser({ role: "MECHANIC" });

  await assert.rejects(
    () => submitJobCard(MISSING, user.id),
    (err: AppError) => err.status === 404,
  );
});

test("submission sets the one column the lock middleware reads", async () => {
  const { jobCardId, actorId } = await readyCard();

  await submitJobCard(jobCardId, actorId);

  const row = await cardRow(jobCardId);
  assert.ok(
    row.locked_at,
    "requireUnlockedJobCard reads locked_at rather than reasoning about the status list, " +
      "so a new status added later cannot accidentally reopen a frozen card",
  );
  // The service layer itself has no lock check, by design: every mutating route
  // passes through requireUnlockedJobCard, and duplicating the rule here would
  // be a second place for it to drift. tests/submission.routes.test.ts asserts
  // the 409 the client actually sees.
});
