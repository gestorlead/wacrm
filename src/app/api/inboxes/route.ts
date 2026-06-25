// ============================================================
// /api/inboxes
//
// GET  — list the inboxes the caller can access (channel type, name,
//        connection status, member count).
// POST — create a new inbox + its channel config (admin+). WhatsApp is
//        the only implemented channel; the body's `channel_type` is
//        validated against the implemented set so the UI can offer
//        "coming soon" channels without the API accepting them yet.
// ============================================================

import { NextResponse } from 'next/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'

import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'
import {
  registerPhoneNumber,
  subscribeWabaToApp,
  verifyPhoneNumber,
} from '@/lib/whatsapp/meta-api'
import { encrypt } from '@/lib/whatsapp/encryption'
import type { ChannelType } from '@/lib/channels/config-resolver'

/** Channels the API will actually create today. */
const IMPLEMENTED_CHANNELS: readonly ChannelType[] = ['whatsapp']

// Service-role client — needed to detect a phone_number_id already
// claimed by a DIFFERENT account (RLS hides other accounts' rows).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createAdminClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )
  }
  return _adminClient
}

export async function GET() {
  try {
    const ctx = await getCurrentAccount()

    // RLS (inboxes_select = can_access_inbox) already narrows this to the
    // inboxes the caller may see; the account_id filter is belt-and-braces.
    const { data: inboxes, error } = await ctx.supabase
      .from('inboxes')
      .select('id, account_id, name, channel_type, color, created_at')
      .eq('account_id', ctx.accountId)
      .order('created_at', { ascending: true })

    if (error) {
      console.error('[GET /api/inboxes] fetch error:', error)
      return NextResponse.json({ error: 'Failed to load inboxes' }, { status: 500 })
    }

    const ids = (inboxes ?? []).map((i: { id: string }) => i.id)

    const idFilter = ids.length ? ids : ['00000000-0000-0000-0000-000000000000']

    // Connection status per inbox (per-channel config tables) + member counts.
    const [{ data: waConfigs }, { data: igConfigs }, { data: members }] = await Promise.all([
      ctx.supabase
        .from('whatsapp_config')
        .select('inbox_id, status, registered_at, phone_number_id')
        .in('inbox_id', idFilter),
      ctx.supabase
        .from('instagram_config')
        .select('inbox_id, status, instagram_id, username')
        .in('inbox_id', idFilter),
      ctx.supabase
        .from('inbox_members')
        .select('inbox_id, user_id')
        .in('inbox_id', idFilter),
    ])

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const configByInbox = new Map<string, any>()
    for (const c of waConfigs ?? []) configByInbox.set(c.inbox_id, { ...c, _channel: 'whatsapp' })
    for (const c of igConfigs ?? []) configByInbox.set(c.inbox_id, { ...c, _channel: 'instagram' })
    const memberCount = new Map<string, number>()
    for (const m of members ?? []) memberCount.set(m.inbox_id, (memberCount.get(m.inbox_id) ?? 0) + 1)

    const result = (inboxes ?? []).map((i: { id: string; name: string; channel_type: string; color: string | null; created_at: string }) => {
      const cfg = configByInbox.get(i.id)
      return {
        id: i.id,
        name: i.name,
        channel_type: i.channel_type,
        color: i.color,
        created_at: i.created_at,
        connection: {
          configured: !!cfg,
          status: cfg?.status ?? 'disconnected',
          // WhatsApp: registered for webhooks. Instagram: connected == registered
          // (subscription happens on connect), so mirror `status`.
          registered: cfg?._channel === 'instagram' ? cfg?.status === 'connected' : !!cfg?.registered_at,
          phone_number_id: cfg?.phone_number_id ?? null,
          instagram_id: cfg?.instagram_id ?? null,
          username: cfg?.username ?? null,
        },
        member_count: memberCount.get(i.id) ?? 0,
      }
    })

    return NextResponse.json({ inboxes: result })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireRole('admin')

    const body = await request.json()
    const channelType = (body.channel_type ?? 'whatsapp') as ChannelType

    if (!IMPLEMENTED_CHANNELS.includes(channelType)) {
      return NextResponse.json(
        { error: `Channel type '${channelType}' is not available yet.` },
        { status: 400 },
      )
    }

    // ---- WhatsApp ----
    const { name, phone_number_id, waba_id, access_token, verify_token, pin } = body

    if (!access_token || !phone_number_id) {
      return NextResponse.json(
        { error: 'access_token and phone_number_id are required' },
        { status: 400 },
      )
    }
    if (pin !== undefined && pin !== null && pin !== '') {
      if (typeof pin !== 'string' || !/^\d{6}$/.test(pin)) {
        return NextResponse.json({ error: 'PIN must be exactly 6 digits.' }, { status: 400 })
      }
    }

    // Cross-account collision: a phone_number_id maps to exactly one inbox.
    const { data: claimed, error: claimedErr } = await supabaseAdmin()
      .from('whatsapp_config')
      .select('account_id')
      .eq('phone_number_id', phone_number_id)
      .neq('account_id', ctx.accountId)
      .maybeSingle()
    if (claimedErr) {
      console.error('[POST /api/inboxes] claim check failed:', claimedErr)
      return NextResponse.json({ error: 'Failed to validate configuration' }, { status: 500 })
    }
    if (claimed) {
      return NextResponse.json(
        { error: 'This WhatsApp phone number is already linked to another account.' },
        { status: 409 },
      )
    }

    // Also block a second inbox binding the same number within this account.
    const { data: sameAccount } = await ctx.supabase
      .from('whatsapp_config')
      .select('id')
      .eq('account_id', ctx.accountId)
      .eq('phone_number_id', phone_number_id)
      .maybeSingle()
    if (sameAccount) {
      return NextResponse.json(
        { error: 'This number is already connected to one of your inboxes.' },
        { status: 409 },
      )
    }

    // Verify credentials with Meta before persisting anything.
    let phoneInfo
    try {
      phoneInfo = await verifyPhoneNumber({ phoneNumberId: phone_number_id, accessToken: access_token })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown Meta API error'
      return NextResponse.json({ error: `Meta API error: ${message}` }, { status: 400 })
    }

    let encryptedAccessToken: string
    let encryptedVerifyToken: string | null
    try {
      encryptedAccessToken = encrypt(access_token)
      encryptedVerifyToken = verify_token ? encrypt(verify_token) : null
    } catch {
      return NextResponse.json(
        { error: 'Failed to encrypt token. Check ENCRYPTION_KEY.' },
        { status: 500 },
      )
    }

    // Register for inbound webhooks when a PIN is provided (production
    // numbers under a shared WABA). Test numbers have no PIN — skip.
    let registeredAt: string | null = null
    let registrationError: string | null = null
    if (pin) {
      try {
        await registerPhoneNumber({ phoneNumberId: phone_number_id, accessToken: access_token, pin })
        registeredAt = new Date().toISOString()
      } catch (err) {
        registrationError = err instanceof Error ? err.message : 'Unknown Meta API error'
      }
    }

    let subscribedAppsAt: string | null = null
    if (waba_id) {
      try {
        await subscribeWabaToApp({ wabaId: waba_id, accessToken: access_token })
        subscribedAppsAt = new Date().toISOString()
      } catch (err) {
        console.warn('[POST /api/inboxes] subscribe failed (non-fatal):', err)
      }
    }

    // Create the inbox, then its config, then add the creator as a member.
    const inboxName =
      (typeof name === 'string' && name.trim()) ||
      'WhatsApp' + (phoneInfo?.display_phone_number ? ` ${phoneInfo.display_phone_number}` : '')

    const { data: inbox, error: inboxErr } = await ctx.supabase
      .from('inboxes')
      .insert({ account_id: ctx.accountId, name: inboxName, channel_type: 'whatsapp' })
      .select('id, name, channel_type, color, created_at')
      .single()
    if (inboxErr || !inbox) {
      console.error('[POST /api/inboxes] inbox insert failed:', inboxErr)
      return NextResponse.json({ error: 'Failed to create inbox' }, { status: 500 })
    }

    const { error: cfgErr } = await ctx.supabase.from('whatsapp_config').insert({
      account_id: ctx.accountId,
      user_id: ctx.userId,
      inbox_id: inbox.id,
      phone_number_id,
      waba_id: waba_id || null,
      access_token: encryptedAccessToken,
      verify_token: encryptedVerifyToken,
      status: registrationError ? 'disconnected' : 'connected',
      connected_at: registrationError ? null : new Date().toISOString(),
      registered_at: registrationError ? null : registeredAt,
      subscribed_apps_at: subscribedAppsAt,
      last_registration_error: registrationError,
    })
    if (cfgErr) {
      // Roll back the orphan inbox so a retry is clean.
      await ctx.supabase.from('inboxes').delete().eq('id', inbox.id)
      console.error('[POST /api/inboxes] config insert failed:', cfgErr)
      return NextResponse.json({ error: 'Failed to save WhatsApp configuration' }, { status: 500 })
    }

    await ctx.supabase.from('inbox_members').insert({ inbox_id: inbox.id, user_id: ctx.userId })

    return NextResponse.json({
      success: !registrationError,
      inbox,
      registered: registeredAt != null,
      registration_error: registrationError,
      phone_info: phoneInfo,
    })
  } catch (err) {
    return toErrorResponse(err)
  }
}
