-- ============================================================
-- messages: dedup hardening + delivery-failure reason capture
--
-- Why this exists:
--   1. DEDUP — message_id had a NON-unique index and the inbound
--      webhook path did not check for an existing row before insert.
--      Meta redelivers webhooks (we ack 200 then process async; a slow
--      or failed process makes Meta retry), so the same customer
--      message could land twice as duplicate bubbles. Add a partial
--      UNIQUE index so the database is the backstop even if the
--      app-level check is skipped or races.
--
--   2. FAILURE REASON — a 'failed' message stored only the status, not
--      WHY. Meta returns rich error codes (e.g. 131047 re-engagement,
--      131026 undeliverable, 470 outside the 24h service window,
--      131051 unsupported). Capture code + text so agents can see and
--      act on the reason instead of a bare "failed".
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE messages
  ADD COLUMN IF NOT EXISTS error_code TEXT,
  ADD COLUMN IF NOT EXISTS error_text TEXT;

-- Collapse any pre-existing duplicate message_id rows BEFORE creating
-- the UNIQUE index (else creation fails). Keep the earliest row by
-- (created_at, id); NULL message_ids (drafts / outbound 'sending') are
-- left untouched.
DELETE FROM messages a
USING messages b
WHERE a.message_id IS NOT NULL
  AND a.message_id = b.message_id
  AND (a.created_at, a.id) > (b.created_at, b.id);

-- Replace the non-unique index with a partial UNIQUE one. Partial so
-- many rows can carry NULL message_id (outbound rows that haven't
-- reached Meta yet) without colliding.
DROP INDEX IF EXISTS idx_messages_message_id;
CREATE UNIQUE INDEX IF NOT EXISTS idx_messages_message_id_unique
  ON messages (message_id)
  WHERE message_id IS NOT NULL;
