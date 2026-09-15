-- A customer's acknowledgment of a job card's intake content, recorded as an
-- HMAC receipt over a canonical serialization of that content.
--
-- No signature image, vector strokes, or biometric data is stored, ever. The
-- receipt proves that THIS server recorded an acknowledgment of THIS exact
-- content at THIS time, and detects any later edit to the acknowledged fields.
-- It does not prove the customer personally signed, and it is not
-- non-repudiable against the server operator -- anyone holding the signing key
-- can forge one. That would need per-device asymmetric keys, judged heavier
-- than warranted here; the trade-off is written into the design spec.
--
-- The table is append-only on purpose. There is no updated_at and no
-- set_updated_at trigger, unlike every other table in this schema: a receipt
-- that could be edited in place would be evidence of nothing. Re-signing after
-- an intake edit inserts a new row and the earlier ones stay.

CREATE TABLE job_card_signatures (
    id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    job_card_id     UUID NOT NULL REFERENCES job_cards(id) ON DELETE CASCADE,

    -- Typed by the gatekeeper from what the customer gave; never validated
    -- against any identity system, which is exactly why the scheme claims
    -- content integrity rather than identity.
    signer_name     TEXT NOT NULL CHECK (length(btrim(signer_name)) > 0),
    signer_role     TEXT NOT NULL CHECK (signer_role IN ('CUSTOMER', 'DRIVER', 'TRUCKER')),

    -- When the customer acknowledged, which may precede created_at: a tablet
    -- offline in a yard captures the moment and syncs later. The service caps
    -- how far back a client may date this.
    signed_at       TIMESTAMPTZ NOT NULL,

    -- 16 random bytes, hex. Server-generated, never client-supplied: it is
    -- what stops two identical cards signed by the same person at the same
    -- second from producing the same receipt.
    nonce           TEXT NOT NULL CHECK (nonce ~ '^[0-9a-f]{32}$'),

    -- SHA-256 of the canonical JSON of the acknowledged fields, and the HMAC
    -- binding that hash to this signer, time, nonce and card.
    payload_hash    CHAR(64) NOT NULL CHECK (payload_hash ~ '^[0-9a-f]{64}$'),
    receipt_hmac    CHAR(64) NOT NULL CHECK (receipt_hmac ~ '^[0-9a-f]{64}$'),

    -- Which signing key produced receipt_hmac. Stored per row so rotating the
    -- secret is additive and never invalidates an existing receipt.
    key_version     SMALLINT NOT NULL DEFAULT 1 CHECK (key_version >= 1),
    -- Which field list produced payload_hash. Deliberately NOT key_version:
    -- rotating a leaked key must not silently change which fields a receipt
    -- covers, and extending the covered fields must not force a key rotation.
    payload_version SMALLINT NOT NULL DEFAULT 1 CHECK (payload_version >= 1),

    -- Free-text device hint from the client, for support triage only. Nothing
    -- is authenticated by it.
    device_id       TEXT,

    -- The staff member who operated the device. SET NULL rather than RESTRICT
    -- so removing a user never destroys a customer's acknowledgment.
    created_by      UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The only query this table serves: the latest receipt for a card, and its
-- history in the same order.
CREATE INDEX idx_job_card_signatures_card
    ON job_card_signatures (job_card_id, created_at DESC);
