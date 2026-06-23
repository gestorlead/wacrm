# Scheduler & Cron (the "acionador")

wacrm has several features that depend on **recurring background work**.
Next.js has no built-in scheduler and the app runs as a single stateless
process, so the recurring work is exposed as **HTTP endpoints** and
triggered on a schedule by **Supabase pg_cron + pg_net** — the database
itself fires the schedule and calls the endpoint. No extra container, no
external pinger; it survives app restarts and is observable in-DB.

## Why it matters

If nothing triggers these endpoints, the features below **silently stop
working** (no error, the work just never happens):

| Endpoint | Interval | What it does | Breaks if not run |
|----------|----------|--------------|-------------------|
| `GET /api/automations/cron` | 1 min | Resume automation **Wait** steps (`automation_pending_executions`) | Automations with a Wait step hang forever |
| `GET /api/whatsapp/webhook/process` | 1 min | Retry failed/stranded webhook events + sweep stuck `sending` messages | Failed inbound events never retried; messages stuck on a spinner |
| `GET /api/flows/cron` | 5 min | Time out stale flow runs | A stuck `active` flow run **permanently blocks new flows for that contact** (partial unique index) |

All three authenticate with the header `x-cron-secret`, matched against
the `AUTOMATION_CRON_SECRET` environment variable.

There is also a pure-SQL `wacrm_sweep_stuck_sending` pg_cron job that
runs the stuck-`sending` sweep directly in the database — an
app-independent backstop that works even if the app is down.

## How it's wired (Supabase pg_cron + pg_net)

Migration `029_scheduler_pg_cron.sql` enables `pg_cron` and `pg_net` and
schedules the jobs. Each HTTP job reads the **site URL** and the
**cron secret** from **Supabase Vault** at call time, so the migration
itself carries no secrets and is environment-agnostic.

```
pg_cron (interval) → pg_net.http_get(<site_url> + <path>, { x-cron-secret: <secret> })
```

### One-time setup per environment

Before the jobs can authenticate, create the two Vault secrets **once**
(values are NOT in the migration — they're per-environment):

```sql
-- In the Supabase SQL editor (or via the MCP). Use YOUR values.
select vault.create_secret(
  '<your AUTOMATION_CRON_SECRET>', 'wacrm_cron_secret',
  'Shared secret for the wacrm cron endpoints (x-cron-secret header)'
);
select vault.create_secret(
  'https://wacrm.gestorlead.com.br', 'wacrm_site_url',
  'Public base URL of this wacrm deployment (no trailing slash)'
);
```

`AUTOMATION_CRON_SECRET` must be a plain ASCII value (e.g.
`openssl rand -hex 32`). Keep the Vault `wacrm_cron_secret` and the app's
`AUTOMATION_CRON_SECRET` env var in sync — if they diverge, every job
gets a 401.

To rotate the secret: update the env var, redeploy, then
`select vault.update_secret(<id>, '<new value>')` for `wacrm_cron_secret`.

## Verifying it works

```sql
-- The scheduled jobs:
select jobname, schedule, active from cron.job order by jobname;

-- Recent runs (status, duration, any error):
select j.jobname, r.status, r.start_time, r.return_message
from cron.job_run_details r
join cron.job j on j.jobid = r.jobid
order by r.start_time desc
limit 20;

-- pg_net responses from the HTTP jobs (look for 200s):
select id, status_code, (timed_out), created
from net._http_response
order by created desc
limit 20;
```

A healthy HTTP job shows `cron.job_run_details.status = 'succeeded'` (the
SQL ran) and the corresponding `net._http_response.status_code = 200`
(the endpoint accepted it). A `401` means the Vault `wacrm_cron_secret`
doesn't match the app's `AUTOMATION_CRON_SECRET`.

## Alternatives (not used)

- **Dedicated cron container** in the Swarm stack — works, but it's
  another service to run and monitor.
- **External pinger** (GitHub Actions, cron-job.org) — adds a dependency
  outside your infra and another place to store the secret.
- **Supabase scheduled Edge Functions** — also native, but more moving
  parts than pg_cron + pg_net for "call an endpoint on a schedule".

pg_cron + pg_net was chosen because it needs zero extra infrastructure,
lives in the managed database, and is centrally observable.

## Known gap: scheduled broadcasts

`broadcasts.scheduled_at` / `status = 'scheduled'` exist in the schema
but are **not wired**: nothing creates scheduled broadcasts (the UI sends
immediately) and there is no server-side executor to send them on a
schedule. Building that is a feature in its own right — it needs a
scheduling UI plus a server-side broadcast runner (the current send logic
lives in the browser hook `use-broadcast-sending.ts`). Tracked separately.
