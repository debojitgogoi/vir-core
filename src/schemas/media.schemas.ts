import { z } from "zod";
import { env } from "../config/env";
import { JOB_CARD_MEDIA_KINDS, MEDIA_CONTENT_TYPES } from "../types";

/**
 * The size cap is enforced here against the *declared* size, so an oversized
 * upload is refused before a byte crosses the wire, and again in the route's
 * multer limit against the bytes that actually arrive. The declaration is a
 * claim from the client; neither check alone is sufficient.
 */
export const registerMediaSchema = z
  .object({
    content_type: z.enum(MEDIA_CONTENT_TYPES),
    size_bytes: z
      .number()
      .int("must be a whole number of bytes")
      .positive("must be greater than zero")
      .max(env.mediaMaxBytes, `must not exceed ${env.mediaMaxBytes} bytes`),
    checksum_sha256: z
      .string()
      .regex(/^[0-9a-f]{64}$/, "must be a lowercase hex SHA-256"),
    filename: z
      .string()
      .trim()
      .max(255)
      .transform((v) => (v.length === 0 ? null : v))
      .nullable()
      .optional(),
  })
  .strict();

export type RegisterMediaInput = z.infer<typeof registerMediaSchema>;

export const attachMediaSchema = z
  .object({
    media_id: z.string().uuid(),
    kind: z.enum(JOB_CARD_MEDIA_KINDS),
  })
  .strict();

export type AttachMediaInput = z.infer<typeof attachMediaSchema>;
