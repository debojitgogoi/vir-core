import assert from "node:assert/strict";
import { test } from "node:test";
import { env, resolveSignatureKeys, resolveSignatureKeyVersion } from "../src/config/env";

/**
 * The resolvers take their environment rather than reading process.env, so
 * these cases cannot be fooled by whatever the developer's .env happens to
 * contain — env.ts calls dotenv.config() on import, which would quietly
 * populate the very variables the "nothing configured" case needs absent.
 */
const keysFor = (source: NodeJS.ProcessEnv, isProduction = false) =>
  resolveSignatureKeys(source, "jwt-key", isProduction);

test("with nothing configured outside production, version 1 falls back to JWT_SECRET", () => {
  assert.deepEqual(keysFor({}), { 1: "jwt-key" });
});

test("SIGNATURE_SECRET is version 1 and beats the JWT fallback", () => {
  assert.deepEqual(keysFor({ SIGNATURE_SECRET: "sig-key" }), { 1: "sig-key" });
});

test("SIGNATURE_SECRET_V<n> adds higher versions alongside version 1", () => {
  const keys = keysFor({ SIGNATURE_SECRET: "sig-key-1", SIGNATURE_SECRET_V2: "sig-key-2" });

  assert.deepEqual(keys, { 1: "sig-key-1", 2: "sig-key-2" });
});

test("SIGNATURE_SECRET_V1 is ignored: version 1 has exactly one spelling", () => {
  // Two spellings for one version would be two sources of truth, and whichever
  // lost would fail silently — every receipt written under it unverifiable.
  assert.deepEqual(keysFor({ SIGNATURE_SECRET: "sig-key-1", SIGNATURE_SECRET_V1: "other" }), {
    1: "sig-key-1",
  });
});

test("an empty value does not register a key", () => {
  assert.deepEqual(keysFor({ SIGNATURE_SECRET: "sig-key-1", SIGNATURE_SECRET_V2: "" }), {
    1: "sig-key-1",
  });
});

test("production refuses to boot without SIGNATURE_SECRET", () => {
  // Sharing JWT_SECRET would make one stolen value both forge access tokens
  // and forge the receipts a customer's acknowledgment rests on.
  assert.throws(() => keysFor({}, true), /SIGNATURE_SECRET/);
});

test("production accepts an explicitly configured key", () => {
  assert.deepEqual(keysFor({ SIGNATURE_SECRET: "sig-key" }, true), { 1: "sig-key" });
});

test("signing defaults to the highest configured version", () => {
  const keys = { 1: "a", 2: "b" };

  assert.equal(
    resolveSignatureKeyVersion(keys, {}),
    2,
    "receipts written from now on use the newest key; older ones still verify",
  );
});

test("SIGNATURE_KEY_VERSION pins signing without discarding the newer key", () => {
  const keys = { 1: "a", 2: "b" };

  assert.equal(resolveSignatureKeyVersion(keys, { SIGNATURE_KEY_VERSION: "1" }), 1);
});

test("pinning to a version with no key configured is refused at boot", () => {
  assert.throws(
    () => resolveSignatureKeyVersion({ 1: "a" }, { SIGNATURE_KEY_VERSION: "3" }),
    /SIGNATURE_KEY_VERSION/,
    "signing with a key that does not exist would produce unverifiable receipts",
  );
});

test("a non-numeric pin is refused", () => {
  assert.throws(() => resolveSignatureKeyVersion({ 1: "a" }, { SIGNATURE_KEY_VERSION: "latest" }));
});

test("the wired-up env exposes a usable key for the version it signs with", () => {
  assert.ok(env.signatureKeys[env.signatureKeyVersion], "the app can always sign a receipt");
});
