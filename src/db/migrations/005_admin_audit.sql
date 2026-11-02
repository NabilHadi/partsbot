-- Admin web UI (/admin) audit trail: who changed what and when. Values that are personal data (staff phones)
-- are only ever recorded masked (last 4 digits); uploaded stock files are recorded by name + counts only.
CREATE TABLE admin_audit_log (
  id         bigserial PRIMARY KEY,
  at         timestamptz NOT NULL DEFAULT now(),
  actor      text NOT NULL,              -- "admin" (single admin user for now) + client ip
  action     text NOT NULL,              -- shop.create, shop.settings, shop.details, staff.add, staff.remove, stock.import, login, login.failed, logout
  shop_id    uuid REFERENCES shops(id) ON DELETE SET NULL,
  details    jsonb NOT NULL DEFAULT '{}'::jsonb
);
CREATE INDEX admin_audit_log_at_idx ON admin_audit_log (at DESC);
CREATE INDEX admin_audit_log_shop_idx ON admin_audit_log (shop_id, at DESC);
