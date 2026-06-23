-- ============================================================
-- whatsapp_config: Embedded Signup (Coexistence) onboarding
--
-- Why this exists:
--   Until now the only way to connect a WhatsApp number was the
--   manual flow (user types Phone Number ID, WABA ID, Access Token,
--   Verify Token, PIN). This adds the automatic "Connect with
--   Facebook" path (Meta Embedded Signup, Tech Provider model): the
--   user clicks, picks/links a number, and we exchange a short-lived
--   code for a token + subscribe the webhook automatically.
--
--   The same path serves two outcomes from ONE flow:
--     - a Cloud number already in the user's WABA, and
--     - a WhatsApp Business *app* number entering Coexistence (the
--       number keeps working in the phone app AND on the Cloud API).
--
--   These columns record which path produced the row and the
--   Coexistence-specific metadata. The token columns
--   (phone_number_id / waba_id / access_token / verify_token) already
--   exist on the table — not re-added here.
--
-- Backfill: all new columns are nullable / defaulted. Every existing
--   (manual) row keeps working and is described by the
--   connection_type default of 'manual'.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE whatsapp_config
  ADD COLUMN IF NOT EXISTS connection_type TEXT NOT NULL DEFAULT 'manual'
    CHECK (connection_type IN ('manual', 'embedded_signup')),
  ADD COLUMN IF NOT EXISTS meta_business_id TEXT,
  ADD COLUMN IF NOT EXISTS is_coexistence BOOLEAN NOT NULL DEFAULT false;

-- Supports an admin view of "all embedded-signup / coexistence
-- connections"; cheap to maintain.
CREATE INDEX IF NOT EXISTS idx_whatsapp_config_connection_type
  ON whatsapp_config (connection_type);
