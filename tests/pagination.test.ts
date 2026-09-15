import assert from "node:assert/strict";
import { test } from "node:test";
import { AppError } from "../src/middleware/errors";
import { paginate, parsePaging } from "../src/utils/pagination";

test("parsePaging defaults to limit 25 and offset 0 when absent", () => {
  const paging = parsePaging({});
  assert.deepEqual(paging, { limit: 25, offset: 0 });
});

test("parsePaging defaults when given undefined query", () => {
  const paging = parsePaging(undefined);
  assert.deepEqual(paging, { limit: 25, offset: 0 });
});

test("parsePaging rejects limit=0", () => {
  assert.throws(() => parsePaging({ limit: "0" }), AppError);
});

test("parsePaging rejects limit=-1", () => {
  assert.throws(() => parsePaging({ limit: "-1" }), AppError);
});

test("parsePaging rejects a non-numeric limit", () => {
  assert.throws(() => parsePaging({ limit: "abc" }), AppError);
});

test("parsePaging rejects a fractional limit", () => {
  assert.throws(() => parsePaging({ limit: "1.5" }), AppError);
});

test("parsePaging clamps a limit above the max rather than rejecting it", () => {
  const paging = parsePaging({ limit: "1000" });
  assert.equal(paging.limit, 100);
});

test("parsePaging accepts offset=0", () => {
  const paging = parsePaging({ offset: "0" });
  assert.equal(paging.offset, 0);
});

test("parsePaging rejects a negative offset", () => {
  assert.throws(() => parsePaging({ offset: "-1" }), AppError);
});

test("paginate reports has_more=false exactly at the last page boundary", () => {
  const result = paginate(["a", "b"], 10, 2, 8);
  assert.equal(result.pagination.has_more, false);
});

test("paginate reports has_more=true when more rows remain", () => {
  const result = paginate(["a", "b"], 10, 2, 6);
  assert.equal(result.pagination.has_more, true);
});

test("paginate reports has_more=false for an empty page of an empty collection", () => {
  const result = paginate([], 0, 25, 0);
  assert.equal(result.pagination.has_more, false);
  assert.deepEqual(result.data, []);
});
