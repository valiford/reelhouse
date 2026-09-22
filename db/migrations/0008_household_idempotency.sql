-- RH-0027 migration 0008: replay-detection keys for the watch-progress API.
--
-- idempotency_record makes client retries safe where a retry must not
-- duplicate an effect: the watch-progress PUT appends to the append-only
-- playback_event table, so a blind replay would fabricate history. A client
-- may send an Idempotency-Key; the first write claims (scope, key) and the
-- mutation commit atomically, and a replay with the same payload fingerprint
-- is answered from stored state without appending again.
--
-- Keys are namespaced by scope so unrelated endpoints can never collide on
-- a client-generated key. There is deliberately no stored response here —
-- replays re-read the overlay state; the claim only guards the append.

CREATE TABLE idempotency_record (
    id              uuid PRIMARY KEY DEFAULT uuidv7(),
    scope           text NOT NULL CHECK (btrim(scope) <> ''),
    idempotency_key text NOT NULL CHECK (btrim(idempotency_key) <> ''),
    -- Optional hash of the request the key committed, for replay detection.
    fingerprint     text,
    created_at      timestamptz NOT NULL DEFAULT now(),
    UNIQUE (scope, idempotency_key)
);
