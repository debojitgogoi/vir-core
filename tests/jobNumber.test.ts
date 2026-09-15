import assert from "node:assert/strict";
import { test } from "node:test";
import { JOB_NUMBER_PATTERN, generateJobNumber } from "../src/utils/jobNumber";

test("a job number is VIR- followed by eight uppercase alphanumerics", async () => {
  const value = await generateJobNumber();
  assert.match(value, JOB_NUMBER_PATTERN);
  assert.equal(value.length, 12, "VIR- (4) + 8 characters");
  assert.equal(value.slice(0, 4), "VIR-");
});

test("job numbers do not repeat across a large sample", async () => {
  const seen = new Set<string>();
  for (let i = 0; i < 500; i += 1) seen.add(await generateJobNumber());
  assert.equal(seen.size, 500, "500 draws produced 500 distinct values");
});
