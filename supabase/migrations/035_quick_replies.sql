-- ============================================================
-- 035_quick_replies.sql — saved canned messages ("mensagens prontas")
--
-- Agents reuse common replies by typing `/<short_code>` in the composer.
-- A quick reply is plain account/agent-scoped text (optionally carrying
-- {{contact.name}} / {{agent.name}} tokens resolved at insert time) — no
-- Meta round-trip and no approval lifecycle, unlike message_templates.
--
-- Two ownership scopes share one table:
--   * owner_user_id IS NULL  → shared across the account (admins manage).
--   * owner_user_id = <uid>  → private to that agent (only they see/edit).
--
-- short_code is unique within its scope: once per account for shared rows,
-- once per owner for personal rows (two agents may both own "saudacao").
--
-- Idempotent.
-- ============================================================

CREATE TABLE IF NOT EXISTS quick_replies (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id    UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  owner_user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE, -- NULL = account-shared
  short_code    TEXT NOT NULL,          -- trigger code, e.g. "saudacao"
  content       TEXT NOT NULL,          -- body, may contain {{contact.name}} etc.
  created_by    UUID REFERENCES auth.users(id),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_quick_replies_account ON quick_replies(account_id);
CREATE INDEX IF NOT EXISTS idx_quick_replies_owner ON quick_replies(owner_user_id);

-- short_code unique within its scope (per account for shared, per owner for
-- personal). Partial indexes keep the two scopes from colliding with each other.
CREATE UNIQUE INDEX IF NOT EXISTS quick_replies_shared_code_key
  ON quick_replies(account_id, short_code) WHERE owner_user_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS quick_replies_personal_code_key
  ON quick_replies(owner_user_id, short_code) WHERE owner_user_id IS NOT NULL;

-- ============================================================
-- RLS — members see shared rows + their own personal rows. Admins manage
-- shared rows; each agent manages their own personal rows.
-- Reuses is_account_member(account_id, min_role) from migration 017.
-- ============================================================
ALTER TABLE quick_replies ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS quick_replies_select ON quick_replies;
DROP POLICY IF EXISTS quick_replies_insert ON quick_replies;
DROP POLICY IF EXISTS quick_replies_update ON quick_replies;
DROP POLICY IF EXISTS quick_replies_delete ON quick_replies;

-- SELECT: any account member sees shared rows; personal rows only their owner.
CREATE POLICY quick_replies_select ON quick_replies FOR SELECT USING (
  is_account_member(account_id)
  AND (owner_user_id IS NULL OR owner_user_id = auth.uid())
);

-- INSERT: shared rows require admin; personal rows require the row be owned
-- by the inserting (member) user.
CREATE POLICY quick_replies_insert ON quick_replies FOR INSERT WITH CHECK (
  (owner_user_id IS NULL AND is_account_member(account_id, 'admin'))
  OR (owner_user_id = auth.uid() AND is_account_member(account_id))
);

-- UPDATE / DELETE: owner of a personal row, or an admin for shared rows.
CREATE POLICY quick_replies_update ON quick_replies FOR UPDATE USING (
  owner_user_id = auth.uid()
  OR (owner_user_id IS NULL AND is_account_member(account_id, 'admin'))
);
CREATE POLICY quick_replies_delete ON quick_replies FOR DELETE USING (
  owner_user_id = auth.uid()
  OR (owner_user_id IS NULL AND is_account_member(account_id, 'admin'))
);
