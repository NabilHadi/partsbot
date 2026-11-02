-- One row per AI model attempt (for the /admin/app health: success rate, last error, latency).
-- NO prompt, customer text or reply: only provider, model, stage, outcome code, latency and token counts.
-- The worker deletes rows older than 30 days.
CREATE TABLE ai_attempts (
  id                  bigserial PRIMARY KEY,
  at                  timestamptz NOT NULL DEFAULT now(),
  call_id             uuid NOT NULL,
  provider            text NOT NULL,
  model               text NOT NULL,
  stage               text NOT NULL,
  attempt             smallint NOT NULL,
  final               boolean NOT NULL,
  ok                  boolean NOT NULL,
  reason              text,
  latency_ms          integer NOT NULL,
  input_tokens        integer NOT NULL DEFAULT 0,
  output_tokens       integer NOT NULL DEFAULT 0,
  cached_input_tokens integer NOT NULL DEFAULT 0
);
CREATE INDEX ai_attempts_at_idx ON ai_attempts (at DESC);
