import assert from "node:assert/strict";
import { test } from "node:test";
import { AppError } from "../src/middleware/errors";
import { assertUuid } from "../src/utils/uuid";

test("assertUuid canonicalises to lowercase", () => {
  const upper = "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE";
  assert.equal(
    assertUuid(upper, "id"),
    upper.toLowerCase(),
    "Postgres compares uuid case-insensitively, so JS comparisons need one form",
  );
});

test("assertUuid passes an already-lowercase value through unchanged", () => {
  const value = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
  assert.equal(assertUuid(value, "id"), value);
});

test("assertUuid rejects a non-string and a malformed string with a coded 400", () => {
  for (const bad of [undefined, null, 42, ["aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"], "not-a-uuid"]) {
    assert.throws(
      () => assertUuid(bad, "id"),
      (err: AppError) =>
        err.status === 400 && err.code === "VALIDATION_ERROR" && /^id must be a UUID$/.test(err.message),
      `${JSON.stringify(bad)} should be rejected`,
    );
  }
});
