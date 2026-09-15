-- Depots and depot membership.
--
-- A depot is a physical yard. Every job card belongs to exactly one, and a
-- user sees only their own depot's cards. Membership is a join table rather
-- than a column on users so that reassignment keeps its history and so a
-- future multi-depot user needs no migration — today the partial unique index
-- below restricts each user to one *active* depot at a time.

CREATE TABLE depots (
    id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    slug_id     VARCHAR(8) NOT NULL UNIQUE,
    code        TEXT NOT NULL UNIQUE,
    name        TEXT NOT NULL,
    timezone    TEXT NOT NULL DEFAULT 'UTC',
    address     TEXT,
    is_disabled BOOLEAN NOT NULL DEFAULT false,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER trg_depots_set_updated_at
    BEFORE UPDATE ON depots
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE depot_members (
    id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    depot_id      UUID NOT NULL REFERENCES depots(id) ON DELETE RESTRICT,
    user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    is_active     BOOLEAN NOT NULL DEFAULT true,
    assigned_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
    unassigned_at TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT depot_member_active_has_no_unassigned_at
        CHECK (is_active = false OR unassigned_at IS NULL)
);
CREATE TRIGGER trg_depot_members_set_updated_at
    BEFORE UPDATE ON depot_members
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- The rule the whole access model rests on: at most one active depot per
-- user. Enforced by Postgres rather than by the service, so no code path can
-- work around it. Inactive rows are not covered, which is what lets the
-- reassignment history accumulate.
CREATE UNIQUE INDEX ux_depot_members_active_user
    ON depot_members (user_id) WHERE is_active;

CREATE INDEX idx_depot_members_depot
    ON depot_members (depot_id) WHERE is_active;
