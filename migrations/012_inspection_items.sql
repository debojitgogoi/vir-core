-- Inspection line items: what the inspector looked at, what they found, and
-- what it needs. The damage and repair codes are referenced through junction
-- tables rather than copied as strings, mirroring subview_damages /
-- subview_repairs, so renaming a code later cannot rewrite history by accident
-- and deleting one that a card references is refused outright.
--
-- Everything locating the item -- main view, subview, component -- is nullable.
-- An inspector may record "there is a dent here" before deciding which subview
-- it belongs to, and a card saved mid-walkaround must not be rejected.

CREATE TABLE inspection_items (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_card_id      UUID NOT NULL REFERENCES job_cards(id) ON DELETE CASCADE,
    main_view_id     UUID REFERENCES main_views(id) ON DELETE RESTRICT,
    subview_id       UUID REFERENCES subviews(id)   ON DELETE RESTRICT,
    component_id     UUID REFERENCES components(id) ON DELETE RESTRICT,
    -- Deliberately unconstrained text. Migration 004 carries no rating
    -- vocabulary; inventing one here would reject values the legacy data
    -- already uses.
    condition_rating TEXT,
    notes            TEXT,
    -- An array of captured answers, never a free-form map. The CHECK is what
    -- makes that structural rather than a convention the service remembers.
    custom_fields    JSONB NOT NULL DEFAULT '[]'::jsonb
                         CHECK (jsonb_typeof(custom_fields) = 'array'),
    display_order    INTEGER NOT NULL DEFAULT 0,
    -- Client-generated idempotency key: a replayed batch upload returns the
    -- existing rows instead of duplicating them. Also the offline-sync seam.
    client_uuid      UUID,
    created_by       UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_inspection_items_set_updated_at
    BEFORE UPDATE ON inspection_items
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- The card's item list, in the order it is displayed.
CREATE INDEX idx_inspection_items_card ON inspection_items (job_card_id, display_order);
CREATE INDEX idx_inspection_items_subview ON inspection_items (subview_id);
-- Scoped to the card, not global: two cards retrying with the same locally
-- generated key must not collide with each other. Partial, so the many rows
-- with no key never collide at all.
CREATE UNIQUE INDEX ux_inspection_items_client_uuid
    ON inspection_items (job_card_id, client_uuid) WHERE client_uuid IS NOT NULL;

CREATE TABLE inspection_item_damages (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    inspection_item_id UUID NOT NULL REFERENCES inspection_items(id) ON DELETE CASCADE,
    -- RESTRICT: a damage code that some card's history references is not
    -- deletable master data.
    damage_code_id     UUID NOT NULL REFERENCES damage_codes(id) ON DELETE RESTRICT,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (inspection_item_id, damage_code_id)
);
CREATE INDEX idx_inspection_item_damages_code
    ON inspection_item_damages (damage_code_id);

CREATE TABLE inspection_item_repairs (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    inspection_item_id UUID NOT NULL REFERENCES inspection_items(id) ON DELETE CASCADE,
    repair_code_id     UUID NOT NULL REFERENCES repair_codes(id) ON DELETE RESTRICT,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (inspection_item_id, repair_code_id)
);
CREATE INDEX idx_inspection_item_repairs_code
    ON inspection_item_repairs (repair_code_id);

-- The link table migration 010 deliberately left out: its foreign key targets
-- inspection_items, which did not exist until now. Everything else about media
-- -- registration, upload, checksum verification, signed download URLs -- is
-- Phase 3's and is reused unchanged.
CREATE TABLE inspection_item_media (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    inspection_item_id UUID NOT NULL REFERENCES inspection_items(id) ON DELETE CASCADE,
    -- RESTRICT, exactly as job_card_media: content-addressed bytes may be
    -- shared, so an asset row is only ever removed by a reaper that has
    -- checked every link first.
    media_asset_id     UUID NOT NULL REFERENCES media_assets(id) ON DELETE RESTRICT,
    display_order      INTEGER NOT NULL DEFAULT 0,
    -- Not in the spec's sketch; job_card_media carries one and "who attached
    -- this photograph" is the same audit question in both places.
    created_by         UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (inspection_item_id, media_asset_id)
);
CREATE INDEX idx_inspection_item_media_item
    ON inspection_item_media (inspection_item_id, display_order);
