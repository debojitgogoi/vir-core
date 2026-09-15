import { z } from "zod";

const trimmed = z.string().transform((v) => v.trim());

export const createDepotSchema = z
  .object({
    code: trimmed
      .refine((v) => v.length > 0, "is required")
      .transform((v) => v.toUpperCase()),
    name: trimmed.refine((v) => v.length > 0, "is required"),
    timezone: trimmed
      .refine((v) => v.length > 0, "must not be blank")
      .default("UTC"),
    address: trimmed
      .transform((v) => (v.length === 0 ? null : v))
      .nullable()
      .optional(),
  })
  .strict();

export type CreateDepotInput = z.infer<typeof createDepotSchema>;

/**
 * The repository still writes this patch with COALESCE, so `address` cannot
 * actually be cleared yet — the schema accepts null because the shape is right,
 * but `updateDepot` treats it as "leave alone". Job cards got the merge-patch
 * builder in this phase; depots are recorded in the Phase 3 carry-over.
 */
export const patchDepotSchema = z
  .object({
    name: trimmed.refine((v) => v.length > 0, "must not be blank").optional(),
    timezone: trimmed.refine((v) => v.length > 0, "must not be blank").optional(),
    address: trimmed
      .transform((v) => (v.length === 0 ? null : v))
      .nullable()
      .optional(),
    is_disabled: z.boolean().optional(),
  })
  .strict();

export type PatchDepotInput = z.infer<typeof patchDepotSchema>;
