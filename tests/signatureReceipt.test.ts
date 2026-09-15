import assert from "node:assert/strict";
import { test } from "node:test";
import * as receipt from "../src/utils/signatureReceipt";
import { JobCardDto } from "../src/types";

/**
 * A complete card DTO. Every field carries a distinct value so a mix-up
 * between two of them shows up as a hash change rather than passing silently.
 */
function card(overrides: Partial<JobCardDto> = {}): JobCardDto {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    job_number: "VIR-ABCD1234",
    depot_id: "22222222-2222-4222-8222-222222222222",
    status: "DRAFT",
    client_uuid: null,

    direction: "INBOUND",
    equipment_type_id: "33333333-3333-4333-8333-333333333333",
    trucker_name: "Trucker Ltd",
    location: "Bay 4",
    inspected_at: "2026-09-05T08:30:00.000Z",
    equipment_prefix_id: null,
    prefix_text: "ACME",
    container_number: null,
    chassis_number: "CHS-9001",
    genset_status: null,
    size: 40,
    equipment_form: "STANDARD",
    serial_number: "SN-77",
    license_plate: "TX-1234",
    license_state: "TX",
    license_expiry_date: "2027-01-31",
    registration_status: "OK",
    pool_point: "Houston",
    customer_name: "Acme Freight",
    redelivery_release_no: "RR-1",
    customer_account_no: "ACC-1",
    on_hire_date: "2026-03-01",
    scac_code: "ACME",
    fhwa_sticker_date: "2026-06-30",
    driver_name: "R. Driver",
    manufacture_year: 2019,

    created_by: null,
    updated_by: null,
    submitted_by: null,
    submitted_at: null,
    locked_at: null,
    can_edit: true,
    created_at: "2026-09-05T08:00:00.000Z",
    updated_at: "2026-09-05T08:30:00.000Z",
    ...overrides,
  };
}

const input = (overrides: Partial<receipt.ReceiptInput> = {}): receipt.ReceiptInput => ({
  jobCardId: "11111111-1111-4111-8111-111111111111",
  signerName: "A. Customer",
  signerRole: "CUSTOMER",
  signedAtIso: "2026-09-05T09:00:00.000Z",
  nonce: "a".repeat(32),
  payloadHash: receipt.payloadHash(card(), receipt.CURRENT_PAYLOAD_VERSION),
  ...overrides,
});

test("canonical JSON has its keys in sorted order", () => {
  const json = receipt.canonicalize(card(), 1);
  const keys = Object.keys(JSON.parse(json));

  assert.deepEqual(keys, [...keys].sort(), "key order must not depend on object construction");
});

test("canonicalization covers the intake fields and excludes server bookkeeping", () => {
  const parsed = JSON.parse(receipt.canonicalize(card(), 1));

  for (const field of ["chassis_number", "customer_name", "driver_name", "size", "job_number"]) {
    assert.ok(field in parsed, `${field} is part of what the customer acknowledges`);
  }
  for (const field of [
    "can_edit",
    "updated_at",
    "updated_by",
    "status",
    "locked_at",
    "client_uuid",
  ]) {
    assert.ok(
      !(field in parsed),
      `${field} is server bookkeeping; including it would invalidate receipts on every save`,
    );
  }
});

test("the payload version travels inside the canonical form", () => {
  const parsed = JSON.parse(receipt.canonicalize(card(), 1));
  assert.equal(parsed._payload_version, 1);
});

test("the same card canonicalizes identically twice", () => {
  assert.equal(receipt.canonicalize(card(), 1), receipt.canonicalize(card(), 1));
});

test("key order in the source object does not reach the canonical form", () => {
  // The DTO is built field by field in one place today, but nothing stops a
  // future refactor from spreading it differently. Canonicalization must not
  // care.
  const forwards = card();
  const backwards = Object.fromEntries(
    Object.entries(forwards).reverse(),
  ) as unknown as JobCardDto;

  assert.equal(receipt.canonicalize(forwards, 1), receipt.canonicalize(backwards, 1));
});

test("changing any acknowledged field changes the hash", () => {
  const base = receipt.payloadHash(card(), 1);

  assert.notEqual(base, receipt.payloadHash(card({ chassis_number: "CHS-9002" }), 1));
  assert.notEqual(base, receipt.payloadHash(card({ size: 20 }), 1));
  assert.notEqual(base, receipt.payloadHash(card({ customer_name: null }), 1));
  assert.notEqual(base, receipt.payloadHash(card({ job_number: "VIR-ZZZZ9999" }), 1));
});

test("changing a field outside the payload leaves the hash alone", () => {
  const base = receipt.payloadHash(card(), 1);

  assert.equal(base, receipt.payloadHash(card({ updated_at: "2027-01-01T00:00:00.000Z" }), 1));
  assert.equal(base, receipt.payloadHash(card({ can_edit: false }), 1));
  assert.equal(
    base,
    receipt.payloadHash(card({ status: "SUBMITTED", locked_at: "2027-01-01T00:00:00.000Z" }), 1),
    "submitting a card must not invalidate the acknowledgment that permitted it",
  );
});

test("an absent field and an explicit null hash identically", () => {
  const withNull = card({ container_number: null });
  const withoutKey = card();
  delete (withoutKey as Partial<JobCardDto>).container_number;

  assert.equal(
    receipt.payloadHash(withNull, 1),
    receipt.payloadHash(withoutKey, 1),
    "both mean 'blank' to the customer reading the form",
  );
});

test("an unknown payload version is refused rather than silently defaulted", () => {
  assert.throws(() => receipt.canonicalize(card(), 99), receipt.UnknownPayloadVersionError);
});

test("a nonce is 32 hex characters and does not repeat", () => {
  const a = receipt.newNonce();
  const b = receipt.newNonce();

  assert.match(a, /^[0-9a-f]{32}$/);
  assert.notEqual(a, b);
});

test("signing uses the configured current key version", () => {
  const signed = receipt.signReceipt(input());

  assert.match(signed.hmac, /^[0-9a-f]{64}$/);
  assert.equal(signed.keyVersion, 1);
});

test("recomputing with the same inputs reproduces the HMAC", () => {
  const signed = receipt.signReceipt(input());

  assert.equal(receipt.computeHmac(input(), signed.keyVersion), signed.hmac);
});

test("changing any bound field changes the HMAC", () => {
  const base = receipt.signReceipt(input()).hmac;

  for (const change of [
    { signerName: "B. Customer" },
    { signerRole: "DRIVER" as const },
    { signedAtIso: "2026-09-05T09:00:01.000Z" },
    { nonce: "b".repeat(32) },
    { jobCardId: "44444444-4444-4444-8444-444444444444" },
    { payloadHash: "f".repeat(64) },
  ]) {
    assert.notEqual(receipt.computeHmac(input(change), 1), base, JSON.stringify(change));
  }
});

test("field boundaries are unambiguous: moving text between fields changes the HMAC", () => {
  // Plain concatenation would make ("AB", "C") and ("A", "BC") the same input,
  // and signer_name is free text a customer dictates. The length prefixes are
  // what stop a crafted name from reproducing another receipt's binding.
  const a = receipt.computeHmac(input({ signerName: "AB", signerRole: "DRIVER" }), 1);
  const b = receipt.computeHmac(input({ signerName: "A", signerRole: "BDRIVER" as never }), 1);

  assert.notEqual(a, b);
});

test("a signer name containing the length-prefix separator is still unambiguous", () => {
  const a = receipt.computeHmac(input({ signerName: "7:Bobby" }), 1);
  const b = receipt.computeHmac(input({ signerName: "Bobby" }), 1);

  assert.notEqual(a, b, "the encoding is injective for every possible input, including its own syntax");
});

test("an unknown key version is refused rather than falling back to another key", () => {
  assert.throws(() => receipt.computeHmac(input(), 99), receipt.UnknownKeyVersionError);
});

test("hmacEquals accepts a match and rejects everything else", () => {
  const digest = receipt.signReceipt(input()).hmac;

  assert.equal(receipt.hmacEquals(digest, digest), true);
  assert.equal(receipt.hmacEquals(digest, "f".repeat(64)), false);
  assert.equal(receipt.hmacEquals(digest, "short"), false, "a malformed stored row must not throw");
});
