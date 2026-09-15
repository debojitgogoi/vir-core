import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import * as service from "../src/services/signatures.service";
import * as repo from "../src/db/signatures.repo";
import { AppError } from "../src/middleware/errors";
import { pool } from "../src/db/pool";
import { closeDb, resetDb } from "./helpers/db";
import { createTestUser } from "./helpers/auth";
import { seedDepot, seedEquipmentType, seedJobCard } from "./helpers/fixtures";

beforeEach(async () => {
  await resetDb();
});

after(async () => {
  await closeDb();
});

async function context() {
  const depotId = await seedDepot();
  const jobCardId = await seedJobCard(depotId, await seedEquipmentType());
  const user = await createTestUser({ role: "MECHANIC" });
  return { depotId, jobCardId, actorId: user.id };
}

const body = { signer_name: "A. Customer", signer_role: "CUSTOMER" as const, device_id: null };

test("recording returns a receipt and never leaks the HMAC or the nonce", async () => {
  const { jobCardId, actorId } = await context();

  const dto = await service.recordSignature(jobCardId, body, actorId);

  assert.equal(dto.signer_name, "A. Customer");
  assert.match(dto.payload_hash, /^[0-9a-f]{64}$/);
  assert.equal(dto.key_version, 1);
  assert.equal(dto.payload_version, 1);
  assert.equal(dto.created_by, actorId);
  assert.ok(!("receipt_hmac" in dto), "the HMAC is the server's evidence, not a client field");
  assert.ok(!("nonce" in dto), "publishing the nonce hands out an input the HMAC binds");
});

test("an unsigned card verifies as NO_SIGNATURE", async () => {
  const { jobCardId } = await context();

  assert.deepEqual(await service.verifySignature(jobCardId), {
    valid: false,
    reason: "NO_SIGNATURE",
  });
});

test("a freshly recorded signature verifies", async () => {
  const { jobCardId, actorId } = await context();
  await service.recordSignature(jobCardId, body, actorId);

  const result = await service.verifySignature(jobCardId);

  assert.equal(result.valid, true);
  assert.equal(result.valid && result.signer_name, "A. Customer");
  assert.equal(result.valid && result.signer_role, "CUSTOMER");
});

test("editing an acknowledged field invalidates the receipt", async () => {
  const { jobCardId, actorId } = await context();
  await service.recordSignature(jobCardId, body, actorId);

  await pool.query("UPDATE job_cards SET chassis_number = 'CHS-CHANGED' WHERE id = $1", [
    jobCardId,
  ]);

  assert.deepEqual(await service.verifySignature(jobCardId), {
    valid: false,
    reason: "CONTENT_MODIFIED",
  });
});

test("a field outside the payload does not invalidate the receipt", async () => {
  const { jobCardId, actorId } = await context();
  await service.recordSignature(jobCardId, body, actorId);

  // Touching the row moves updated_at, which is deliberately not acknowledged:
  // a receipt that broke on every save would be worthless.
  await pool.query("UPDATE job_cards SET updated_by = $2 WHERE id = $1", [jobCardId, actorId]);

  assert.equal((await service.verifySignature(jobCardId)).valid, true);
});

test("submitting a card does not invalidate the acknowledgment that permitted it", async () => {
  const { jobCardId, actorId } = await context();
  await service.recordSignature(jobCardId, body, actorId);

  await pool.query(
    "UPDATE job_cards SET status = 'SUBMITTED', locked_at = now(), submitted_at = now() WHERE id = $1",
    [jobCardId],
  );

  assert.equal((await service.verifySignature(jobCardId)).valid, true);
});

test("re-signing after an edit makes the card valid again, and keeps the history", async () => {
  const { jobCardId, actorId } = await context();
  await service.recordSignature(jobCardId, body, actorId);
  await pool.query("UPDATE job_cards SET chassis_number = 'CHS-CHANGED' WHERE id = $1", [
    jobCardId,
  ]);

  await service.recordSignature(jobCardId, { ...body, signer_name: "B. Customer" }, actorId);

  const result = await service.verifySignature(jobCardId);
  assert.equal(result.valid, true);
  assert.equal(result.valid && result.signer_name, "B. Customer");
  assert.equal((await service.listSignatureHistory(jobCardId)).length, 2);
});

test("editing the stored HMAC directly is reported as tampering, not as a content change", async () => {
  const { jobCardId, actorId } = await context();
  await service.recordSignature(jobCardId, body, actorId);

  await pool.query("UPDATE job_card_signatures SET receipt_hmac = $1 WHERE job_card_id = $2", [
    "f".repeat(64),
    jobCardId,
  ]);

  assert.deepEqual(
    await service.verifySignature(jobCardId),
    { valid: false, reason: "RECEIPT_TAMPERED" },
    "'re-sign the card' would be exactly the wrong advice here",
  );
});

test("editing the stored signer_name is reported as tampering", async () => {
  const { jobCardId, actorId } = await context();
  await service.recordSignature(jobCardId, body, actorId);

  await pool.query("UPDATE job_card_signatures SET signer_name = $1 WHERE job_card_id = $2", [
    "Someone Else",
    jobCardId,
  ]);

  assert.deepEqual(await service.verifySignature(jobCardId), {
    valid: false,
    reason: "RECEIPT_TAMPERED",
  });
});

test("editing the stored signed_at is reported as tampering", async () => {
  const { jobCardId, actorId } = await context();
  await service.recordSignature(jobCardId, body, actorId);

  await pool.query("UPDATE job_card_signatures SET signed_at = now() - interval '1 day' WHERE job_card_id = $1", [
    jobCardId,
  ]);

  assert.deepEqual(await service.verifySignature(jobCardId), {
    valid: false,
    reason: "RECEIPT_TAMPERED",
  });
});

test("a receipt signed with a key this build lacks is unverifiable, not invalid", async () => {
  const { jobCardId, actorId } = await context();
  await service.recordSignature(jobCardId, body, actorId);

  await pool.query("UPDATE job_card_signatures SET key_version = 9 WHERE job_card_id = $1", [
    jobCardId,
  ]);

  assert.deepEqual(
    await service.verifySignature(jobCardId),
    { valid: false, reason: "RECEIPT_UNVERIFIABLE" },
    "a retired key is not a failed acknowledgment",
  );
});

test("a receipt covering a payload version this build lacks is unverifiable", async () => {
  const { jobCardId, actorId } = await context();
  await service.recordSignature(jobCardId, body, actorId);

  await pool.query("UPDATE job_card_signatures SET payload_version = 9 WHERE job_card_id = $1", [
    jobCardId,
  ]);

  assert.deepEqual(await service.verifySignature(jobCardId), {
    valid: false,
    reason: "RECEIPT_UNVERIFIABLE",
  });
});

test("only the latest receipt decides validity", async () => {
  const { jobCardId, actorId } = await context();
  await service.recordSignature(jobCardId, body, actorId);
  await pool.query("UPDATE job_cards SET chassis_number = 'CHS-CHANGED' WHERE id = $1", [
    jobCardId,
  ]);
  await service.recordSignature(jobCardId, body, actorId);

  assert.equal(
    (await service.verifySignature(jobCardId)).valid,
    true,
    "the superseded receipt still fails on its own, and that is not the answer",
  );
});

test("signing an unknown card is 404", async () => {
  const { actorId } = await context();

  await assert.rejects(
    () => service.recordSignature("00000000-0000-0000-0000-000000000000", body, actorId),
    (err: AppError) => err.status === 404,
  );
});

test("verifying an unknown card is 404, not NO_SIGNATURE", async () => {
  await assert.rejects(
    () => service.verifySignature("00000000-0000-0000-0000-000000000000"),
    (err: AppError) => err.status === 404,
    "a card that does not exist is a different answer from a card nobody signed",
  );
});

test("listing the history of an unknown card is 404", async () => {
  await assert.rejects(
    () => service.listSignatureHistory("00000000-0000-0000-0000-000000000000"),
    (err: AppError) => err.status === 404,
  );
});

test("a client-supplied signed_at within the window is kept", async () => {
  const { jobCardId, actorId } = await context();
  const captured = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();

  const dto = await service.recordSignature(jobCardId, { ...body, signed_at: captured }, actorId);

  assert.equal(dto.signed_at, captured, "a tablet that was offline keeps the time it recorded");
});

test("a signed_at backdated beyond the window is refused", async () => {
  const { jobCardId, actorId } = await context();
  const tooOld = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();

  await assert.rejects(
    () => service.recordSignature(jobCardId, { ...body, signed_at: tooOld }, actorId),
    (err: AppError) => err.status === 400 && err.code === "VALIDATION_ERROR",
  );
});

test("a signed_at in the future is refused", async () => {
  const { jobCardId, actorId } = await context();
  const future = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  await assert.rejects(
    () => service.recordSignature(jobCardId, { ...body, signed_at: future }, actorId),
    (err: AppError) => err.status === 400,
  );
});

test("each receipt gets its own nonce, so identical signings differ", async () => {
  const { jobCardId, actorId } = await context();

  await service.recordSignature(jobCardId, body, actorId);
  await service.recordSignature(jobCardId, body, actorId);

  const rows = await repo.listSignatures(jobCardId);
  assert.notEqual(rows[0].nonce, rows[1].nonce);
  assert.notEqual(rows[0].receipt_hmac, rows[1].receipt_hmac);
  assert.equal(rows[0].payload_hash, rows[1].payload_hash, "the content did not change");
});
