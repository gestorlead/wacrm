-- ============================================================
-- whatsapp_webhook_events: durable inbox/outbox for webhook delivery
--
-- Why this exists:
--   The webhook handler used to ack Meta with 200 immediately and then
--   process the event fire-and-forget. If processing threw (Supabase
--   blip, bug) or the container restarted mid-flight, the event was
--   LOST — Meta already got its 200, so it never retried.
--
--   Now every accepted event is persisted here BEFORE we ack. The
--   handler processes the happy path inline for low latency; a cron
--   drain (/api/whatsapp/webhook/process) retries anything that failed
--   or never ran, with exponential backoff, and parks exhausted events
--   as 'dead' for inspection.
--
--   Processing is safe to repeat: inbound dedup (UNIQUE message_id),
--   echo/history dedup, and idempotent status updates mean a retried
--   event produces no duplicate side effects.
--
-- Access: service-role only (webhook + cron). RLS is enabled with NO
--   policies, which denies all anon/authenticated access; the service
--   role bypasses RLS.
--
-- Idempotent — safe to re-run.
-- ============================================================

CREATE TABLE IF NOT EXISTS whatsapp_webhook_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  -- x-hub-signature-256 header. Meta signs the exact body bytes, so the
  -- same event redelivered carries the same signature — we use it to
  -- dedup redeliveries at ingest (see the unique index below).
  signature TEXT,
  payload JSONB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'processing', 'processed', 'failed', 'dead')),
  attempts INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  -- When the event becomes (re)eligible for the drain. Doubles as a
  -- processing lease: claiming sets this to now+lease so a crashed
  -- 'processing' row is re-claimed once the lease expires.
  next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at TIMESTAMPTZ
);

-- Dedup Meta redeliveries: identical body → identical HMAC signature.
CREATE UNIQUE INDEX IF NOT EXISTS idx_wa_webhook_events_signature
  ON whatsapp_webhook_events (signature)
  WHERE signature IS NOT NULL;

-- Drain query: rows eligible to (re)process, oldest first.
CREATE INDEX IF NOT EXISTS idx_wa_webhook_events_drain
  ON whatsapp_webhook_events (next_attempt_at)
  WHERE status IN ('pending', 'failed', 'processing');

ALTER TABLE whatsapp_webhook_events ENABLE ROW LEVEL SECURITY;
