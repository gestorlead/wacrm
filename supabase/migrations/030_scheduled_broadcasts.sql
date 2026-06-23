-- ============================================================
-- Scheduled broadcasts: snapshot recipients + serialized runner
--
-- Why this exists:
--   broadcasts.scheduled_at / status='scheduled' existed but nothing
--   created or executed scheduled broadcasts. The send logic lived in
--   the browser, so to run a broadcast SERVER-SIDE on a schedule we
--   snapshot the recipient list AND each recipient's resolved template
--   params at schedule time. The cron then just sends to the snapshotted
--   'pending' recipients — no browser logic, and the 'csv' audience
--   (a one-time upload) is captured correctly.
--
-- Columns / objects:
--   - broadcast_recipients.params : jsonb array of resolved body params
--     for THIS recipient (snapshot). NULL for immediate sends, which
--     resolve params at send time.
--   - idx_broadcasts_scheduler : lets the cron find scheduled/sending
--     broadcasts cheaply.
--   - cron_locks : a tiny lease-based mutex so overlapping cron runs
--     never double-send a broadcast's recipients. Service-role only.
--
-- Idempotent — safe to re-run.
-- ============================================================

ALTER TABLE broadcast_recipients
  ADD COLUMN IF NOT EXISTS params JSONB;

CREATE INDEX IF NOT EXISTS idx_broadcasts_scheduler
  ON broadcasts (scheduled_at)
  WHERE status IN ('scheduled', 'sending');

-- Lease-based lock to serialize a cron across overlapping invocations.
-- A run acquires by CAS-updating its row's lease into the future only
-- when the current lease has expired; on finish it releases by setting
-- the lease to now(). A crashed holder's lease simply expires.
CREATE TABLE IF NOT EXISTS cron_locks (
  name         TEXT PRIMARY KEY,
  locked_until TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO cron_locks (name, locked_until)
VALUES ('broadcasts', NOW())
ON CONFLICT (name) DO NOTHING;

-- Service-role only (the cron). RLS on, no policies → deny all others.
ALTER TABLE cron_locks ENABLE ROW LEVEL SECURITY;
