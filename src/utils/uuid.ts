import { AppError, ERROR_CODES } from "../middleware/errors";

export const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Express 5 types every path param as `string | string[]` to allow for
 * wildcard segments (`*id`); none of our routes use those, so an array here
 * is as malformed as a bad string and gets the same 400. Also usable on
 * request-body fields, which are `unknown` before validation.
 *
 * The value is lowercased on the way out. Postgres compares `uuid` values
 * case-insensitively, so an uppercase-hex path segment names the same row —
 * but a JS `===` between two ids would disagree. Canonicalising here fixes
 * every such comparison at once rather than at whichever call site notices.
 */
export function assertUuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID_PATTERN.test(value)) {
    throw new AppError(400, `${field} must be a UUID`, undefined, ERROR_CODES.VALIDATION_ERROR);
  }
  return value.toLowerCase();
}
