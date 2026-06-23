// Durable inbox/outbox for WhatsApp webhook events.
//
// The webhook handler persists every accepted event here BEFORE acking
// Meta, then processes the happy path inline. The cron drain
// (/api/whatsapp/webhook/process) retries whatever failed or never ran.
//
// Both paths CLAIM a row (CAS to 'processing' with a lease) before
// working it, so inline + cron never double-process. Reprocessing is
// safe because the message pipeline is idempotent (UNIQUE message_id,
// echo/history dedup, idempotent status updates).

import { supabaseAdmin } from '@/lib/flows/admin-client'

const TABLE = 'whatsapp_webhook_events'

/** Give up after this many attempts; the row is parked as 'dead'. */
const MAX_ATTEMPTS = 6
/** Minutes to wait before retry N (1-indexed). Last value repeats. */
const BACKOFF_MINUTES = [1, 5, 15, 60, 360]
/** Processing lease — a 'processing' row is re-claimable after this. */
const LEASE_MINUTES = 10

export interface WebhookEventRow {
  id: string
  // The stored raw webhook body. Typed loosely on purpose — the
  // processor (processWebhook) owns the concrete shape.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  payload: any
  attempts: number
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ProcessFn = (payload: any) => Promise<void>

/**
 * Durably record an accepted webhook event. Returns the new row, or
 * null when it's a Meta redelivery we already have (unique signature
 * conflict). Throws on any other DB error so the caller can return a
 * non-200 and let Meta retry — we must not ack an event we couldn't
 * persist.
 */
export async function persistWebhookEvent(
  signature: string | null,
  payload: unknown
): Promise<WebhookEventRow | null> {
  // Set next_attempt_at from the app clock (1s in the past) rather than
  // the DB DEFAULT NOW(), so the inline claim below — which compares
  // against the app clock — always succeeds regardless of app/DB skew.
  const eligibleIso = new Date(Date.now() - 1_000).toISOString()
  const { data, error } = await supabaseAdmin()
    .from(TABLE)
    .insert({ signature, payload, status: 'pending', next_attempt_at: eligibleIso })
    .select('id, payload, attempts')
    .maybeSingle()

  if (error) {
    // 23505 = unique_violation on `signature` → redelivery already stored.
    if ((error as { code?: string }).code === '23505') return null
    throw error
  }
  return (data as WebhookEventRow) ?? null
}

function backoffIso(attempts: number): string {
  const idx = Math.min(Math.max(attempts - 1, 0), BACKOFF_MINUTES.length - 1)
  return new Date(Date.now() + BACKOFF_MINUTES[idx] * 60_000).toISOString()
}

/**
 * Atomically claim a row for processing (CAS to 'processing' with a
 * fresh lease). Returns true only for the worker that wins. The
 * `next_attempt_at <= now` guard is the CAS: it fails if another worker
 * already claimed and pushed the lease forward, or the row isn't due yet.
 */
async function claimEvent(id: string): Promise<boolean> {
  const nowIso = new Date().toISOString()
  const leaseIso = new Date(Date.now() + LEASE_MINUTES * 60_000).toISOString()
  const { data } = await supabaseAdmin()
    .from(TABLE)
    .update({ status: 'processing', next_attempt_at: leaseIso })
    .eq('id', id)
    .in('status', ['pending', 'failed', 'processing'])
    .lte('next_attempt_at', nowIso)
    .select('id')
    .maybeSingle()
  return !!data
}

/** Mark a claimed row processed, or failed/dead with backoff. */
async function settleEvent(row: WebhookEventRow, err: unknown | null): Promise<void> {
  const admin = supabaseAdmin()
  if (err === null) {
    await admin
      .from(TABLE)
      .update({ status: 'processed', processed_at: new Date().toISOString(), last_error: null })
      .eq('id', row.id)
    return
  }
  const attempts = (row.attempts ?? 0) + 1
  const dead = attempts >= MAX_ATTEMPTS
  const message = err instanceof Error ? err.message : String(err)
  await admin
    .from(TABLE)
    .update({
      status: dead ? 'dead' : 'failed',
      attempts,
      last_error: message.slice(0, 2000),
      // Dead rows keep their (now past) lease; they're excluded by the
      // drain's status filter, so they won't be re-picked.
      next_attempt_at: dead ? new Date().toISOString() : backoffIso(attempts),
    })
    .eq('id', row.id)
  console.error(
    `[webhook-outbox] event ${row.id} failed (attempt ${attempts}${dead ? ', DEAD' : ''}):`,
    message
  )
}

/**
 * Claim + process a single freshly-persisted event inline (the low-
 * latency happy path). No-op if another worker already claimed it.
 */
export async function runEventInline(row: WebhookEventRow, process: ProcessFn): Promise<void> {
  if (!(await claimEvent(row.id))) return
  try {
    await process(row.payload)
    await settleEvent(row, null)
  } catch (err) {
    await settleEvent(row, err)
  }
}

/**
 * Drain due events: claim each, process, settle. Picks up rows that
 * failed inline, never ran (crash before processing), or whose
 * processing lease expired. Returns counts for observability.
 */
export async function drainWebhookEvents(
  process: ProcessFn,
  limit = 50
): Promise<{ due: number; claimed: number; processed: number; failed: number }> {
  const admin = supabaseAdmin()
  const { data: due, error } = await admin
    .from(TABLE)
    .select('id, payload, attempts')
    .in('status', ['pending', 'failed', 'processing'])
    .lte('next_attempt_at', new Date().toISOString())
    .lt('attempts', MAX_ATTEMPTS)
    .order('next_attempt_at', { ascending: true })
    .limit(limit)

  if (error) throw error
  if (!due || due.length === 0) return { due: 0, claimed: 0, processed: 0, failed: 0 }

  let claimed = 0
  let processed = 0
  let failed = 0
  for (const raw of due) {
    const row = raw as WebhookEventRow
    if (!(await claimEvent(row.id))) continue
    claimed++
    try {
      await process(row.payload)
      await settleEvent(row, null)
      processed++
    } catch (err) {
      await settleEvent(row, err)
      failed++
    }
  }
  return { due: due.length, claimed, processed, failed }
}
