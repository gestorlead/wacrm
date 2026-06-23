-- ============================================================
-- Schedule the scheduled-broadcasts runner (pg_cron + pg_net).
--
-- Depends on migration 029 (pg_cron + pg_net enabled, Vault secrets
-- wacrm_site_url + wacrm_cron_secret) and 030 (the runner's tables).
-- Runs every minute; the endpoint is self-bounded + serialized by a
-- lease lock, so a 1-minute cadence is safe. A longer pg_net timeout is
-- used because this job does real Meta sends (the others return fast).
--
-- Idempotent — safe to re-run.
-- ============================================================

DO $$
DECLARE j RECORD;
BEGIN
  FOR j IN SELECT jobid FROM cron.job WHERE jobname = 'wacrm_broadcasts_cron' LOOP
    PERFORM cron.unschedule(j.jobid);
  END LOOP;
END $$;

SELECT cron.schedule(
  'wacrm_broadcasts_cron',
  '* * * * *',
  $job$
  SELECT net.http_get(
    url := (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'wacrm_site_url') || '/api/whatsapp/broadcast/cron',
    headers := jsonb_build_object(
      'x-cron-secret', (SELECT decrypted_secret FROM vault.decrypted_secrets WHERE name = 'wacrm_cron_secret')
    ),
    timeout_milliseconds := 30000
  );
  $job$
);
