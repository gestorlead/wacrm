-- ============================================================
-- 033_templates_per_inbox.sql — WhatsApp templates scoped to an inbox
--
-- Templates on Meta belong to a WABA. Each inbox (032) is one number with
-- its own waba_id, so a single account-global template catalogue is wrong
-- once an account connects more than one number: sync/edit/delete only ever
-- hit the "primary" WABA and same-named templates across WABAs collide.
--
-- This migration ties each template to the inbox (WABA) that owns it:
--   1. Adds `message_templates.inbox_id`.
--   2. Backfills existing templates to the account's primary (earliest) inbox.
--   3. Replaces the legacy UNIQUE(user_id, name, language) with
--      UNIQUE(inbox_id, name, language) — per-WABA uniqueness, and teammates
--      no longer shadow each other.
--   4. Rewrites RLS so members who can access an inbox see its templates;
--      admins manage them.
--
-- inbox_id stays NULLABLE: an account may hold templates created before any
-- number was connected (no inbox to attach to). Those stay unlinked and are
-- simply invisible in the per-inbox UI until re-synced under an inbox.
--
-- Idempotent.
-- ============================================================

ALTER TABLE message_templates
  ADD COLUMN IF NOT EXISTS inbox_id UUID REFERENCES inboxes(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_message_templates_inbox ON message_templates(inbox_id);

-- Backfill: link each existing template to its account's primary inbox
-- (earliest created). Accounts with templates but no inbox keep inbox_id NULL.
UPDATE message_templates t
SET inbox_id = (
  SELECT i.id FROM inboxes i
  WHERE i.account_id = t.account_id
  ORDER BY i.created_at, i.id
  LIMIT 1
)
WHERE t.inbox_id IS NULL;

-- Swap the uniqueness key: drop the legacy per-user constraint, add a
-- per-inbox one. Partial (WHERE inbox_id IS NOT NULL) so unlinked legacy
-- rows don't trip it.
ALTER TABLE message_templates DROP CONSTRAINT IF EXISTS message_templates_user_name_language_key;
DROP INDEX IF EXISTS message_templates_user_name_language_key;
CREATE UNIQUE INDEX IF NOT EXISTS message_templates_inbox_name_language_key
  ON message_templates (inbox_id, name, language)
  WHERE inbox_id IS NOT NULL;

-- ============================================================
-- RLS — templates follow inbox access (members read; admins manage).
-- account_id stays on the row for the admin write check.
-- ============================================================
DROP POLICY IF EXISTS message_templates_select ON message_templates;
DROP POLICY IF EXISTS message_templates_insert ON message_templates;
DROP POLICY IF EXISTS message_templates_update ON message_templates;
DROP POLICY IF EXISTS message_templates_delete ON message_templates;

-- SELECT: any member who can access the inbox (so the broadcast / flow
-- pickers see the templates of inboxes they work). Rows with a NULL inbox
-- (legacy/unlinked) fall back to account membership so they don't vanish.
CREATE POLICY message_templates_select ON message_templates FOR SELECT USING (
  (inbox_id IS NOT NULL AND can_access_inbox(inbox_id))
  OR (inbox_id IS NULL AND is_account_member(account_id))
);
CREATE POLICY message_templates_insert ON message_templates FOR INSERT WITH CHECK (
  is_account_member(account_id, 'admin')
);
CREATE POLICY message_templates_update ON message_templates FOR UPDATE USING (
  is_account_member(account_id, 'admin')
);
CREATE POLICY message_templates_delete ON message_templates FOR DELETE USING (
  is_account_member(account_id, 'admin')
);
