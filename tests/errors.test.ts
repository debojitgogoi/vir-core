import assert from "node:assert/strict";
import { test } from "node:test";
import { z } from "zod";
import { AppError } from "../src/middleware/errors";
import { fromZod } from "../src/utils/zodError";

test("AppError carries an optional machine code", () => {
  const withCode = new AppError(
    409,
    "This job card is read-only",
    undefined,
    "JOB_CARD_LOCKED",
  );
  assert.equal(withCode.status, 409);
  assert.equal(withCode.code, "JOB_CARD_LOCKED");

  const withoutCode = new AppError(404, "Depot not found");
  assert.equal(withoutCode.code, undefined);
});

test("fromZod flattens every issue into a 400 VALIDATION_ERROR", () => {
  const schema = z.object({
    direction: z.enum(["INBOUND", "OUTBOUND"]),
    size: z.number().int(),
  });
  const parsed = schema.safeParse({ direction: "SIDEWAYS", size: "big" });
  assert.equal(parsed.success, false);

  const err = fromZod(parsed.error!);
  assert.equal(err.status, 400);
  assert.equal(err.code, "VALIDATION_ERROR");
  assert.equal(err.details?.length, 2, "one violation per failing field");
  assert.ok(
    err.details?.some((d) => d.startsWith("direction:")),
    "violations name the field that failed",
  );
  assert.ok(err.details?.some((d) => d.startsWith("size:")));
});

test("fromZod names a nested field by its full path", () => {
  const schema = z.object({ patch: z.object({ size: z.number() }) });
  const parsed = schema.safeParse({ patch: { size: "x" } });
  const err = fromZod(parsed.error!);
  assert.ok(err.details?.[0].startsWith("patch.size:"));
});

test("fromZod on a root-level issue uses '(body)' rather than an empty label", () => {
  const parsed = z.object({}).strict().safeParse("not-an-object");
  const err = fromZod(parsed.error!);
  assert.ok(err.details?.[0].startsWith("(body):"));
});
