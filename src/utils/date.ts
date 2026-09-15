/**
 * Calendar-date validation shared by every caller that touches a `DATE`
 * column's string form.
 *
 * `Date.parse` (and `new Date(...)` with numeric parts) is not a validity
 * check: it rolls an impossible date over into the next one instead of
 * rejecting it — `"2026-02-31"` silently becomes 3 March. Building the date
 * from its parts and reading them back is the only way to catch that, so this
 * is the one place that does it; `jobCard.schemas.ts` and `customFields.ts`
 * used to each carry their own copy.
 *
 * This is deliberately independent of the `pg` type-parser fix in
 * `src/db/pool.ts`, which stops `DATE` columns from being parsed into a JS
 * `Date` at all (avoiding the local-midnight/UTC day-shift that produces).
 * That fix keeps a stored date from drifting on the way back out; this one
 * keeps an impossible date from being stored in the first place. A `DATE`
 * column needs both.
 */
export function isRealCalendarDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year, month, day] = value.split("-").map(Number);
  const parsed = new Date(Date.UTC(year, month - 1, day));
  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}
