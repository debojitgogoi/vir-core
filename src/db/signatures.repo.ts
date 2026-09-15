import { pool } from "./pool";
import { SignerRole } from "../types";

export interface SignatureRow {
  id: string;
  job_card_id: string;
  signer_name: string;
  signer_role: SignerRole;
  signed_at: Date;
  nonce: string;
  payload_hash: string;
  receipt_hmac: string;
  // SMALLINT, which node-postgres parses to a JS number. Unlike BIGINT, which
  // arrives as a string and needed converting at this boundary for media.
  key_version: number;
  payload_version: number;
  device_id: string | null;
  created_by: string | null;
  created_at: Date;
}

export interface InsertSignatureInput {
  jobCardId: string;
  signerName: string;
  signerRole: SignerRole;
  signedAt: Date;
  nonce: string;
  payloadHash: string;
  receiptHmac: string;
  keyVersion: number;
  payloadVersion: number;
  deviceId: string | null;
  createdBy: string | null;
}

const COLUMNS = `id, job_card_id, signer_name, signer_role, signed_at, nonce,
                 payload_hash, receipt_hmac, key_version, payload_version,
                 device_id, created_by, created_at`;

/** Append-only: there is no update and no delete on this table, by design. */
export async function insertSignature(input: InsertSignatureInput): Promise<SignatureRow> {
  const { rows } = await pool.query<SignatureRow>(
    `INSERT INTO job_card_signatures
       (job_card_id, signer_name, signer_role, signed_at, nonce, payload_hash,
        receipt_hmac, key_version, payload_version, device_id, created_by)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     RETURNING ${COLUMNS}`,
    [
      input.jobCardId,
      input.signerName,
      input.signerRole,
      input.signedAt,
      input.nonce,
      input.payloadHash,
      input.receiptHmac,
      input.keyVersion,
      input.payloadVersion,
      input.deviceId,
      input.createdBy,
    ],
  );
  return rows[0];
}

/**
 * The effective receipt: the most recently *recorded* one, not the one with
 * the latest `signed_at`. A backdated re-signature is still the thing the
 * customer most recently agreed to, whatever time the tablet wrote on it.
 *
 * Ordered by `created_at` alone. An `id` tiebreak was here before, but `id` is
 * a random `gen_random_uuid()` with no relationship to insertion order, so it
 * broke ties by chance rather than by recency — no more correct than leaving
 * a genuine tie to Postgres, just consistently so. Each signature is its own
 * INSERT statement (never batched inside one transaction the way inspection
 * items are), so two rows sharing one `created_at` down to the microsecond
 * would need two requests to race that closely; recording only one signature
 * per request keeps that as the actual bar for a real double-write, not a
 * tiebreak papering over one.
 */
export async function findLatestSignature(jobCardId: string): Promise<SignatureRow | null> {
  const { rows } = await pool.query<SignatureRow>(
    `SELECT ${COLUMNS} FROM job_card_signatures
     WHERE job_card_id = $1
     ORDER BY created_at DESC
     LIMIT 1`,
    [jobCardId],
  );
  return rows[0] ?? null;
}

export async function listSignatures(jobCardId: string): Promise<SignatureRow[]> {
  const { rows } = await pool.query<SignatureRow>(
    `SELECT ${COLUMNS} FROM job_card_signatures
     WHERE job_card_id = $1
     ORDER BY created_at DESC`,
    [jobCardId],
  );
  return rows;
}
