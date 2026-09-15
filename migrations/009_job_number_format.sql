-- The VIR-XXXXXXXX shape was only a comment on migration 008. Make it a
-- constraint, so a bad value cannot enter through a script, a psql session,
-- or a future code path that forgets the generator.
ALTER TABLE job_cards
    ADD CONSTRAINT job_number_format
    CHECK (job_number ~ '^VIR-[0-9A-Z]{8}$');

-- `job_number TEXT NOT NULL UNIQUE` already creates a unique btree on this
-- column; the second index served no query and only amplified writes.
DROP INDEX IF EXISTS idx_job_cards_job_number;
