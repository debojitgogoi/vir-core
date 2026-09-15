-- 3D GLB model + manifest storage for equipment types.
--
-- Each row is one uploaded GLB together with the JSON manifest extracted from
-- it. Uploads are versioned: every upload for an equipment type gets the next
-- version_number and becomes the active one, while older versions stay around
-- for rollback and because clients may still be running a cached manifest.
--
-- The GLB bytes themselves live on disk (see src/storage/glbStorage.ts), keyed
-- by their SHA-256; only the metadata and the manifest live here.

CREATE TABLE equipment_type_models (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug_id           VARCHAR(8) NOT NULL,
    equipment_type_id UUID NOT NULL REFERENCES equipment_types(id) ON DELETE CASCADE,

    version_number    INTEGER NOT NULL,
    is_active         BOOLEAN NOT NULL DEFAULT true,

    -- The whole manifest, stored verbatim as a single JSON object. JSONB (not
    -- JSON) so it stays queryable later, e.g. manifest -> 'nodes' -> 'SV_Boom'.
    manifest          JSONB NOT NULL,
    manifest_version  TEXT NOT NULL,
    -- Denormalized so listing versions never has to deserialize a manifest.
    node_count        INTEGER NOT NULL,

    storage_key       TEXT NOT NULL,
    original_filename TEXT NOT NULL,
    content_type      TEXT NOT NULL DEFAULT 'model/gltf-binary',
    file_size_bytes   BIGINT NOT NULL,
    checksum_sha256   CHAR(64) NOT NULL,

    uploaded_by       UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT ux_equipment_type_models_slug_id UNIQUE (slug_id),
    CONSTRAINT ux_equipment_type_models_version UNIQUE (equipment_type_id, version_number),
    CONSTRAINT version_number_positive CHECK (version_number > 0)
);

CREATE TRIGGER trg_equipment_type_models_set_updated_at
    BEFORE UPDATE ON equipment_type_models
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- At most one active model per equipment type, enforced by Postgres rather
-- than by the service. A partial unique index is the right tool here: NULLs
-- are not involved, and inactive rows are simply not covered.
CREATE UNIQUE INDEX ux_equipment_type_models_active
    ON equipment_type_models (equipment_type_id)
    WHERE is_active;

CREATE INDEX idx_equipment_type_models_equipment_type
    ON equipment_type_models (equipment_type_id);
