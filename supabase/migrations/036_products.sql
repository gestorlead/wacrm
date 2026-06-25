-- ============================================================
-- 036_products.sql — products/services catalog + deal line items
--
-- A deal no longer stores a flat value/currency. Instead it carries
-- line items (`deal_products`) referencing a reusable catalog of
-- products/services (`products`). The deal's value is derived as
-- Σ(quantity × unit_price). Currency stays a per-account concern
-- (`accounts.default_currency`, migration 021) — products and line
-- items don't carry their own currency, preserving the
-- one-currency-per-account invariant used by every aggregation.
--
-- A product is either a one-time purchase or a subscription. For
-- subscriptions we record the billing period (fixed presets) — the
-- subscriptions feature in the next phase builds on this.
--
-- Idempotent.
-- ============================================================

-- ------------------------------------------------------------
-- Catalog
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS products (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id     UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name           TEXT NOT NULL,
  description    TEXT,
  type           TEXT NOT NULL DEFAULT 'one_time'
                   CHECK (type IN ('one_time', 'subscription')),
  price          NUMERIC(12,2) NOT NULL DEFAULT 0,
  -- Required for subscriptions, must be NULL for one-time products.
  billing_period TEXT
                   CHECK (billing_period IN ('monthly', 'quarterly', 'semiannual', 'annual')),
  -- Archive instead of delete so historical line items keep a parent.
  active          BOOLEAN NOT NULL DEFAULT true,
  created_by      UUID REFERENCES auth.users(id),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- billing_period present iff the product is a subscription.
  CONSTRAINT products_billing_period_coherent CHECK (
    (type = 'subscription' AND billing_period IS NOT NULL)
    OR (type = 'one_time' AND billing_period IS NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_products_account ON products(account_id);

-- updated_at maintenance (reuses update_updated_at_column from migration 017).
DROP TRIGGER IF EXISTS set_updated_at ON products;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ------------------------------------------------------------
-- Deal line items
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS deal_products (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id     UUID NOT NULL REFERENCES deals(id) ON DELETE CASCADE,
  -- RESTRICT: a product in use can't be hard-deleted (archive it instead).
  product_id  UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  account_id  UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, -- direct RLS scope
  quantity    NUMERIC(12,2) NOT NULL DEFAULT 1 CHECK (quantity > 0),
  -- Snapshot of the catalog price when the item was added, so a later
  -- price change in the catalog doesn't rewrite historical deals.
  unit_price  NUMERIC(12,2) NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_deal_products_deal ON deal_products(deal_id);
CREATE INDEX IF NOT EXISTS idx_deal_products_product ON deal_products(product_id);

-- ============================================================
-- RLS — reuses is_account_member(account_id, min_role) from migration 017.
--   products      — any member reads; admins manage (workspace config).
--   deal_products — any member reads/writes (mirrors who edits deals).
-- ============================================================
ALTER TABLE products ENABLE ROW LEVEL SECURITY;
ALTER TABLE deal_products ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS products_select ON products;
DROP POLICY IF EXISTS products_insert ON products;
DROP POLICY IF EXISTS products_update ON products;
DROP POLICY IF EXISTS products_delete ON products;

CREATE POLICY products_select ON products FOR SELECT USING (
  is_account_member(account_id)
);
CREATE POLICY products_insert ON products FOR INSERT WITH CHECK (
  is_account_member(account_id, 'admin')
);
CREATE POLICY products_update ON products FOR UPDATE USING (
  is_account_member(account_id, 'admin')
);
CREATE POLICY products_delete ON products FOR DELETE USING (
  is_account_member(account_id, 'admin')
);

DROP POLICY IF EXISTS deal_products_select ON deal_products;
DROP POLICY IF EXISTS deal_products_insert ON deal_products;
DROP POLICY IF EXISTS deal_products_update ON deal_products;
DROP POLICY IF EXISTS deal_products_delete ON deal_products;

CREATE POLICY deal_products_select ON deal_products FOR SELECT USING (
  is_account_member(account_id)
);
CREATE POLICY deal_products_insert ON deal_products FOR INSERT WITH CHECK (
  is_account_member(account_id)
);
CREATE POLICY deal_products_update ON deal_products FOR UPDATE USING (
  is_account_member(account_id)
);
CREATE POLICY deal_products_delete ON deal_products FOR DELETE USING (
  is_account_member(account_id)
);

-- ------------------------------------------------------------
-- Deal value/currency now derive from line items (Σ qty × unit_price)
-- in the account's default currency. Drop the legacy flat columns.
-- Legacy values are not ported (product decision).
-- ------------------------------------------------------------
ALTER TABLE deals DROP COLUMN IF EXISTS value;
ALTER TABLE deals DROP COLUMN IF EXISTS currency;
