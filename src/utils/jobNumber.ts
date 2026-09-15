import { generateSlugId } from "./slug-id";

/**
 * `VIR-` plus eight characters drawn from [0-9A-Z]. Also enforced in SQL by
 * migration 009, so a bad value cannot enter through a script, a psql session,
 * or a future code path that forgets this generator.
 */
export const JOB_NUMBER_PATTERN = /^VIR-[0-9A-Z]{8}$/;

/**
 * The suffix comes from `generateSlugId`, which produces exactly the 8-character
 * [0-9A-Z] string this format needs — reused rather than re-implemented so the
 * ESM-import workaround that module documents lives in one place. Should that
 * generator's length or charset ever change, this breaks loudly rather than
 * silently: the SQL CHECK rejects the insert and jobNumber.test.ts fails.
 */
export async function generateJobNumber(): Promise<string> {
  return `VIR-${await generateSlugId()}`;
}
