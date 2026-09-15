import crypto from "node:crypto";
import { env } from "../config/env";
import { JobCardDto, SignerRole } from "../types";

/**
 * The signature receipt scheme. Both directions live here so signing and
 * verification cannot drift apart: the service composes these functions and
 * never reimplements any part of them.
 *
 *   payload_hash = SHA256(canonical_json_of_acknowledged_fields)
 *   receipt_hmac = HMAC-SHA256(key_v{n}, bind(payload_hash, signer_name,
 *                              signer_role, signed_at, nonce, job_card_id))
 *
 * What it proves: this server recorded an acknowledgment of this exact content
 * at this time, and any later edit to an acknowledged field is detectable.
 * What it does not prove: that the customer personally signed, or anything at
 * all against the server operator, who holds the key. Per-device asymmetric
 * keys would be needed for that, and were judged heavier than warranted.
 */

/** The field list a receipt covers, by version. */
const PAYLOAD_FIELDS: Readonly<Record<number, readonly (keyof JobCardDto)[]>> = {
  // v1: everything the gatekeeper typed on the intake form, plus the job
  // number the customer sees on paper.
  //
  // Server bookkeeping is excluded -- a receipt that broke every time
  // `updated_at` moved would be useless -- and so are `status` and
  // `locked_at`, which change when the card is submitted, an act that must not
  // invalidate the acknowledgment that permitted it. `can_edit` is excluded
  // because it is computed per caller: letting it in would make a receipt's
  // validity depend on who asked.
  //
  // Media and line items are NOT covered by v1. Photographs attach through a
  // separate flow and Phase 5 adds line items; extending the payload to reach
  // them is a version 2, never an edit to this list -- editing it would
  // silently invalidate every receipt already written.
  1: [
    "chassis_number",
    "container_number",
    "customer_account_no",
    "customer_name",
    "direction",
    "driver_name",
    "equipment_form",
    "equipment_prefix_id",
    "equipment_type_id",
    "fhwa_sticker_date",
    "genset_status",
    "inspected_at",
    "job_number",
    "license_expiry_date",
    "license_plate",
    "license_state",
    "location",
    "manufacture_year",
    "on_hire_date",
    "pool_point",
    "prefix_text",
    "redelivery_release_no",
    "registration_status",
    "scac_code",
    "serial_number",
    "size",
    "trucker_name",
  ],
};

export const CURRENT_PAYLOAD_VERSION = 1;

export class UnknownPayloadVersionError extends Error {
  constructor(version: number) {
    super(`No payload field list for version ${version}`);
    this.name = "UnknownPayloadVersionError";
  }
}

export class UnknownKeyVersionError extends Error {
  constructor(version: number) {
    super(`No signing key configured for version ${version}`);
    this.name = "UnknownKeyVersionError";
  }
}

/**
 * Deterministic JSON over the acknowledged fields.
 *
 * The DTO is the input rather than the database row because the DTO has
 * already normalized every `Date` to ISO-8601 UTC and every DATE column to a
 * plain YYYY-MM-DD string. Canonicalizing the row instead would mean
 * re-implementing that normalization in a second place where it could
 * disagree -- and `pg` returning a DATE as a local-midnight `Date` was already
 * one data-corruption bug in Phase 2.
 *
 * `undefined` normalizes to `null` so that "field absent" and "field cleared"
 * hash identically; they mean the same thing to the customer reading the form.
 */
export function canonicalize(card: JobCardDto, payloadVersion: number): string {
  const fields = PAYLOAD_FIELDS[payloadVersion];
  if (!fields) throw new UnknownPayloadVersionError(payloadVersion);

  const canonical: Record<string, unknown> = {
    // Inside the hashed object, not beside it: a receipt must not be
    // re-interpretable under a different field list than the one it covered.
    _payload_version: payloadVersion,
  };
  for (const field of [...fields].sort()) {
    const value = card[field];
    canonical[field] = value === undefined ? null : value;
  }

  // Keys were inserted in sorted order and JSON.stringify preserves insertion
  // order for string keys, so this is stable regardless of how the DTO passed
  // in was built. `_payload_version` sorts ahead of every lowercase field
  // name, which is cosmetic -- what matters is that the order is a function of
  // the field list alone.
  return JSON.stringify(canonical);
}

export function payloadHash(card: JobCardDto, payloadVersion: number): string {
  return crypto
    .createHash("sha256")
    .update(canonicalize(card, payloadVersion), "utf8")
    .digest("hex");
}

export interface ReceiptInput {
  jobCardId: string;
  signerName: string;
  signerRole: SignerRole;
  signedAtIso: string;
  nonce: string;
  payloadHash: string;
}

/**
 * 16 random bytes, hex. Server-generated: a client-supplied nonce would let a
 * caller replay a receipt it had already seen.
 */
export function newNonce(): string {
  return crypto.randomBytes(16).toString("hex");
}

/**
 * Length-prefixed concatenation, not plain joining.
 *
 * `signer_name` is free text a customer dictates. With plain concatenation or
 * a separator character, a crafted name could shift the boundary between two
 * fields and reproduce a different receipt's input -- the classic HMAC
 * canonicalization break. Prefixing each part with its byte length makes the
 * encoding injective for every possible input, including one containing the
 * separator, a newline, or a length prefix of its own.
 */
function bind(input: ReceiptInput): string {
  const parts = [
    input.payloadHash,
    input.signerName,
    input.signerRole,
    input.signedAtIso,
    input.nonce,
    input.jobCardId,
  ];
  return parts.map((part) => `${Buffer.byteLength(part, "utf8")}:${part}`).join("");
}

export function computeHmac(input: ReceiptInput, keyVersion: number): string {
  const key = env.signatureKeys[keyVersion];
  if (!key) throw new UnknownKeyVersionError(keyVersion);
  return crypto.createHmac("sha256", key).update(bind(input), "utf8").digest("hex");
}

export function signReceipt(input: ReceiptInput): { hmac: string; keyVersion: number } {
  const keyVersion = env.signatureKeyVersion;
  return { hmac: computeHmac(input, keyVersion), keyVersion };
}

/**
 * Constant-time comparison of two hex digests. `===` on a secret-derived value
 * leaks its prefix through timing. The two are always the same length in
 * practice, so the length check guards against a malformed stored row rather
 * than being a branch an attacker can steer.
 */
export function hmacEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return crypto.timingSafeEqual(left, right);
}
