-- Equipment Inspection schema — see
-- legacy_data/migrated_db_structure/schema-design.md for the full design
-- rationale. This migration creates every table from that design, in
-- FK-dependency order, with no data.

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
    NEW.updated_at = now();
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- 1. Equipment hierarchy -----------------------------------------------

CREATE TABLE equipment_categories (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    legacy_id    BIGINT UNIQUE,
    name         TEXT NOT NULL UNIQUE,
    is_disabled  BOOLEAN NOT NULL DEFAULT false,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_equipment_categories_set_updated_at
    BEFORE UPDATE ON equipment_categories
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE equipment_types (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    legacy_id             BIGINT UNIQUE,
    equipment_category_id UUID NOT NULL REFERENCES equipment_categories(id) ON DELETE RESTRICT,
    name                  TEXT NOT NULL,
    is_disabled           BOOLEAN NOT NULL DEFAULT false,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (equipment_category_id, name)
);
CREATE TRIGGER trg_equipment_types_set_updated_at
    BEFORE UPDATE ON equipment_types
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX idx_equipment_types_category ON equipment_types(equipment_category_id);

CREATE TABLE equipment_prefixes (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    legacy_id             BIGINT UNIQUE,
    equipment_category_id UUID NOT NULL REFERENCES equipment_categories(id) ON DELETE CASCADE,
    prefix_name           VARCHAR(8) NOT NULL,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT prefix_name_length CHECK (char_length(prefix_name) BETWEEN 4 AND 8),
    UNIQUE (equipment_category_id, prefix_name)
);
CREATE TRIGGER trg_equipment_prefixes_set_updated_at
    BEFORE UPDATE ON equipment_prefixes
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- 2. Components (created before main_views/subviews so subviews.component_id
-- can reference it) -----------------------------------------------------

CREATE TABLE components (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    legacy_id             BIGINT UNIQUE,
    component_code        TEXT NOT NULL,
    component_description TEXT,
    is_disabled           BOOLEAN NOT NULL DEFAULT false,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_components_set_updated_at
    BEFORE UPDATE ON components
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX idx_components_component_code ON components(component_code);

-- main_views / subviews ---------------------------------------------------

CREATE TABLE main_views (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    legacy_id         BIGINT UNIQUE,
    equipment_type_id UUID NOT NULL REFERENCES equipment_types(id) ON DELETE CASCADE,
    name              TEXT NOT NULL,
    bubble_name       TEXT,
    label_name        TEXT,
    sequence_number   INTEGER,
    is_disabled       BOOLEAN NOT NULL DEFAULT false,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_main_views_set_updated_at
    BEFORE UPDATE ON main_views
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE subviews (
    id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    legacy_id         BIGINT UNIQUE,
    main_view_id      UUID NOT NULL REFERENCES main_views(id) ON DELETE CASCADE,
    parent_subview_id UUID REFERENCES subviews(id) ON DELETE CASCADE,
    component_id      UUID REFERENCES components(id) ON DELETE RESTRICT,
    name              TEXT NOT NULL,
    header            TEXT,
    is_disabled       BOOLEAN NOT NULL DEFAULT false,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT parent_not_self CHECK (parent_subview_id IS DISTINCT FROM id)
);
CREATE TRIGGER trg_subviews_set_updated_at
    BEFORE UPDATE ON subviews
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX idx_subviews_main_view ON subviews(main_view_id);
CREATE INDEX idx_subviews_parent ON subviews(parent_subview_id);
CREATE INDEX idx_subviews_component ON subviews(component_id);

-- 3. Damage & repair master data -----------------------------------------

CREATE TABLE damage_codes (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    legacy_id          BIGINT UNIQUE,
    damage_code        TEXT NOT NULL UNIQUE,
    damage_description TEXT,
    is_disabled        BOOLEAN NOT NULL DEFAULT false,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_damage_codes_set_updated_at
    BEFORE UPDATE ON damage_codes
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE repair_codes (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    legacy_id          BIGINT UNIQUE,
    repair_code        TEXT NOT NULL UNIQUE,
    repair_description TEXT,
    is_disabled        BOOLEAN NOT NULL DEFAULT false,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_repair_codes_set_updated_at
    BEFORE UPDATE ON repair_codes
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE subview_damages (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    legacy_id      BIGINT UNIQUE,
    subview_id     UUID NOT NULL REFERENCES subviews(id) ON DELETE CASCADE,
    damage_code_id UUID NOT NULL REFERENCES damage_codes(id) ON DELETE RESTRICT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (subview_id, damage_code_id)
);
CREATE TRIGGER trg_subview_damages_set_updated_at
    BEFORE UPDATE ON subview_damages
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX idx_subview_damages_damage ON subview_damages(damage_code_id);

CREATE TABLE subview_repairs (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    legacy_id      BIGINT UNIQUE,
    subview_id     UUID NOT NULL REFERENCES subviews(id) ON DELETE CASCADE,
    repair_code_id UUID NOT NULL REFERENCES repair_codes(id) ON DELETE RESTRICT,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (subview_id, repair_code_id)
);
CREATE TRIGGER trg_subview_repairs_set_updated_at
    BEFORE UPDATE ON subview_repairs
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX idx_subview_repairs_repair ON subview_repairs(repair_code_id);

-- 4. Miscellaneous items --------------------------------------------------

CREATE TABLE misc_items (
    id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    legacy_id             BIGINT UNIQUE,
    equipment_category_id UUID NOT NULL REFERENCES equipment_categories(id) ON DELETE RESTRICT,
    misc_name             TEXT NOT NULL,
    misc_code             TEXT NOT NULL,
    is_disabled           BOOLEAN NOT NULL DEFAULT false,
    created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_misc_items_set_updated_at
    BEFORE UPDATE ON misc_items
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX idx_misc_items_category ON misc_items(equipment_category_id);
CREATE INDEX idx_misc_items_misc_code ON misc_items(misc_code);

CREATE TABLE main_view_misc_items (
    id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    legacy_id          BIGINT UNIQUE,
    main_view_id       UUID NOT NULL REFERENCES main_views(id) ON DELETE CASCADE,
    misc_item_id       UUID NOT NULL REFERENCES misc_items(id) ON DELETE RESTRICT,
    display_subview_id UUID REFERENCES subviews(id) ON DELETE CASCADE,
    created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_main_view_misc_items_set_updated_at
    BEFORE UPDATE ON main_view_misc_items
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Postgres treats NULL as distinct for uniqueness purposes, so a plain
-- UNIQUE(main_view_id, misc_item_id, display_subview_id) would not stop the
-- same misc item being attached at the main-view level more than once.
-- Two partial unique indexes cover both cases correctly:
CREATE UNIQUE INDEX ux_main_view_misc_items_main_level
    ON main_view_misc_items (main_view_id, misc_item_id)
    WHERE display_subview_id IS NULL;

CREATE UNIQUE INDEX ux_main_view_misc_items_subview_level
    ON main_view_misc_items (main_view_id, misc_item_id, display_subview_id)
    WHERE display_subview_id IS NOT NULL;

CREATE INDEX idx_main_view_misc_items_misc_item ON main_view_misc_items(misc_item_id);

CREATE TABLE main_view_components (
    id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    legacy_id    BIGINT UNIQUE,
    main_view_id UUID NOT NULL REFERENCES main_views(id) ON DELETE CASCADE,
    component_id UUID NOT NULL REFERENCES components(id) ON DELETE RESTRICT,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (main_view_id, component_id)
);
CREATE TRIGGER trg_main_view_components_set_updated_at
    BEFORE UPDATE ON main_view_components
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX idx_main_view_components_component ON main_view_components(component_id);

-- 5. UI component configuration ------------------------------------------

CREATE TABLE widget_types (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    legacy_id   BIGINT UNIQUE,
    name        TEXT NOT NULL UNIQUE,
    is_disabled BOOLEAN NOT NULL DEFAULT false,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_widget_types_set_updated_at
    BEFORE UPDATE ON widget_types
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE subview_fields (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    legacy_id      BIGINT UNIQUE,
    subview_id     UUID NOT NULL REFERENCES subviews(id) ON DELETE CASCADE,
    widget_type_id UUID NOT NULL REFERENCES widget_types(id) ON DELETE RESTRICT,
    label          TEXT NOT NULL,
    field_name     TEXT NOT NULL,
    display_order  INTEGER NOT NULL DEFAULT 0,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    UNIQUE (subview_id, field_name)
);
CREATE TRIGGER trg_subview_fields_set_updated_at
    BEFORE UPDATE ON subview_fields
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX idx_subview_fields_subview ON subview_fields(subview_id);

CREATE TABLE subview_field_options (
    id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    legacy_id        BIGINT UNIQUE,
    subview_field_id UUID NOT NULL REFERENCES subview_fields(id) ON DELETE CASCADE,
    label_value      TEXT NOT NULL,
    display_order    INTEGER NOT NULL DEFAULT 0,
    created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_subview_field_options_set_updated_at
    BEFORE UPDATE ON subview_field_options
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX idx_subview_field_options_field ON subview_field_options(subview_field_id);

-- 6. Quick actions ---------------------------------------------------------

CREATE TABLE quick_actions (
    id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    legacy_id      BIGINT UNIQUE,
    action_name    TEXT NOT NULL,
    repair_code_id UUID REFERENCES repair_codes(id) ON DELETE RESTRICT,
    component_id   UUID REFERENCES components(id) ON DELETE RESTRICT,
    main_view_id   UUID REFERENCES main_views(id) ON DELETE CASCADE,
    subview_id     UUID REFERENCES subviews(id) ON DELETE CASCADE,
    is_disabled    BOOLEAN NOT NULL DEFAULT false,
    created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT quick_action_single_target CHECK (
        (main_view_id IS NOT NULL)::int + (subview_id IS NOT NULL)::int = 1
    )
);
CREATE TRIGGER trg_quick_actions_set_updated_at
    BEFORE UPDATE ON quick_actions
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX idx_quick_actions_main_view ON quick_actions(main_view_id);
CREATE INDEX idx_quick_actions_subview ON quick_actions(subview_id);
