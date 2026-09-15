import { z } from "zod";
import {
  EQUIPMENT_FORMS,
  GENSET_STATUSES,
  JOB_CARD_DIRECTIONS,
  JOB_CARD_STATUSES,
  REGISTRATION_STATUSES,
} from "../types";
import { DEFAULT_LIMIT, MAX_LIMIT } from "../utils/pagination";
import { isRealCalendarDate } from "../utils/date";

/**
 * A free-text intake field. Whitespace-only input is a blank the gatekeeper
 * left alone, not a value, so it becomes null rather than an empty string —
 * otherwise "" and NULL would both mean "unknown" and every later query would
 * have to test for both.
 */
const text = z
  .string()
  .transform((v) => v.trim())
  .transform((v) => (v.length === 0 ? null : v))
  .nullable();

/** A DATE column. Accepts YYYY-MM-DD and nothing else. */
const dateOnly = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "must be a date in YYYY-MM-DD form")
  .refine(isRealCalendarDate, "must be a real calendar date")
  .nullable();

/** A TIMESTAMPTZ column. Kept as an ISO string; pg parses it on the way in. */
const timestamp = z
  .string()
  .datetime({ offset: true, message: "must be an ISO 8601 timestamp" })
  .nullable();

const size = z
  .union([z.number(), z.string()])
  .transform((v) => (typeof v === "string" ? Number(v) : v))
  .refine((v): v is 20 | 40 | 45 | 53 => [20, 40, 45, 53].includes(v), {
    message: "must be one of 20, 40, 45, 53",
  })
  .nullable();

const manufactureYear = z.coerce
  .number()
  .int()
  .min(1900, "must be 1900 or later")
  .max(2200, "must be 2200 or earlier")
  .nullable();

const uuid = z.string().uuid();

/**
 * Every column a client may write, in one place. Both the create and the patch
 * schema derive from this, so the two cannot drift apart, and the repository's
 * SET builder iterates its keys.
 */
const writableShape = {
  trucker_name: text,
  location: text,
  inspected_at: timestamp,
  equipment_prefix_id: uuid.nullable(),
  prefix_text: z
    .string()
    .transform((v) => v.trim().toUpperCase())
    .refine((v) => v.length <= 8, "must be 8 characters or fewer")
    .transform((v) => (v.length === 0 ? null : v))
    .nullable(),
  container_number: text,
  chassis_number: text,
  genset_status: z.enum(GENSET_STATUSES).nullable(),
  size,
  equipment_form: z.enum(EQUIPMENT_FORMS).nullable(),
  serial_number: text,
  license_plate: text,
  license_state: text,
  license_expiry_date: dateOnly,
  registration_status: z.enum(REGISTRATION_STATUSES).nullable(),
  pool_point: text,
  customer_name: text,
  redelivery_release_no: text,
  customer_account_no: text,
  on_hire_date: dateOnly,
  scac_code: text,
  fhwa_sticker_date: dateOnly,
  driver_name: text,
  manufacture_year: manufactureYear,
};

/**
 * The two NOT NULL intake columns. Required on create and, on patch, changeable
 * but never clearable.
 */
const requiredShape = {
  direction: z.enum(JOB_CARD_DIRECTIONS),
  equipment_type_id: uuid,
};

/**
 * Going through `.partial().shape` rather than mapping over Object.entries
 * keeps zod's inference intact — a hand-built Record<string, ZodType> would
 * erase every field's type and make the parsed body an `any`.
 */
const optionalWritable = z.object(writableShape).partial().shape;
const optionalRequired = z.object(requiredShape).partial().shape;

/** The column allowlist the repository's UPDATE builder iterates. */
export const PATCHABLE_COLUMNS: readonly string[] = Object.freeze([
  ...Object.keys(requiredShape),
  ...Object.keys(writableShape),
]);

const hasIdentifier = (v: {
  container_number?: string | null;
  chassis_number?: string | null;
}): boolean => Boolean(v.container_number) || Boolean(v.chassis_number);

export const createJobCardSchema = z
  .object({
    // Client-generated idempotency key: a retried create returns the existing
    // card rather than a duplicate. Also the seam a future offline sync uses.
    client_uuid: uuid.optional(),
    ...requiredShape,
    ...optionalWritable,
  })
  .strict()
  .refine(hasIdentifier, {
    message: "at least one of container_number or chassis_number is required",
    path: ["container_number"],
  });

export type CreateJobCardInput = z.infer<typeof createJobCardSchema>;

/**
 * JSON Merge Patch semantics: an absent key leaves the column alone, an
 * explicit null clears it. `.strict()` means a misspelled field is a 400 rather
 * than a silently ignored edit — the failure mode that matters most on a
 * thirty-five-field form.
 *
 * `status`, `job_number`, `depot_id`, `client_uuid` and `locked_at` are absent
 * by construction: they are server-owned, and `.strict()` rejects them.
 *
 * The container/chassis pair is deliberately NOT checked here. A patch carries
 * only the keys it changes, so the rule can only be judged against the merged
 * row — the service does that, with the SQL CHECK as the backstop.
 */
export const patchJobCardSchema = z
  .object({
    ...optionalRequired,
    ...optionalWritable,
  })
  .strict();

export type PatchJobCardInput = z.infer<typeof patchJobCardSchema>;

/**
 * A limit above MAX_LIMIT is clamped, not rejected, matching `parsePaging`: a
 * client asking for more than we serve gets the largest page we will give it.
 * A negative or non-integer value is a client bug and is rejected.
 */
const limit = z.coerce
  .number()
  .int("limit must be an integer")
  .min(1, "limit must be at least 1")
  .transform((v) => Math.min(v, MAX_LIMIT))
  .default(DEFAULT_LIMIT);

const offset = z.coerce
  .number()
  .int("offset must be an integer")
  .min(0, "offset must be at least 0")
  .default(0);

/**
 * Unknown query parameters are ignored rather than rejected — browsers, proxies
 * and analytics tools append their own, and a 400 on `?utm_source=` would be a
 * support ticket, not a caught bug. Request bodies take the opposite line: see
 * the `.strict()` on the two schemas above.
 */
export const listJobCardsQuerySchema = z
  .object({
    status: z.enum(JOB_CARD_STATUSES).optional(),
    direction: z.enum(JOB_CARD_DIRECTIONS).optional(),
    q: z
      .string()
      .transform((v) => v.trim())
      .refine((v) => v.length > 0, "must not be blank")
      .optional(),
    depot_id: z.string().uuid().optional(),
    // `from`/`to` filter created_at -- when the record was typed.
    from: z.string().datetime({ offset: true }).optional(),
    to: z.string().datetime({ offset: true }).optional(),
    // `inspected_from`/`inspected_to` filter inspected_at -- when the chassis
    // was actually looked at, which is what "show me last Tuesday" means. A
    // separate pair rather than repointing the one above: inspected_at is
    // nullable, so repointing would silently drop every card lacking one, and
    // two pairs make which question you are asking explicit.
    inspected_from: z.string().datetime({ offset: true }).optional(),
    inspected_to: z.string().datetime({ offset: true }).optional(),
    limit,
    offset,
  })
  .refine((v) => !(v.from && v.to) || Date.parse(v.from) <= Date.parse(v.to), {
    message: "from must not be later than to",
    path: ["from"],
  })
  .refine(
    (v) =>
      !(v.inspected_from && v.inspected_to) ||
      Date.parse(v.inspected_from) <= Date.parse(v.inspected_to),
    { message: "inspected_from must not be later than inspected_to", path: ["inspected_from"] },
  );

export type ListJobCardsQuery = z.infer<typeof listJobCardsQuerySchema>;
