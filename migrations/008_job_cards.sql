-- Job cards: the document a chassis inspection produces, from Gatekeeper
-- intake through Estimator diagnosis to Reporter submission.
--
-- Only direction and equipment_type_id are NOT NULL. Everything else is
-- nullable on purpose, so a gatekeeper can save a partial card mid-conversation
-- with a driver; completeness is a submission-time rule, enforced in one place
-- by the service, not scattered across NOT NULL constraints that would block
-- saving a draft.

CREATE TABLE job_cards (
    id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- 'VIR-' + 8 chars of [0-9A-Z]; the human-facing identifier. The API
    -- addresses cards by id, so this is for display and search only.
    job_number TEXT NOT NULL UNIQUE,
    depot_id   UUID NOT NULL REFERENCES depots(id) ON DELETE RESTRICT,
    status     TEXT NOT NULL DEFAULT 'DRAFT' CHECK (status IN (
                   'DRAFT', 'IN_INSPECTION', 'SUBMITTED',
                   'IN_ESTIMATION', 'ESTIMATED', 'REPORTED', 'VOID')),
    -- Client-generated idempotency key: a retried create returns the existing
    -- card instead of a duplicate. Also the seam a future offline sync uses.
    client_uuid UUID,

    -- Intake -------------------------------------------------------------
    direction             TEXT NOT NULL CHECK (direction IN ('INBOUND', 'OUTBOUND')),
    equipment_type_id     UUID NOT NULL REFERENCES equipment_types(id) ON DELETE RESTRICT,
    trucker_name          TEXT,
    location              TEXT,
    inspected_at          TIMESTAMPTZ,
    equipment_prefix_id   UUID REFERENCES equipment_prefixes(id) ON DELETE RESTRICT,
    -- Snapshot of the prefix as typed, so renaming master data later cannot
    -- rewrite what a past card recorded.
    prefix_text           VARCHAR(8),
    container_number      TEXT,
    chassis_number        TEXT,
    genset_status         TEXT CHECK (genset_status IN (
                              'N/A', 'ATTACHED', 'POWERED_RUNNING', 'UNDER_MOUNT')),
    size                  SMALLINT CHECK (size IN (20, 40, 45, 53)),
    equipment_form        TEXT CHECK (equipment_form IN (
                              'GOOSENECK', 'TRI_AXLE', 'STANDARD', 'SLIDER', 'REEFER')),
    serial_number         TEXT,
    license_plate         TEXT,
    license_state         TEXT,
    license_expiry_date   DATE,
    registration_status   TEXT CHECK (registration_status IN ('OK', 'MISS', 'EXPIRED')),
    pool_point            TEXT,
    customer_name         TEXT,
    redelivery_release_no TEXT,
    customer_account_no   TEXT,
    on_hire_date          DATE,
    scac_code             TEXT,
    fhwa_sticker_date     DATE,
    driver_name           TEXT,
    manufacture_year      SMALLINT CHECK (manufacture_year BETWEEN 1900 AND 2200),

    -- Lifecycle ----------------------------------------------------------
    created_by   UUID REFERENCES users(id) ON DELETE SET NULL,
    updated_by   UUID REFERENCES users(id) ON DELETE SET NULL,
    submitted_by UUID REFERENCES users(id) ON DELETE SET NULL,
    submitted_at TIMESTAMPTZ,
    -- Non-null means frozen. requireUnlockedJobCard reads this single column
    -- rather than reasoning about the status list.
    locked_at    TIMESTAMPTZ,
    created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),

    CONSTRAINT job_card_has_identifier
        CHECK (num_nonnulls(container_number, chassis_number) >= 1)
);
CREATE TRIGGER trg_job_cards_set_updated_at
    BEFORE UPDATE ON job_cards
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- The depot's working list.
CREATE INDEX idx_job_cards_depot_list ON job_cards (depot_id, status, created_at DESC);
-- The cross-depot estimator queue.
CREATE INDEX idx_job_cards_queue ON job_cards (status, submitted_at DESC);
CREATE INDEX idx_job_cards_chassis ON job_cards (chassis_number);
CREATE INDEX idx_job_cards_container ON job_cards (container_number);
CREATE INDEX idx_job_cards_job_number ON job_cards (job_number);

-- Scoped to the depot rather than global: two depots retrying with the same
-- locally generated key must not collide with each other.
CREATE UNIQUE INDEX ux_job_cards_client_uuid
    ON job_cards (depot_id, client_uuid) WHERE client_uuid IS NOT NULL;

-- Status transitions, kept so "who submitted this and when" survives.
CREATE TABLE job_card_events (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_card_id   UUID NOT NULL REFERENCES job_cards(id) ON DELETE CASCADE,
    from_status   TEXT,
    to_status     TEXT NOT NULL,
    actor_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    note          TEXT,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_job_card_events_card ON job_card_events (job_card_id, created_at);
