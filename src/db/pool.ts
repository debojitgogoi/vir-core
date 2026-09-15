import { Pool, types } from "pg";
import { env } from "../config/env";

// A DATE is a calendar date with no time and no zone. node-postgres parses it
// into a JS Date by default, which pins it to local midnight and then reports
// it as an instant — on a UTC+5:30 machine '2026-03-01' comes back as
// 2026-02-28T18:30:00Z, a day earlier than the value stored. Returning the raw
// 'YYYY-MM-DD' string keeps the three DATE columns on job_cards
// (license_expiry_date, on_hire_date, fhwa_sticker_date) meaning what they say.
// TIMESTAMPTZ columns are genuine instants and keep their default parsing.
types.setTypeParser(types.builtins.DATE, (value) => value);

export const pool = new Pool({
  connectionString: env.databaseUrl,
});

pool.on("error", (err) => {
  console.error("Unexpected error on idle Postgres client", err);
});
