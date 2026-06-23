-- ============================================================
-- Native scheduler: pg_cron + pg_net (the "acionador")
--
-- Why this exists:
--   wacrm has cron ENDPOINTS but nothing was triggering them, so in
--   production these silently did NOT run:
--     - /api/automations/cron       → automation Wait-steps never resumed
--     - /api/flows/cron             → stale flow runs never timed out
--                                     (a stuck 'active' run permanently
--                                      blocks new flows for that contact)
--     - /api/whatsapp/webhook/process → failed webhook events never
--                                       retried; stuck 'sending' never swept
--
--   Next.js has no built-in scheduler and the app runs as a single
--   stateless process, so we schedule from the database itself —
--   pg_cron fires on an interval and pg_net makes the HTTP call to our
--   endpoint. No extra container, no external pinger; survives app
--   restarts; observable via cron.job_run_details.
--
-- SECRET / URL: read from Supabase Vault at call time, so this migration
--   is environment-agnostic and carries NO secrets. Create these two
--   Vault secrets ONCE per environment before the jobs can authenticate
--   (see docs/automations-and-cron.md):
--     - wacrm_cron_secret : the value of AUTOMATION_CRON_SECRET
--     - wacrm_site_url    : e.g. https://wacrm.gestorlead.com.br (no slash)
--
-- Idempotent — safe to re-run (jobs are unscheduled then re-created).
-- ============================================================

CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;

-- Drop our jobs first so re-running this migration doesn't duplicate them.
DO $$
DECLARE j RECORD;
BEGIN
  FOR j IN
    SELECT jobid FROM cron.job
    WHERE jobname IN (
      'wacrm_automations_cron',
      'wacrm_flows_cron',
      'wacrm_webhook_drain',
      'wacrm_sweep_stuck_sending'
    )
  LOOP
    PERFORM cron.unschedule(j.jobid);
  END LOOP;
END $$;

-- --- HTTP-triggered jobs (need the app's logic) ----------------------

-- Resume automation Wait-steps — every minute (drains automation_pending_executions).
SELECT cron.schedule(
  'wacrm_automations_cron',
  '* * * * *',
  $job$
  SELECT net.http_get(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'wacrm_site_url') || '/api/automations/cron',
    headers := jsonb_build_object(
      'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'wacrm_cron_secret')
    )
  );
  $job$
);

-- Retry failed/stranded webhook events + sweep stuck sends — every minute.
SELECT cron.schedule(
  'wacrm_webhook_drain',
  '* * * * *',
  $job$
  SELECT net.http_get(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'wacrm_site_url') || '/api/whatsapp/webhook/process',
    headers := jsonb_build_object(
      'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'wacrm_cron_secret')
    )
  );
  $job$
);

-- Time out stale flow runs — every 5 minutes (less urgent).
SELECT cron.schedule(
  'wacrm_flows_cron',
  '*/5 * * * *',
  $job$
  SELECT net.http_get(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'wacrm_site_url') || '/api/flows/cron',
    headers := jsonb_build_object(
      'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'wacrm_cron_secret')
    )
  );
  $job$
);

-- --- Pure-SQL hardening job (runs even if the app is down) ------------

-- Stuck-'sending' sweep as a direct UPDATE — app-independent backstop for
-- the same sweep the webhook drain endpoint does. A message stranded in
-- 'sending' >10 min means the send route crashed between pre-insert and
-- Meta confirming; flip it to 'failed' so the agent isn't stuck on a
-- spinner. Idempotent.
SELECT cron.schedule(
  'wacrm_sweep_stuck_sending',
  '*/5 * * * *',
  $job$
  UPDATE messages
  SET status = 'failed',
      error_text = 'Send interrupted before Meta confirmed delivery (timed out).'
  WHERE status = 'sending'
    AND created_at < NOW() - INTERVAL '10 minutes';
  $job$
);
