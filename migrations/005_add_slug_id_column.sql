-- Add slug_id column to equipment hierarchy and component tables
-- The slug_id is an 8-character uppercase alphanumeric string (charset: 0-9, A-Z)
-- used for URL-friendly identifiers, similar to nanoid format.

-- Helper function to generate a random 8-character slug_id
-- Uses PostgreSQL's random() to select from the charset 0-9, A-Z
CREATE OR REPLACE FUNCTION generate_slug_id(length INT DEFAULT 8)
RETURNS TEXT AS $$
DECLARE
    charset TEXT := '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    result TEXT := '';
    i INT;
BEGIN
    FOR i IN 1..length LOOP
        result := result || substr(charset, floor(random() * 36)::INT + 1, 1);
    END LOOP;
    RETURN result;
END;
$$ LANGUAGE plpgsql;

-- Helper function to generate a unique slug_id with collision retry logic
-- Attempts up to 10 times to generate a unique slug_id for a given table
CREATE OR REPLACE FUNCTION generate_unique_slug_id(
    p_table_name TEXT,
    p_max_retries INT DEFAULT 10
)
RETURNS TEXT AS $$
DECLARE
    v_slug_id TEXT;
    v_attempt INT := 0;
    v_exists BOOLEAN;
    v_query TEXT;
BEGIN
    LOOP
        v_attempt := v_attempt + 1;
        v_slug_id := generate_slug_id(8);

        -- Check if slug_id already exists in the table
        v_query := format('SELECT EXISTS(SELECT 1 FROM %I WHERE slug_id = %L)',
                         p_table_name, v_slug_id);
        EXECUTE v_query INTO v_exists;

        IF NOT v_exists THEN
            RETURN v_slug_id;
        END IF;

        IF v_attempt >= p_max_retries THEN
            RAISE EXCEPTION 'Failed to generate unique slug_id after % attempts for table %',
                          p_max_retries, p_table_name;
        END IF;
    END LOOP;
END;
$$ LANGUAGE plpgsql;

-- 1. Add slug_id column to equipment_categories
ALTER TABLE equipment_categories
ADD COLUMN slug_id VARCHAR(8);

UPDATE equipment_categories
SET slug_id = generate_unique_slug_id('equipment_categories')
WHERE slug_id IS NULL;

ALTER TABLE equipment_categories
ALTER COLUMN slug_id SET NOT NULL,
ADD CONSTRAINT ux_equipment_categories_slug_id UNIQUE (slug_id);

-- 2. Add slug_id column to equipment_types
ALTER TABLE equipment_types
ADD COLUMN slug_id VARCHAR(8);

UPDATE equipment_types
SET slug_id = generate_unique_slug_id('equipment_types')
WHERE slug_id IS NULL;

ALTER TABLE equipment_types
ALTER COLUMN slug_id SET NOT NULL,
ADD CONSTRAINT ux_equipment_types_slug_id UNIQUE (slug_id);

-- 3. Add slug_id column to main_views
ALTER TABLE main_views
ADD COLUMN slug_id VARCHAR(8);

UPDATE main_views
SET slug_id = generate_unique_slug_id('main_views')
WHERE slug_id IS NULL;

ALTER TABLE main_views
ALTER COLUMN slug_id SET NOT NULL,
ADD CONSTRAINT ux_main_views_slug_id UNIQUE (slug_id);

-- 4. Add slug_id column to subviews
ALTER TABLE subviews
ADD COLUMN slug_id VARCHAR(8);

UPDATE subviews
SET slug_id = generate_unique_slug_id('subviews')
WHERE slug_id IS NULL;

ALTER TABLE subviews
ALTER COLUMN slug_id SET NOT NULL,
ADD CONSTRAINT ux_subviews_slug_id UNIQUE (slug_id);

-- 5. Add slug_id column to components
ALTER TABLE components
ADD COLUMN slug_id VARCHAR(8);

UPDATE components
SET slug_id = generate_unique_slug_id('components')
WHERE slug_id IS NULL;

ALTER TABLE components
ALTER COLUMN slug_id SET NOT NULL,
ADD CONSTRAINT ux_components_slug_id UNIQUE (slug_id);

-- Clean up helper functions (optional, keep if you want to reuse them for other tables)
-- DROP FUNCTION generate_unique_slug_id(TEXT, INT);
-- DROP FUNCTION generate_slug_id(INT);
