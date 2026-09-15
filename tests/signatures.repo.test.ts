import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import * as repo from "../src/db/signatures.repo";
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
  return { jobCardId, actorId: user.id };
}

function input(
  jobCardId: string,
  actorId: string,
  overrides: Partial<repo.InsertSignatureInput> = {},
): repo.InsertSignatureInput {
  return {
    jobCardId,
    signerName: "A. Customer",
    signerRole: "CUSTOMER",
    signedAt: new Date("2026-09-05T09:00:00.000Z"),
    nonce: "a".repeat(32),
    payloadHash: "b".repeat(64),
    receiptHmac: "c".repeat(64),
    keyVersion: 1,
    payloadVersion: 1,
    deviceId: "tablet-7",
    createdBy: actorId,
    ...overrides,
  };
}

test("inserting returns the stored row", async () => {
  const { jobCardId, actorId } = await context();

  const row = await repo.insertSignature(input(jobCardId, actorId));

  assert.equal(row.job_card_id, jobCardId);
  assert.equal(row.signer_name, "A. Customer");
  assert.equal(row.signer_role, "CUSTOMER");
  assert.equal(row.signed_at.toISOString(), "2026-09-05T09:00:00.000Z");
  assert.equal(row.device_id, "tablet-7");
  assert.equal(row.created_by, actorId);
  assert.equal(row.nonce, "a".repeat(32));
  assert.equal(row.payload_hash, "b".repeat(64));
  assert.equal(row.receipt_hmac, "c".repeat(64));
});

test("SMALLINT versions come back as numbers, not strings", async () => {
  // BIGINT arrives as a string and needed converting at this boundary for
  // media. SMALLINT does not — pinned here rather than assumed.
  const { jobCardId, actorId } = await context();

  const row = await repo.insertSignature(input(jobCardId, actorId, { keyVersion: 2 }));

  assert.strictEqual(row.key_version, 2);
  assert.strictEqual(row.payload_version, 1);
});

test("CHAR(64) digests are not padded on the way back", async () => {
  // CHAR pads on storage. A padded digest would fail every later comparison
  // in a way that looks like tampering.
  const { jobCardId, actorId } = await context();

  const row = await repo.insertSignature(input(jobCardId, actorId));

  assert.equal(row.payload_hash.length, 64);
  assert.equal(row.receipt_hmac.length, 64);
});

test("a null device_id and created_by are accepted", async () => {
  const { jobCardId, actorId } = await context();

  const row = await repo.insertSignature(
    input(jobCardId, actorId, { deviceId: null, createdBy: null }),
  );

  assert.equal(row.device_id, null);
  assert.equal(row.created_by, null);
});

test("the latest signature is the most recently created one", async () => {
  const { jobCardId, actorId } = await context();

  await repo.insertSignature(input(jobCardId, actorId, { signerName: "First" }));
  await repo.insertSignature(
    input(jobCardId, actorId, { signerName: "Second", nonce: "d".repeat(32) }),
  );

  const latest = await repo.findLatestSignature(jobCardId);
  assert.equal(latest?.signer_name, "Second");
});

test("the latest signature is not the one with the latest signed_at", async () => {
  // A backdated re-signature is still the effective one: it is what the
  // customer most recently agreed to, whatever time the tablet recorded.
  const { jobCardId, actorId } = await context();

  await repo.insertSignature(
    input(jobCardId, actorId, {
      signerName: "First",
      signedAt: new Date("2026-09-05T12:00:00.000Z"),
    }),
  );
  await repo.insertSignature(
    input(jobCardId, actorId, {
      signerName: "Second",
      signedAt: new Date("2026-09-05T06:00:00.000Z"),
      nonce: "d".repeat(32),
    }),
  );

  const latest = await repo.findLatestSignature(jobCardId);
  assert.equal(latest?.signer_name, "Second");
});

test("a card with no signature has no latest", async () => {
  const { jobCardId } = await context();
  assert.equal(await repo.findLatestSignature(jobCardId), null);
});

test("listing returns the whole history, newest first", async () => {
  const { jobCardId, actorId } = await context();

  await repo.insertSignature(input(jobCardId, actorId, { signerName: "First" }));
  await repo.insertSignature(
    input(jobCardId, actorId, { signerName: "Second", nonce: "d".repeat(32) }),
  );

  const rows = await repo.listSignatures(jobCardId);
  assert.deepEqual(
    rows.map((r) => r.signer_name),
    ["Second", "First"],
  );
});

test("listing a card with no signatures is empty, not an error", async () => {
  const { jobCardId } = await context();
  assert.deepEqual(await repo.listSignatures(jobCardId), []);
});

test("one card's signatures are invisible to another card", async () => {
  const { jobCardId, actorId } = await context();
  const other = await context();
  await repo.insertSignature(input(jobCardId, actorId));

  assert.equal(await repo.findLatestSignature(other.jobCardId), null);
  assert.deepEqual(await repo.listSignatures(other.jobCardId), []);
});
