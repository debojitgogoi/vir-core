import { z } from "zod";
import { SIGNER_ROLES } from "../types";

/**
 * How far a client may date an acknowledgment.
 *
 * Backdating is allowed at all because a tablet in a yard with no signal
 * captures the moment the customer agreed and syncs later — the same reality
 * `client_uuid` exists for. It is bounded because `signed_at` is the one field
 * that says *when the customer agreed*, and an unbounded client timestamp on
 * it is a forgery surface. Forward skew is small: it covers a device with a
 * wrong clock, not a client dating a receipt into the future.
 */
export const SIGNED_AT_MAX_BACKDATE_MS = 7 * 24 * 60 * 60 * 1000;
export const SIGNED_AT_MAX_SKEW_MS = 60 * 1000;

/**
 * `.strict()`, like every other body in this codebase. Note what is absent by
 * construction and therefore rejected: `payload_hash`, `receipt_hmac`,
 * `nonce`, `key_version` and `payload_version`. Every one of those is the
 * server's to compute, and accepting a client's value for any of them would
 * turn the receipt from evidence into a field the client fills in.
 */
export const recordSignatureSchema = z
  .object({
    signer_name: z
      .string()
      .transform((v) => v.trim())
      .refine((v) => v.length > 0, "must not be blank")
      .refine((v) => v.length <= 120, "must be 120 characters or fewer"),
    signer_role: z.enum(SIGNER_ROLES),
    // A support-triage hint, authenticated by nothing. Whitespace-only is a
    // blank the client left alone, so it becomes null — the same rule the
    // intake form's free text follows.
    device_id: z
      .string()
      .transform((v) => v.trim())
      .transform((v) => (v.length === 0 ? null : v))
      .nullable()
      .default(null),
    signed_at: z
      .string()
      .datetime({ offset: true, message: "must be an ISO 8601 timestamp" })
      .optional(),
  })
  .strict();

export type RecordSignatureInput = z.infer<typeof recordSignatureSchema>;
