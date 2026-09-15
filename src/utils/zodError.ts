import { ZodError } from "zod";
import { AppError, ERROR_CODES } from "../middleware/errors";

/**
 * One violation string per failing field, shaped `path: message`. A root-level
 * issue (an empty path — the body was not an object at all) is labelled
 * `(body)` rather than emitted with a leading colon.
 */
export function fromZod(err: ZodError, message = "Request validation failed"): AppError {
  const details = err.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "(body)";
    return `${path}: ${issue.message}`;
  });
  return new AppError(400, message, details, ERROR_CODES.VALIDATION_ERROR);
}

interface Parseable<T> {
  safeParse(v: unknown): { success: true; data: T } | { success: false; error: ZodError };
}

/**
 * Parses or throws. Every route edge uses this rather than calling `safeParse`
 * and hand-rolling the failure, so exactly one error shape reaches clients.
 */
export function parseOrThrow<T>(schema: Parseable<T>, input: unknown, message?: string): T {
  const result = schema.safeParse(input);
  if (!result.success) throw fromZod(result.error, message);
  return result.data;
}
