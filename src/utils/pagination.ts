import { AppError } from "../middleware/errors";
import { Paginated } from "../types";

export const DEFAULT_LIMIT = 25;
export const MAX_LIMIT = 100;

function parseBoundedInt(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  field: string,
): number {
  if (value === undefined || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed)) {
    throw new AppError(400, `${field} must be an integer`);
  }
  if (parsed < min) {
    throw new AppError(400, `${field} must be at least ${min}`);
  }
  return Math.min(parsed, max);
}

/**
 * A limit above MAX_LIMIT is clamped rather than rejected — a client asking
 * for more than we serve gets the largest page we will give it, not an error.
 * A negative or non-integer value is a client bug and is rejected.
 */
export function parsePaging(query: unknown): { limit: number; offset: number } {
  const q = (query ?? {}) as { limit?: unknown; offset?: unknown };
  return {
    limit: parseBoundedInt(q.limit, DEFAULT_LIMIT, 1, MAX_LIMIT, "limit"),
    offset: parseBoundedInt(q.offset, 0, 0, Number.MAX_SAFE_INTEGER, "offset"),
  };
}

export function paginate<T>(
  data: T[],
  total: number,
  limit: number,
  offset: number,
): Paginated<T> {
  return {
    data,
    pagination: { limit, offset, total, has_more: offset + data.length < total },
  };
}
