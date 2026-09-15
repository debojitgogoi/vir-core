import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createJobCardSchema,
  listJobCardsQuerySchema,
  patchJobCardSchema,
} from "../src/schemas/jobCard.schemas";

const TYPE_ID = "11111111-2222-3333-4444-555555555555";

function validCreate(overrides: Record<string, unknown> = {}) {
  return {
    direction: "INBOUND",
    equipment_type_id: TYPE_ID,
    chassis_number: "CHS-1",
    ...overrides,
  };
}

test("create accepts a minimal valid intake body", () => {
  const parsed = createJobCardSchema.safeParse(validCreate());
  assert.equal(parsed.success, true);
  assert.equal(parsed.data!.direction, "INBOUND");
});

test("create requires at least one of container_number or chassis_number", () => {
  const parsed = createJobCardSchema.safeParse({
    direction: "INBOUND",
    equipment_type_id: TYPE_ID,
  });
  assert.equal(parsed.success, false);
  assert.ok(
    parsed.error!.issues.some((i) => /container_number or chassis_number/.test(i.message)),
    "the failure names the pair, not one arbitrary field",
  );
});

test("create rejects an unknown genset status", () => {
  const parsed = createJobCardSchema.safeParse(validCreate({ genset_status: "RUNNING" }));
  assert.equal(parsed.success, false);
});

test("create accepts all four genset statuses including 'N/A'", () => {
  for (const value of ["N/A", "ATTACHED", "POWERED_RUNNING", "UNDER_MOUNT"]) {
    const parsed = createJobCardSchema.safeParse(validCreate({ genset_status: value }));
    assert.equal(parsed.success, true, `${value} should be accepted`);
  }
});

test("create coerces a numeric-string size and rejects an off-list one", () => {
  const ok = createJobCardSchema.safeParse(validCreate({ size: "40" }));
  assert.equal(ok.success, true);
  assert.equal(ok.data!.size, 40, "size arrives as a number, not a string");

  assert.equal(createJobCardSchema.safeParse(validCreate({ size: 30 })).success, false);
});

test("create rejects an unknown key rather than silently dropping it", () => {
  const parsed = createJobCardSchema.safeParse(validCreate({ chasis_number: "typo" }));
  assert.equal(parsed.success, false, "a misspelled field must not be swallowed");
});

test("create trims strings and turns a blank one into null", () => {
  const parsed = createJobCardSchema.safeParse(
    validCreate({ trucker_name: "  Ana  ", pool_point: "   " }),
  );
  assert.equal(parsed.success, true);
  assert.equal(parsed.data!.trucker_name, "Ana");
  assert.equal(parsed.data!.pool_point, null);
});

test("create validates date-only and timestamp fields distinctly", () => {
  const good = createJobCardSchema.safeParse(
    validCreate({ on_hire_date: "2026-03-01", inspected_at: "2026-03-01T10:30:00Z" }),
  );
  assert.equal(good.success, true);

  assert.equal(
    createJobCardSchema.safeParse(validCreate({ on_hire_date: "2026-03-01T10:00:00Z" })).success,
    false,
    "a DATE column does not accept a timestamp",
  );
  assert.equal(
    createJobCardSchema.safeParse(validCreate({ inspected_at: "2026-03-01" })).success,
    false,
    "a TIMESTAMPTZ column needs a full ISO instant",
  );
  assert.equal(
    createJobCardSchema.safeParse(validCreate({ on_hire_date: "2026-02-31" })).success,
    false,
    "a well-shaped but impossible calendar date is rejected",
  );
});

test("create bounds manufacture_year to the column's CHECK range", () => {
  assert.equal(createJobCardSchema.safeParse(validCreate({ manufacture_year: 2019 })).success, true);
  assert.equal(createJobCardSchema.safeParse(validCreate({ manufacture_year: 1899 })).success, false);
  assert.equal(createJobCardSchema.safeParse(validCreate({ manufacture_year: 2201 })).success, false);
});

test("patch distinguishes an absent key from an explicit null", () => {
  const parsed = patchJobCardSchema.safeParse({ container_number: null });
  assert.equal(parsed.success, true);
  assert.ok("container_number" in parsed.data!, "the key survives parsing");
  assert.equal(parsed.data!.container_number, null);

  const empty = patchJobCardSchema.safeParse({});
  assert.equal(empty.success, true);
  assert.equal(Object.keys(empty.data!).length, 0, "an absent key stays absent");
});

test("patch refuses to set direction or equipment_type_id to null — both are NOT NULL", () => {
  assert.equal(patchJobCardSchema.safeParse({ direction: null }).success, false);
  assert.equal(patchJobCardSchema.safeParse({ equipment_type_id: null }).success, false);
});

test("patch rejects a client-supplied status, job_number, or depot_id", () => {
  for (const key of ["status", "job_number", "depot_id", "locked_at", "id", "client_uuid"]) {
    const parsed = patchJobCardSchema.safeParse({ [key]: "anything" });
    assert.equal(parsed.success, false, `${key} must not be patchable`);
  }
});

test("list query defaults, coerces, and validates its filters", () => {
  const parsed = listJobCardsQuerySchema.safeParse({});
  assert.equal(parsed.success, true);
  assert.equal(parsed.data!.limit, 25);
  assert.equal(parsed.data!.offset, 0);

  const filtered = listJobCardsQuerySchema.safeParse({
    status: "DRAFT",
    direction: "OUTBOUND",
    q: "  MSCU  ",
    limit: "10",
  });
  assert.equal(filtered.success, true);
  assert.equal(filtered.data!.limit, 10);
  assert.equal(filtered.data!.q, "MSCU", "the search term is trimmed");

  assert.equal(listJobCardsQuerySchema.safeParse({ status: "NOPE" }).success, false);
  assert.equal(listJobCardsQuerySchema.safeParse({ limit: "-1" }).success, false);
  assert.equal(listJobCardsQuerySchema.safeParse({ limit: "1.5" }).success, false);
});

test("list query clamps an over-maximum limit rather than rejecting it", () => {
  const parsed = listJobCardsQuerySchema.safeParse({ limit: "5000" });
  assert.equal(parsed.success, true);
  assert.equal(parsed.data!.limit, 100, "matches parsePaging's clamping behaviour");
});

test("list query ignores an unknown parameter rather than 400ing on it", () => {
  const parsed = listJobCardsQuerySchema.safeParse({ utm_source: "email" });
  assert.equal(parsed.success, true, "a stray tracking param is not a client bug");
});

test("list query rejects a from later than its to", () => {
  const parsed = listJobCardsQuerySchema.safeParse({
    from: "2026-03-01T00:00:00Z",
    to: "2026-01-01T00:00:00Z",
  });
  assert.equal(parsed.success, false);

  const ordered = listJobCardsQuerySchema.safeParse({
    from: "2026-01-01T00:00:00Z",
    to: "2026-03-01T00:00:00Z",
  });
  assert.equal(ordered.success, true);
});
