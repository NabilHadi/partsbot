-- Idempotency for Zernio webhook deliveries. Zernio delivers at least once and retries up to
-- 7 times over ~51 hours, so the receiver claims a key (derived from the provider message id)
-- before enqueueing. Rows can be purged after ~7 days (purge job not written yet).
CREATE TABLE inbound_dedupe (
  dedupe_key  text PRIMARY KEY,
  event_id    text,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX inbound_dedupe_created_idx ON inbound_dedupe (created_at);
