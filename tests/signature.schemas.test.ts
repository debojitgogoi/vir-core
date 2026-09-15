import assert from "node:assert/strict";
import { test } from "node:test";
import { recordSignatureSchema } from "../src/schemas/signature.schemas";

const valid = { signer_name: "A. Customer", signer_role: "CUSTOMER" };

test("a minimal body parses, and device_id defaults to null", () => {
  const parsed = recordSignatureSchema.parse(valid);

  assert.equal(parsed.signer_name, "A. Customer");
  assert.equal(parsed.signer_role, "CUSTOMER");
  assert.equal(parsed.device_id, null);
  assert.equal(parsed.signed_at, undefined, "absent means the server timestamps it");
});

test("signer_name is trimmed", () => {
  assert.equal(
    recordSignatureSchema.parse({ ...valid, signer_name: "  A. Customer " }).signer_name,
    "A. Customer",
  );
});

test("a blank signer_name is refused", () => {
  for (const signer_name of ["", "   "]) {
    assert.equal(recordSignatureSchema.safeParse({ ...valid, signer_name }).success, false);
  }
});

test("an over-long signer_name is refused", () => {
  assert.equal(
    recordSignatureSchema.safeParse({ ...valid, signer_name: "x".repeat(121) }).success,
    false,
  );
  assert.equal(
    recordSignatureSchema.safeParse({ ...valid, signer_name: "x".repeat(120) }).success,
    true,
  );
});

test("every signer role in the enum is accepted, and nothing else", () => {
  for (const signer_role of ["CUSTOMER", "DRIVER", "TRUCKER"]) {
    assert.equal(recordSignatureSchema.safeParse({ ...valid, signer_role }).success, true);
  }
  assert.equal(recordSignatureSchema.safeParse({ ...valid, signer_role: "MANAGER" }).success, false);
});

test("a whitespace-only device_id becomes null", () => {
  assert.equal(recordSignatureSchema.parse({ ...valid, device_id: "   " }).device_id, null);
});

test("signed_at must be an ISO 8601 timestamp with an offset", () => {
  assert.equal(
    recordSignatureSchema.safeParse({ ...valid, signed_at: "2026-09-05T09:00:00.000Z" }).success,
    true,
  );
  assert.equal(recordSignatureSchema.safeParse({ ...valid, signed_at: "2026-09-05" }).success, false);
});

test("an unknown key is refused, not silently ignored", () => {
  // .strict() throughout: a misspelled field on a form the customer is
  // acknowledging must be a 400, never a quietly dropped value.
  assert.equal(recordSignatureSchema.safeParse({ ...valid, signer_nmae: "A" }).success, false);
});

test("no receipt field can be supplied by a client", () => {
  for (const field of ["payload_hash", "receipt_hmac", "nonce", "key_version", "payload_version"]) {
    assert.equal(
      recordSignatureSchema.safeParse({ ...valid, [field]: "f".repeat(64) }).success,
      false,
      `${field} is the server's to compute; accepting one would defeat the scheme`,
    );
  }
});
