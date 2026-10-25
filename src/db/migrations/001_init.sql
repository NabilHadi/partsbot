-- 001_init: initial PartsBot schema.
--
-- PDPL notes (Saudi Personal Data Protection Law):
--  * The shop is the data controller; PartsBot is the processor. Every customer-linked row
--    carries shop_id so a shop's data can be exported or erased as a unit.
--  * Customer phone numbers are stored as a keyed hash (for lookup) plus an encrypted copy
--    (for replying). Never store them in clear text. Encryption/hashing happens in app code.
--  * retention_until marks when a row must be purged; a scheduled worker job deletes expired rows.
--  * consent_records is append-only evidence of consent and its withdrawal.
-- VINs and OneEPC catalog data contain no personal data and are not stored here.

-- One row per installation (a shop connected to a WhatsApp number).
CREATE TABLE shops (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name               text NOT NULL,
  city               text,
  zernio_account_id  text UNIQUE,
  waba_id            text,
  plan               text NOT NULL DEFAULT 'starter',
  status             text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'closed')),
  -- Typed per-shop settings (quoting, hours, languages, caps...) live here until they earn columns.
  config             jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

-- One row per customer chat with a shop.
CREATE TABLE conversations (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id                 uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  zernio_conversation_id  text,
  customer_phone_hash     text NOT NULL,   -- keyed hash (HMAC), used for lookup
  customer_phone_enc      bytea NOT NULL,  -- encrypted E.164 number, used for replies
  language                text,            -- 'ar' | 'en' | NULL until detected
  state                   text NOT NULL DEFAULT 'bot'
                          CHECK (state IN ('bot', 'awaiting_customer', 'handed_off', 'closed')),
  window_expires_at       timestamptz,     -- end of WhatsApp 24h service window
  bot_paused_until        timestamptz,     -- staff takeover pause
  last_message_at         timestamptz,
  created_at              timestamptz NOT NULL DEFAULT now(),
  retention_until         timestamptz NOT NULL, -- purge date (set from shop retention policy)
  UNIQUE (shop_id, zernio_conversation_id)
);
CREATE INDEX conversations_shop_phone_idx ON conversations (shop_id, customer_phone_hash);
CREATE INDEX conversations_retention_idx ON conversations (retention_until);

CREATE TABLE messages (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id      uuid NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  direction            text NOT NULL CHECK (direction IN ('in', 'out')),
  source               text NOT NULL CHECK (source IN ('customer', 'bot', 'staff_app')),
  type                 text NOT NULL DEFAULT 'text' CHECK (type IN ('text', 'audio', 'image', 'other')),
  text                 text,
  media_ref            text,
  platform_message_id  text,                -- WhatsApp/Zernio id; used to drop duplicate webhooks
  -- Tool results (OneEPC, inventory) the bot reply was built from, so a wrong answer can be traced.
  tool_results         jsonb,
  created_at           timestamptz NOT NULL DEFAULT now(),
  retention_until      timestamptz NOT NULL,
  UNIQUE (conversation_id, platform_message_id)
);
CREATE INDEX messages_conversation_idx ON messages (conversation_id, created_at);
CREATE INDEX messages_retention_idx ON messages (retention_until);

-- Daily and monthly usage per shop; drives caps and billing.
CREATE TABLE usage_counters (
  shop_id       uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  period_type   text NOT NULL CHECK (period_type IN ('day', 'month')),
  period_start  date NOT NULL,
  bot_messages  integer NOT NULL DEFAULT 0,
  conversations integer NOT NULL DEFAULT 0,
  llm_tokens    bigint  NOT NULL DEFAULT 0,
  stt_seconds   integer NOT NULL DEFAULT 0,
  est_cost_sar  numeric(10, 4) NOT NULL DEFAULT 0,
  PRIMARY KEY (shop_id, period_type, period_start)
);

-- Append-only evidence of customer consent to bot processing; withdrawal sets withdrawn_at.
CREATE TABLE consent_records (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id             uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  customer_phone_hash text NOT NULL,
  purpose             text NOT NULL DEFAULT 'parts_lookup_bot',
  notice_version      text NOT NULL,        -- which privacy notice text the customer saw
  consent_at          timestamptz NOT NULL DEFAULT now(),
  withdrawn_at        timestamptz,
  source              text NOT NULL DEFAULT 'whatsapp_message', -- how consent was captured
  retention_until     timestamptz NOT NULL
);
CREATE INDEX consent_records_lookup_idx ON consent_records (shop_id, customer_phone_hash);
