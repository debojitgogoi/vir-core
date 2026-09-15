import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { pool } from "../src/db/pool";
import { closeDb, resetDb } from "./helpers/db";
import { seedDepot, seedEquipmentType, seedJobCard } from "./helpers/fixtures";

beforeEach(async () => {
  await resetDb();
});

after(async () => {
  await closeDb();
});

async function card(): Promise<string> {
  return seedJobCard(await seedDepot(), await seedEquipmentType());
}

const RECEIPT = {
  nonce: "a".repeat(32),
  payload_hash: "b".repeat(64),
  receipt_hmac: "c".repeat(64),
};

function insert(jobCardId: string, overrides: Record<string, unknown> = {}) {
  const row = {
    signer_name: "A. Customer",
    signer_role: "CUSTOMER",
    signed_at: new Date().toISOString(),
    key_version: 1,
    payload_version: 1,
    ...RECEIPT,
    ...overrides,
  };
  return pool.query(
    `INSERT INTO job_card_signatures
       (job_card_id, signer_name, signer_role, signed_at, nonce,
        payload_hash, receipt_hmac, key_version, payload_version)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING *`,
    [
      jobCardId,
      row.signer_name,
      row.signer_role,
      row.signed_at,
      row.nonce,
      row.payload_hash,
      row.receipt_hmac,
      row.key_version,
      row.payload_version,
    ],
  );
}

test("a signature row stores no image, strokes, or biometric column", async () => {
  const { rows } = await pool.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_name = 'job_card_signatures'`,
  );
  const columns = rows.map((r) => r.column_name).sort();

  assert.deepEqual(columns, [
    "created_at",
    "created_by",
    "device_id",
    "id",
    "job_card_id",
    "key_version",
    "nonce",
    "payload_hash",
    "payload_version",
    "receipt_hmac",
    "signed_at",
    "signer_name",
    "signer_role",
  ]);
});

test("the table is append-only: no updated_at, no trigger", async () => {
  const { rows } = await pool.query(
    `SELECT tgname FROM pg_trigger t
     JOIN pg_class c ON c.oid = t.tgrelid
     WHERE c.relname = 'job_card_signatures' AND NOT t.tgisinternal`,
  );
  assert.equal(rows.length, 0, "a receipt that can be edited in place is not evidence");
});

test("an unknown signer_role is refused", async () => {
  const jobCardId = await card();
  await assert.rejects(() => insert(jobCardId, { signer_role: "MANAGER" }), /signer_role/);
});

test("a blank signer_name is refused", async () => {
  const jobCardId = await card();
  await assert.rejects(() => insert(jobCardId, { signer_name: "   " }), /signer_name/);
});

test("a payload_hash that is not 64 hex characters is refused", async () => {
  const jobCardId = await card();
  await assert.rejects(() => insert(jobCardId, { payload_hash: "short" }));
});

test("a nonce that is not 32 hex characters is refused", async () => {
  const jobCardId = await card();
  await assert.rejects(() => insert(jobCardId, { nonce: "not-hex" }));
});

test("two signatures may exist for one card", async () => {
  const jobCardId = await card();
  await insert(jobCardId);
  await insert(jobCardId, { nonce: "d".repeat(32) });

  const { rows } = await pool.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM job_card_signatures WHERE job_card_id = $1",
    [jobCardId],
  );
  assert.equal(rows[0].n, 2, "re-signing after an edit appends; the history stays");
});

test("deleting a card removes its signatures", async () => {
  const jobCardId = await card();
  await insert(jobCardId);

  await pool.query("DELETE FROM job_cards WHERE id = $1", [jobCardId]);

  const { rows } = await pool.query<{ n: number }>(
    "SELECT count(*)::int AS n FROM job_card_signatures",
  );
  assert.equal(rows[0].n, 0);
});
