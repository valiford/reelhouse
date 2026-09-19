-- ReelHouse migration 0010: idempotent API replay responses (RH-0018).
--
-- RH-0003's idempotency_record already records WHICH operations ran; this
-- migration adds WHAT they returned, so a replay with the same key and
-- fingerprint can return the original response byte-for-byte instead of
-- re-deriving it from current state (which may have moved on).
--
-- Invariant: response columns are written in the SAME transaction as the
-- mutation they describe, so a committed row always has both — a marker
-- without a response, or a response without its mutation, cannot exist.
-- The CHECK enforces the visible half of that invariant (success-only,
-- object-shaped, size-bounded); the atomicity half is structural.

ALTER TABLE idempotency_record
    ADD COLUMN response_status integer,
    ADD COLUMN response_body jsonb;

-- Stored responses are single-resource success bodies, capped well below
-- any list read (the RH-0018 write contract keeps replays bounded).
ALTER TABLE idempotency_record
    ADD CONSTRAINT idempotency_record_response_shape CHECK (
        (response_status IS NULL AND response_body IS NULL)
        OR (
            response_status BETWEEN 200 AND 299
            AND response_body IS NOT NULL
            AND jsonb_typeof(response_body) = 'object'
            AND octet_length(response_body::text) <= 8192
        )
    );
