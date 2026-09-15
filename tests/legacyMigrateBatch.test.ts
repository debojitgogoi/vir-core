import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildInsertChunkSql } from "../scripts/migrate-legacy-data-batched";

describe("buildInsertChunkSql", () => {
  it("builds single-row INSERT with RETURNING id", () => {
    const { sql, nextParam } = buildInsertChunkSql("t", ["a", "b"], 1);
    assert.equal(sql, "INSERT INTO t (a, b) VALUES ($1, $2) RETURNING id");
    assert.equal(nextParam, 3);
  });

  it("builds multi-row INSERT with contiguous params", () => {
    const { sql, nextParam } = buildInsertChunkSql(
      "subview_damages",
      ["legacy_id", "subview_id", "damage_code_id"],
      3,
    );
    assert.equal(
      sql,
      "INSERT INTO subview_damages (legacy_id, subview_id, damage_code_id) VALUES ($1, $2, $3), ($4, $5, $6), ($7, $8, $9) RETURNING id",
    );
    assert.equal(nextParam, 10);
  });

  it("rejects empty chunks", () => {
    assert.throws(() => buildInsertChunkSql("t", ["a"], 0));
  });
});
