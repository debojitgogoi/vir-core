-- Optional ink photograph for a receipt. The HMAC columns stay append-only;
-- this is the only write allowed after INSERT, and only while media_id is null.
--
-- The image is a normal media_assets row (register + PUT bytes). It is not a
-- job_card_media kind, so it does not appear as an intake or line photograph.

ALTER TABLE job_card_signatures
    ADD COLUMN media_id UUID REFERENCES media_assets(id) ON DELETE RESTRICT;

CREATE UNIQUE INDEX idx_job_card_signatures_media_id
    ON job_card_signatures (media_id)
    WHERE media_id IS NOT NULL;
