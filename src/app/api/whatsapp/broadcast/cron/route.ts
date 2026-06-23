import { NextResponse } from 'next/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { decrypt } from '@/lib/whatsapp/encryption'
import { sendTemplateMessage } from '@/lib/whatsapp/meta-api'
import { isMessageTemplate } from '@/lib/whatsapp/template-row-guard'
import {
  sanitizePhoneForMeta,
  isValidE164,
  phoneVariants,
  isRecipientNotAllowedError,
} from '@/lib/whatsapp/phone-utils'

/**
 * Send due SCHEDULED broadcasts. Hit on a schedule with the shared
 * `x-cron-secret` header (same as the other cron endpoints).
 *
 * Design (safe for a SaaS sending real customer messages):
 *  - A lease lock (cron_locks 'broadcasts') serializes runs so two
 *    overlapping invocations never double-send the same recipients.
 *  - Scheduled broadcasts were SNAPSHOTTED at schedule time
 *    (broadcast_recipients rows with `params`), so this runner needs no
 *    browser logic — it just sends to 'pending' recipients.
 *  - Work is BOUNDED per run (MAX_SENDS_PER_RUN) and RESUMABLE: a
 *    broadcast stays 'sending' with its remaining 'pending' recipients
 *    and the next run continues. Already-'sent' recipients are skipped,
 *    so a crash never re-sends them.
 */
const MAX_SENDS_PER_RUN = 100
const SEND_CONCURRENCY = 10
const LEASE_MINUTES = 3

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Admin = any

export async function GET(request: Request) {
  const expected = process.env.AUTOMATION_CRON_SECRET
  if (!expected) {
    return NextResponse.json({ error: 'cron not configured' }, { status: 503 })
  }
  if (request.headers.get('x-cron-secret') !== expected) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }

  const admin = supabaseAdmin()

  // Acquire the lease lock — CAS the 'broadcasts' row only if its lease
  // has expired. If another run holds it, exit cleanly.
  const nowIso = new Date().toISOString()
  const leaseIso = new Date(Date.now() + LEASE_MINUTES * 60_000).toISOString()
  const { data: lock } = await admin
    .from('cron_locks')
    .update({ locked_until: leaseIso })
    .eq('name', 'broadcasts')
    .lt('locked_until', nowIso)
    .select('name')
    .maybeSingle()
  if (!lock) {
    return NextResponse.json({ skipped: 'locked' })
  }

  try {
    // 1. Start broadcasts whose scheduled time has arrived (→ 'sending').
    const { data: due } = await admin
      .from('broadcasts')
      .select('id')
      .eq('status', 'scheduled')
      .lte('scheduled_at', nowIso)
      .order('scheduled_at', { ascending: true })
      .limit(20)
    for (const b of due ?? []) {
      await admin
        .from('broadcasts')
        .update({ status: 'sending' })
        .eq('id', b.id)
        .eq('status', 'scheduled')
    }

    // 2. Drain scheduled-origin broadcasts in 'sending' (the just-started
    //    ones plus any resuming after a crash). scheduled_at IS NOT NULL
    //    excludes immediate browser sends.
    const { data: active } = await admin
      .from('broadcasts')
      .select('*')
      .eq('status', 'sending')
      .not('scheduled_at', 'is', null)
      .order('scheduled_at', { ascending: true })
      .limit(10)

    let budget = MAX_SENDS_PER_RUN
    let processed = 0
    for (const b of active ?? []) {
      if (budget <= 0) break
      const n = await drainBroadcast(admin, b, budget)
      budget -= n
      processed += n
    }

    return NextResponse.json({ started: due?.length ?? 0, processed })
  } catch (err) {
    console.error('[broadcast/cron] run failed:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'run failed' },
      { status: 500 }
    )
  } finally {
    // Release the lease so the next minute's run can proceed immediately.
    await admin
      .from('cron_locks')
      .update({ locked_until: new Date().toISOString() })
      .eq('name', 'broadcasts')
  }
}

/** Send up to `budget` of a broadcast's pending recipients. Returns the
 *  number attempted. Finalizes the broadcast when no pending remain. */
async function drainBroadcast(
  admin: Admin,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  broadcast: any,
  budget: number
): Promise<number> {
  const { data: config } = await admin
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', broadcast.account_id)
    .maybeSingle()
  if (!config) {
    await admin.from('broadcasts').update({ status: 'failed' }).eq('id', broadcast.id)
    return 0
  }

  let accessToken: string
  try {
    accessToken = decrypt(config.access_token)
  } catch {
    await admin.from('broadcasts').update({ status: 'failed' }).eq('id', broadcast.id)
    return 0
  }

  const { data: rawTemplate } = await admin
    .from('message_templates')
    .select('*')
    .eq('account_id', broadcast.account_id)
    .eq('name', broadcast.template_name)
    .eq('language', broadcast.template_language)
    .maybeSingle()
  const template =
    rawTemplate && isMessageTemplate(rawTemplate) ? rawTemplate : undefined

  const { data: pending } = await admin
    .from('broadcast_recipients')
    .select('id, params, contact:contacts(phone)')
    .eq('broadcast_id', broadcast.id)
    .eq('status', 'pending')
    .limit(budget)

  if (!pending || pending.length === 0) {
    await finalizeBroadcast(admin, broadcast.id)
    return 0
  }

  for (let i = 0; i < pending.length; i += SEND_CONCURRENCY) {
    const chunk = pending.slice(i, i + SEND_CONCURRENCY)
    await Promise.all(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      chunk.map((r: any) =>
        sendRecipient(admin, config, accessToken, template, broadcast, r)
      )
    )
  }

  const { count: remaining } = await admin
    .from('broadcast_recipients')
    .select('id', { count: 'exact', head: true })
    .eq('broadcast_id', broadcast.id)
    .eq('status', 'pending')
  if ((remaining ?? 0) === 0) {
    await finalizeBroadcast(admin, broadcast.id)
  }

  return pending.length
}

async function sendRecipient(
  admin: Admin,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  config: any,
  accessToken: string,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  template: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  broadcast: any,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  recipient: any
): Promise<void> {
  // many-to-one embed is an object, but normalize defensively.
  const contact = Array.isArray(recipient.contact)
    ? recipient.contact[0]
    : recipient.contact
  const phone = contact?.phone as string | undefined

  if (!phone) {
    await admin
      .from('broadcast_recipients')
      .update({ status: 'failed', error_message: 'No phone number on contact' })
      .eq('id', recipient.id)
    return
  }

  const sanitized = sanitizePhoneForMeta(phone)
  if (!isValidE164(sanitized)) {
    await admin
      .from('broadcast_recipients')
      .update({ status: 'failed', error_message: 'Invalid phone number format' })
      .eq('id', recipient.id)
    return
  }

  const params = Array.isArray(recipient.params) ? recipient.params : []
  let messageId: string | null = null
  let lastError: string | null = null

  for (const variant of phoneVariants(sanitized)) {
    try {
      const res = await sendTemplateMessage({
        phoneNumberId: config.phone_number_id,
        accessToken,
        to: variant,
        templateName: broadcast.template_name,
        language: broadcast.template_language,
        template: template ?? undefined,
        params,
      })
      messageId = res.messageId
      lastError = null
      break
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err)
      // Only the "recipient not in allowed list" error is worth retrying
      // with a different phone format; anything else is terminal.
      if (!isRecipientNotAllowedError(lastError)) break
    }
  }

  if (messageId) {
    await admin
      .from('broadcast_recipients')
      .update({
        status: 'sent',
        sent_at: new Date().toISOString(),
        whatsapp_message_id: messageId,
        error_message: null,
      })
      .eq('id', recipient.id)
  } else {
    await admin
      .from('broadcast_recipients')
      .update({ status: 'failed', error_message: lastError ?? 'Unknown error' })
      .eq('id', recipient.id)
  }
}

/** Flip a fully-drained broadcast to 'sent' (any sent) or 'failed'. The
 *  per-recipient counts are maintained by the aggregate trigger. */
async function finalizeBroadcast(admin: Admin, broadcastId: string): Promise<void> {
  const { data: b } = await admin
    .from('broadcasts')
    .select('sent_count')
    .eq('id', broadcastId)
    .maybeSingle()
  const finalStatus = (b?.sent_count ?? 0) > 0 ? 'sent' : 'failed'
  await admin
    .from('broadcasts')
    .update({ status: finalStatus })
    .eq('id', broadcastId)
}
