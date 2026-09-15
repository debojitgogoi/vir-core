import { NextFunction, Request, Response } from "express";

/**
 * Stable machine-readable tokens. Clients branch on these; the `message`
 * beside them is prose and may be reworded at any time without a version bump.
 */
export const ERROR_CODES = {
  VALIDATION_ERROR: "VALIDATION_ERROR",
  DEPOT_FORBIDDEN: "DEPOT_FORBIDDEN",
  DEPOT_DISABLED: "DEPOT_DISABLED",
  JOB_CARD_LOCKED: "JOB_CARD_LOCKED",
  STALE_WRITE: "STALE_WRITE",
  CHECKSUM_MISMATCH: "CHECKSUM_MISMATCH",
  MEDIA_NOT_READY: "MEDIA_NOT_READY",
  SUBMISSION_INCOMPLETE: "SUBMISSION_INCOMPLETE",
} as const;

export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

export class AppError extends Error {
  status: number;
  /**
   * Optional machine-readable specifics, surfaced as `violations` in the
   * response body. Used by manifest validation, where a caller needs the full
   * list to fix the file rather than just a summary, and by zod validation,
   * where it carries one entry per failing field.
   */
  details?: string[];
  /**
   * Stable token clients branch on. Added in Phase 2: before it existed, codes
   * like DEPOT_FORBIDDEN were smuggled through `message`, which made every
   * reword a breaking change.
   */
  code?: string;

  constructor(status: number, message: string, details?: string[], code?: string) {
    super(message);
    this.status = status;
    this.details = details;
    this.code = code;
  }
}

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction,
): void {
  if (err instanceof AppError) {
    // Both optional keys are omitted when absent, so a client reading only
    // `error` sees a body byte-identical to the one Phase 1 returned.
    const body: { error: string; code?: string; violations?: string[] } = {
      error: err.message,
    };
    if (err.code) body.code = err.code;
    if (err.details) body.violations = err.details;
    res.status(err.status).json(body);
    return;
  }
  console.error("Unexpected error:", err);
  res.status(500).json({ error: "Internal server error" });
}
