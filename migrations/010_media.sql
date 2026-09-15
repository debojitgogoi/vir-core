-- Media assets: the bytes of a photograph, plus everything needed to serve and
-- verify them. Rows are created PENDING at registration and promoted to READY
-- once the bytes arrive and their checksum matches what the client declared,
-- so a READY row can never point at a file that was never written.
--
-- inspection_item_media is deliberately absent. Its foreign key targets
-- inspection_items, which Phase 5 creates; the spec's phase list claimed
-- Phase 3 delivered both owner types, which is not buildable in that order.
-- Phase 5 adds that link table on top of everything here.

CREATE TABLE media_assets (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- Content-addressed path under the storage root, empty until the bytes
    -- arrive. Two identical uploads share one key and one file on disk.
    storage_key       TEXT NOT NULL DEFAULT '',
    -- On a PENDING row this is the client's declaration; on a READY row it has
    -- been verified against the bytes actually written.
    checksum_sha256   CHAR(64) NOT NULL,
    content_type      TEXT NOT NULL CHECK (content_type IN (
                          'image/jpeg', 'image/png', 'image/webp')),
    size_bytes        BIGINT NOT NULL CHECK (size_bytes > 0),
    original_filename TEXT,
    status            TEXT NOT NULL DEFAULT 'PENDING'
                          CHECK (status IN ('PENDING', 'READY')),
    -- Scoping for the upload: an asset registered at one depot cannot be
    -- attached to another depot's card. SET NULL rather than RESTRICT so
    -- removing a depot never strands its media rows.
    depot_id          UUID REFERENCES depots(id) ON DELETE SET NULL,
    uploaded_by       UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

    -- A READY row without a storage key would be a row promising bytes that
    -- nothing can find.
    CONSTRAINT media_asset_ready_has_storage_key
        CHECK (status = 'PENDING' OR length(storage_key) > 0)
);
CREATE TRIGGER trg_media_assets_set_updated_at
    BEFORE UPDATE ON media_assets
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Finding an existing upload of identical bytes. Not unique: two depots may
-- legitimately hold rows for the same photograph.
CREATE INDEX idx_media_assets_checksum ON media_assets (checksum_sha256);
-- The reaper's query: registrations whose upload never arrived.
CREATE INDEX idx_media_assets_pending ON media_assets (created_at) WHERE status = 'PENDING';

CREATE TABLE job_card_media (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_card_id    UUID NOT NULL REFERENCES job_cards(id) ON DELETE CASCADE,
    -- RESTRICT, not CASCADE: content-addressed bytes may be shared between
    -- cards, so an asset row is only ever removed by a reaper that has checked
    -- every link first.
    media_asset_id UUID NOT NULL REFERENCES media_assets(id) ON DELETE RESTRICT,
    kind           TEXT NOT NULL CHECK (kind IN ('DRIVER_LICENSE', 'CHASSIS')),
    created_by     UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (job_card_id, media_asset_id)
);
CREATE INDEX idx_job_card_media_card ON job_card_media (job_card_id, kind);
