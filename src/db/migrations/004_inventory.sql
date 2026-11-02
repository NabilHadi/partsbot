-- 004_inventory: shop stock imported from the shop's own export (xlsx/xlsm/csv), src/inventory/*.
--
-- Each import REPLACES the shop's previous items in one transaction (src/inventory/repository.ts):
-- the bot never sees a half-imported list. inventory_imports keeps the history and the reject COUNTS.
--
-- PDPL: rows that look like personal data (a phone number used as an item number, or a name containing a
-- phone number) are never stored; only how many there were (rejected_counts). No customer data here.
--
-- is_synthetic: qty/price were GENERATED for testing (the Medrar sample has neither). The bot treats
-- synthetic rows as missing unless the shop is a test shop that opted in (src/inventory/stock.ts).
CREATE TABLE inventory_imports (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  shop_id          uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  source           text NOT NULL CHECK (source IN ('xlsx', 'csv')),
  source_name      text NOT NULL,                    -- file basename only
  status           text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'completed', 'failed')),
  is_synthetic     boolean NOT NULL DEFAULT false,
  synthetic_seed   integer,
  header_row       integer,
  rows_total       integer NOT NULL DEFAULT 0,
  rows_imported    integer NOT NULL DEFAULT 0,
  rows_rejected    integer NOT NULL DEFAULT 0,
  rejected_counts  jsonb NOT NULL DEFAULT '{}'::jsonb, -- {"pii_phone_item_number": 62, ...}; counts only
  error            text,
  started_at       timestamptz NOT NULL DEFAULT now(),
  imported_at      timestamptz
);
CREATE INDEX inventory_imports_shop_idx ON inventory_imports (shop_id, started_at DESC);

CREATE TABLE inventory_items (
  id                      bigserial PRIMARY KEY,
  shop_id                 uuid NOT NULL REFERENCES shops(id) ON DELETE CASCADE,
  import_id               uuid NOT NULL REFERENCES inventory_imports(id) ON DELETE CASCADE,
  part_number_raw         text NOT NULL,           -- as the shop wrote it (trimmed)
  part_number_normalized  text NOT NULL,           -- A-Z0-9 only, see normalize.ts
  oem_base                text,                    -- 10-char OEM core ("0446506090"), null for shop codes
  variant_suffix          text,                    -- "J", "CH", "DENSO", "A0-J", ...
  name_ar                 text,
  brand                   text,
  unit                    text,
  active                  boolean NOT NULL DEFAULT true,
  category_code           text,
  group_code              text,
  alt_numbers             text[] NOT NULL DEFAULT '{}',
  qty                     integer CHECK (qty IS NULL OR qty >= 0),
  price_sar               numeric(12, 2) CHECK (price_sar IS NULL OR price_sar >= 0),
  vat_included            boolean NOT NULL DEFAULT true,
  currency                text NOT NULL DEFAULT 'SAR',
  is_synthetic            boolean NOT NULL DEFAULT false,
  source_row              integer,
  updated_at              timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX inventory_items_shop_pn_idx ON inventory_items (shop_id, part_number_normalized);
CREATE INDEX inventory_items_shop_oem_idx ON inventory_items (shop_id, oem_base);
