-- 003_bot_conversation_state: where the conversation engine keeps its per-chat state (src/bot/state.ts).
--
-- Why a separate table and not `conversations`: that table requires customer_phone_hash/_enc, and the
-- phone hashing + encryption code is not written yet. This one is keyed by the Zernio conversation id,
-- holds NO phone number, and can be folded into `conversations` later.
--
-- PDPL: `state` is small JSON: step, language, the VIN, the vehicle the customer confirmed, and the part
-- request they typed while we waited for the VIN. No message history. retention_until marks when the row
-- must be purged (purge job not written yet; the bot already ignores state older than the session TTL).
CREATE TABLE bot_conversation_state (
  shop_id                 uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  zernio_conversation_id  text NOT NULL,
  state                   jsonb NOT NULL,
  updated_at              timestamptz NOT NULL DEFAULT now(),
  retention_until         timestamptz NOT NULL,
  PRIMARY KEY (shop_id, zernio_conversation_id)
);
CREATE INDEX bot_conversation_state_retention_idx ON bot_conversation_state (retention_until);
