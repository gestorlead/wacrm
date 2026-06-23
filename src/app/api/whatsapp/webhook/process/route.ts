import { NextResponse } from 'next/server'
import {
  drainWebhookEvents,
  sweepStuckSendingMessages,
} from '@/lib/whatsapp/webhook-outbox'
import { processWebhook } from '@/app/api/whatsapp/webhook/route'

/**
 * Drain the WhatsApp webhook outbox — retries events that failed inline
 * processing, never ran (the container crashed before processing), or
 * whose processing lease expired. Park exhausted events as 'dead'.
 *
 * Meant to be hit on a schedule (external pinger / cron) every minute or
 * two, with the shared `x-cron-secret` header matching
 * AUTOMATION_CRON_SECRET (same secret as /api/automations/cron).
 *
 * Safe to overlap: each event is claimed (CAS to 'processing') before
 * work, and reprocessing is idempotent (UNIQUE message_id + dedup).
 */
export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  if (request.headers.get('x-cron-secret') !== expected) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const result = await drainWebhookEvents(processWebhook, 50)
    const sweptStuck = await sweepStuckSendingMessages()
    return NextResponse.json({ ...result, sweptStuck })
  } catch (err) {
    console.error('[webhook/process] drain failed:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'drain failed' },
      { status: 500 }
    )
  }
}
