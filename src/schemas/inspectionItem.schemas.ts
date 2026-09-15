import { z } from "zod";

/**
 * Whitespace-only is a blank the inspector left alone, not a value — the same
 * rule `jobCard.schemas.ts` applies, so "" and NULL never both mean "unknown"
 * and no later query has to test for both.
 */
const text = z
  .string()
  .transform((v) => v.trim())
  .transform((v) => (v.length === 0 ? null : v))
  .nullable();

/**
 * One batch write is one transaction, so the cap is what keeps a single
 * request from becoming unbounded work. Two hundred is well above any real
 * walkaround of a chassis.
 */
export const MAX_ITEMS_PER_REQUEST = 200;

const uuid = z.string().uuid();

/**
 * A list of code ids with no repeats. The UNIQUE on the junction table would
 * reject a duplicate anyway; catching it here turns a 500 from a constraint
 * violation into a named violation the client can act on.
 */
const codeIds = z
  .array(uuid)
  .max(100)
  .refine((ids) => new Set(ids).size === ids.length, "must not repeat a code");

/**
 * What a client may say about one custom field answer.
 *
 * `field_name`, `label` and `widget` are absent by construction: the server
 * snapshots them from master data, and `.strict()` is what makes "the client
 * cannot supply them" true rather than merely intended.
 */
const customFieldAnswer = z
  .object({
    subview_field_id: uuid,
    value: z.unknown().optional(),
    option_id: uuid.nullable().optional(),
  })
  .strict();

export const createInspectionItemSchema = z
  .object({
    main_view_id: uuid.nullable().optional(),
    subview_id: uuid.nullable().optional(),
    component_id: uuid.nullable().optional(),
    condition_rating: text.optional(),
    notes: text.optional(),
    custom_fields: z.array(customFieldAnswer).max(200).optional(),
    display_order: z.number().int().min(0).max(100000).optional(),
    client_uuid: uuid.optional(),
    damage_code_ids: codeIds.optional(),
    repair_code_ids: codeIds.optional(),
  })
  .strict();

/**
 * The array half of the spec's "accepts either a single object or an array".
 *
 * The two forms are deliberately NOT a z.union: a union collapses every
 * branch's failures into a single invalid_union issue, which would cost the
 * per-field violation paths a client needs — and in a batch, the index that
 * says which item was wrong. The route picks the schema from the body's shape
 * instead, so a single object reports `notes` and a batch reports
 * `[1].display_order`.
 */
export const createInspectionItemsSchema = z
  .array(createInspectionItemSchema)
  .min(1)
  .max(MAX_ITEMS_PER_REQUEST);

/**
 * A patch replaces what it names and leaves the rest alone.
 *
 * `damage_code_ids` and `repair_code_ids` are wholesale replacements — an
 * empty array clears them — because "add one, remove one" would need its own
 * verbs, and the lists are small enough that resending them costs less than
 * inventing those. `client_uuid` is omitted: it identifies the creating
 * request and re-keying an existing row would break the idempotency it exists
 * to provide.
 */
export const patchInspectionItemSchema = createInspectionItemSchema
  .omit({ client_uuid: true })
  .strict()
  .refine(
    (patch) => Object.keys(patch).length > 0,
    "must name at least one field to change",
  );

/**
 * Attaching a photograph to a line item. No `kind`, unlike job-card media:
 * what the photograph shows is the item it hangs from.
 */
export const attachItemMediaSchema = z.object({ media_id: uuid }).strict();

export type CreateInspectionItemInput = z.infer<typeof createInspectionItemSchema>;
export type PatchInspectionItemInput = z.infer<typeof patchInspectionItemSchema>;
