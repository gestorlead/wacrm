import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { createClient as createAdminClient } from '@supabase/supabase-js'
import {
  registerPhoneNumber,
  subscribeWabaToApp,
  verifyPhoneNumber,
} from '@/lib/whatsapp/meta-api'
import { encrypt, decrypt } from '@/lib/whatsapp/encryption'

/**
 * Resolve the caller's account_id from their profile. Inlined here
 * (rather than going through `@/lib/auth/account.getCurrentAccount`)
 * because the GET handler wants to return shaped 200s for every
 * non-auth failure mode, not throw — keeping the helper minimal lets
 * the existing response branches stay as-is.
 *
 * Returns null if the user has no profile or no account; callers
 * should treat that the same as "not connected".
 */
async function resolveAccountId(
  supabase: Awaited<ReturnType<typeof createClient>>,
  userId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('profiles')
    .select('account_id')
    .eq('user_id', userId)
    .maybeSingle()
  if (error || !data?.account_id) return null
  return data.account_id as string
}

// Lazy-initialised service-role client. We need it to detect a
// phone_number_id already claimed by a *different* user — under RLS,
// the user's own session can't see other users' rows, so the conflict
// would be invisible without the service role.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createAdminClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!
    )
  }
  return _adminClient
}

/**
 * GET /api/whatsapp/config
 *
 * Used by the "Test API Connection" button and by the page to check
 * whether the saved config is healthy. Returns 200 in all non-auth cases
 * so the UI can render an appropriate message rather than show a 500.
 *
 * Response shape:
 *   { connected: true,  phone_info: {...} }
 *   { connected: false, reason: 'no_config',        message: '...' }
 *   { connected: false, reason: 'token_corrupted',  message: '...', needs_reset: true }
 *   { connected: false, reason: 'meta_api_error',   message: '...' }
 */
export async function GET(request: Request) {
  try {
    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const accountId = await resolveAccountId(supabase, user.id)
    if (!accountId) {
      return NextResponse.json(
        {
          connected: false,
          reason: 'no_account',
          message: 'Your profile is not linked to an account.',
        },
        { status: 200 },
      )
    }

    // Multi-inbox: target a specific inbox via `?inbox_id`, else the
    // account's primary (earliest) number for backward compatibility.
    const inboxId = new URL(request.url).searchParams.get('inbox_id')
    const baseQuery = supabase
      .from('whatsapp_config')
      .select('phone_number_id, waba_id, access_token, status, connection_type, registered_at')
    const { data: configRows, error: configError } = inboxId
      ? await baseQuery.eq('inbox_id', inboxId).limit(1)
      : await baseQuery.eq('account_id', accountId).order('created_at', { ascending: true }).limit(1)
    const config = configRows?.[0]

    if (configError) {
      console.error('Error fetching whatsapp_config:', configError)
      return NextResponse.json(
        { connected: false, reason: 'db_error', message: 'Failed to fetch configuration' },
        { status: 200 }
      )
    }

    if (!config) {
      return NextResponse.json(
        {
          connected: false,
          reason: 'no_config',
          message: 'No WhatsApp configuration saved yet. Fill in the form and click Save Configuration.',
        },
        { status: 200 }
      )
    }

    // Try to decrypt the stored token with the current ENCRYPTION_KEY.
    // If this fails, the key changed (or was never consistent across envs).
    let accessToken: string
    try {
      accessToken = decrypt(config.access_token)
    } catch (err) {
      console.error('[whatsapp/config GET] Token decryption failed:', err)
      return NextResponse.json(
        {
          connected: false,
          reason: 'token_corrupted',
          needs_reset: true,
          message:
            'The stored access token cannot be decrypted with the current ENCRYPTION_KEY. This usually means the key changed, or it differs between environments (local vs Hostinger vs Vercel). Click "Reset Configuration" below, then re-save.',
        },
        { status: 200 }
      )
    }

    // Validate credentials against Meta
    try {
      const phoneInfo = await verifyPhoneNumber({
        phoneNumberId: config.phone_number_id,
        accessToken,
      })
      return NextResponse.json({
        connected: true,
        phone_info: phoneInfo,
        phone_number_id: config.phone_number_id,
        waba_id: config.waba_id,
        connection_type: config.connection_type,
        registered: !!config.registered_at,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown Meta API error'
      console.error('[whatsapp/config GET] Meta API verification failed:', message)
      return NextResponse.json(
        {
          connected: false,
          reason: 'meta_api_error',
          message: `Meta API rejected the credentials: ${message}`,
        },
        { status: 200 }
      )
    }
  } catch (error) {
    console.error('Error in WhatsApp config GET:', error)
    return NextResponse.json(
      { connected: false, reason: 'unknown', message: 'Internal server error' },
      { status: 500 }
    )
  }
}

/**
 * POST /api/whatsapp/config
 *
 * Saves or updates the WhatsApp config for the authenticated user.
 * Verifies credentials with Meta first, then encrypts and stores.
 */
export async function POST(request: Request) {
  try {
    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const accountId = await resolveAccountId(supabase, user.id)
    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 },
      )
    }

    const body = await request.json()
    const { phone_number_id, waba_id, access_token, verify_token, pin, inbox_id } = body

    if (!access_token || !phone_number_id) {
      return NextResponse.json(
        { error: 'access_token and phone_number_id are required' },
        { status: 400 }
      )
    }

    if (pin !== undefined && pin !== null && pin !== '') {
      if (typeof pin !== 'string' || !/^\d{6}$/.test(pin)) {
        return NextResponse.json(
          { error: 'PIN must be exactly 6 digits.' },
          { status: 400 }
        )
      }
    }

    // Reject if another account has already claimed this phone_number_id.
    // wacrm is single-tenant-per-WhatsApp-number — letting two accounts
    // bind the same number causes the webhook's `.single()` lookup to
    // throw PGRST116 ("multiple rows"), silently dropping every
    // inbound message. See issue #136. Post-multi-user we key on
    // account_id (not user_id) since teammates inside the same account
    // all share one config; the conflict is between accounts.
    const { data: claimed, error: claimedError } = await supabaseAdmin()
      .from('whatsapp_config')
      .select('account_id')
      .eq('phone_number_id', phone_number_id)
      .neq('account_id', accountId)
      .maybeSingle()

    if (claimedError) {
      console.error('Error checking phone_number_id ownership:', claimedError)
      return NextResponse.json(
        { error: 'Failed to validate configuration' },
        { status: 500 }
      )
    }

    if (claimed) {
      return NextResponse.json(
        {
          error:
            'This WhatsApp phone number is already linked to another account on this instance. Each phone number can only be connected to one wacrm user.',
        },
        { status: 409 }
      )
    }

    // Verify credentials with Meta BEFORE saving
    let phoneInfo
    try {
      phoneInfo = await verifyPhoneNumber({
        phoneNumberId: phone_number_id,
        accessToken: access_token,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown Meta API error'
      console.error('Meta API verification failed during save:', message)
      return NextResponse.json(
        { error: `Meta API error: ${message}` },
        { status: 400 }
      )
    }

    // Encrypt sensitive tokens before storing
    let encryptedAccessToken: string
    let encryptedVerifyToken: string | null
    try {
      encryptedAccessToken = encrypt(access_token)
      encryptedVerifyToken = verify_token ? encrypt(verify_token) : null
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown encryption error'
      console.error('Encryption failed:', message)
      return NextResponse.json(
        {
          error:
            'Failed to encrypt token. Check that ENCRYPTION_KEY is a valid 64-character hex string in your environment variables.',
        },
        { status: 500 }
      )
    }

    // Look up any pre-existing row so we know whether this number is
    // already registered with Meta — if so we can skip /register when the
    // user didn't provide a PIN this time around. Multi-inbox: scope by
    // `inbox_id` when provided, else the account's primary (single) number.
    const existingQuery = supabase
      .from('whatsapp_config')
      .select('id, inbox_id, registered_at, phone_number_id')
    const { data: existingRows } = inbox_id
      ? await existingQuery.eq('inbox_id', inbox_id).limit(1)
      : await existingQuery.eq('account_id', accountId).order('created_at', { ascending: true }).limit(1)
    const existing = existingRows?.[0] ?? null

    const sameNumber =
      existing?.phone_number_id === phone_number_id &&
      existing?.registered_at != null

    // Step 1: register the phone number for inbound webhooks.
    //
    // Attempted on first save AND whenever the user supplies a fresh
    // PIN (e.g. they rotated the 2FA PIN in Meta Manager). Skipped
    // when the same number is already registered and no PIN was
    // supplied — re-registering an already-active number with a
    // stale PIN would actually fail and undo the active subscription.
    let registeredAt: string | null = existing?.registered_at ?? null
    let registrationError: string | null = null
    // True when registration was deliberately skipped because no PIN
    // was supplied (see below). Distinct from registrationError — this
    // is not a failure, just an incomplete-but-valid save.
    let registrationSkipped = false

    const needsRegistration = !sameNumber || (typeof pin === 'string' && pin.length > 0)
    if (needsRegistration) {
      if (!pin) {
        // No PIN provided. Meta TEST numbers (Developer Console) are
        // pre-registered by Meta and expose no two-step verification
        // PIN to set, so requiring one made them impossible to connect
        // (issue #242). The /register + PIN step only matters for
        // production numbers under a shared WABA (issue #136), so treat
        // it as best-effort: skip it, save the (already Meta-verified)
        // credentials as connected, and leave registered_at null. The
        // UI surfaces a separate "Not registered" banner with a path to
        // add a PIN later for users who do need inbound webhook routing.
        registrationSkipped = true
      } else {
        try {
          await registerPhoneNumber({
            phoneNumberId: phone_number_id,
            accessToken: access_token,
            pin,
          })
          registeredAt = new Date().toISOString()
        } catch (err) {
          registrationError =
            err instanceof Error ? err.message : 'Unknown Meta API error'
          console.error('Phone number /register failed:', registrationError)
          // We deliberately fall through and still save the row so the
          // user can retry without re-entering everything. The UI
          // surfaces `last_registration_error` so they see WHY it's
          // not actually live yet.
        }
      }
    }

    // Step 2: subscribe the WABA to this app. Idempotent on Meta's
    // side, so we call on every save and persist the timestamp.
    // Skipped only when there's no waba_id (legacy rows from before
    // we required it).
    let subscribedAppsAt: string | null = null
    if (waba_id) {
      try {
        await subscribeWabaToApp({
          wabaId: waba_id,
          accessToken: access_token,
        })
        subscribedAppsAt = new Date().toISOString()
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        console.warn('WABA subscribed_apps failed (non-fatal):', message)
        // Subscription failures are rare once the App has the right
        // permissions; we don't block save on them — the diagnostic
        // endpoint surfaces this state too.
      }
    }

    // Persist everything in one shot. If /register failed we still
    // store the credentials and the error so the UI can guide the
    // user through a retry.
    const baseRow = {
      phone_number_id,
      waba_id: waba_id || null,
      access_token: encryptedAccessToken,
      verify_token: encryptedVerifyToken,
      status: registrationError ? 'disconnected' : 'connected',
      connected_at: registrationError ? null : new Date().toISOString(),
      registered_at: registrationError ? null : registeredAt,
      subscribed_apps_at: subscribedAppsAt ?? null,
      last_registration_error: registrationError,
      updated_at: new Date().toISOString(),
    }

    if (existing) {
      // Update the precise row (by id) rather than by account_id — an
      // account can now have several configs.
      const { error: updateError } = await supabase
        .from('whatsapp_config')
        .update(baseRow)
        .eq('id', existing.id)

      if (updateError) {
        console.error('Error updating whatsapp_config:', updateError)
        return NextResponse.json(
          { error: 'Failed to update configuration' },
          { status: 500 }
        )
      }
    } else {
      // No config yet for the target. Resolve the inbox to attach to:
      // the explicit `inbox_id`, or create one (legacy first-connect, when
      // the account had no inbox). The config's inbox_id is NOT NULL.
      let targetInboxId: string | null = inbox_id ?? null
      if (!targetInboxId) {
        const { data: inbox, error: inboxErr } = await supabase
          .from('inboxes')
          .insert({
            account_id: accountId,
            name: 'WhatsApp' + (phoneInfo?.display_phone_number ? ` ${phoneInfo.display_phone_number}` : ''),
            channel_type: 'whatsapp',
          })
          .select('id')
          .single()
        if (inboxErr || !inbox) {
          console.error('Error creating inbox for config:', inboxErr)
          return NextResponse.json({ error: 'Failed to create inbox' }, { status: 500 })
        }
        targetInboxId = inbox.id
        await supabase.from('inbox_members').insert({ inbox_id: targetInboxId, user_id: user.id })
      }

      const { error: insertError } = await supabase
        .from('whatsapp_config')
        .insert({
          account_id: accountId,
          user_id: user.id,
          inbox_id: targetInboxId,
          ...baseRow,
        })

      if (insertError) {
        console.error('Error inserting whatsapp_config:', insertError)
        return NextResponse.json(
          { error: 'Failed to save configuration' },
          { status: 500 }
        )
      }
    }

    if (registrationError) {
      // Save succeeded but the number isn't actually live. Return
      // 200 with a structured error so the UI can show the specific
      // remediation step instead of a generic toast.
      return NextResponse.json({
        success: false,
        saved: true,
        registered: false,
        registration_error: registrationError,
        phone_info: phoneInfo,
      })
    }

    return NextResponse.json({
      success: true,
      saved: true,
      registered: registeredAt != null,
      // Credentials are valid and saved, but inbound webhook
      // registration was skipped because no PIN was supplied (e.g. a
      // Meta test number). The UI shows the "Not registered" banner
      // rather than claiming the number is fully live.
      registration_skipped: registrationSkipped,
      phone_info: phoneInfo,
    })
  } catch (error) {
    console.error('Error in WhatsApp config POST:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}

/**
 * DELETE /api/whatsapp/config
 *
 * Removes the authenticated user's WhatsApp configuration row.
 * Used by the "Reset Configuration" button to recover from a corrupted
 * encrypted token (mismatched ENCRYPTION_KEY across environments).
 */
export async function DELETE(request: Request) {
  try {
    const supabase = await createClient()

    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()

    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const accountId = await resolveAccountId(supabase, user.id)
    if (!accountId) {
      return NextResponse.json(
        { error: 'Your profile is not linked to an account.' },
        { status: 403 },
      )
    }

    // Multi-inbox: reset a specific inbox's config via `?inbox_id`, else
    // the account's primary number (legacy single-inbox behaviour).
    const inboxId = new URL(request.url).searchParams.get('inbox_id')
    const delQuery = supabase.from('whatsapp_config').delete()
    const { error: deleteError } = inboxId
      ? await delQuery.eq('inbox_id', inboxId)
      : await delQuery.eq('account_id', accountId)

    if (deleteError) {
      console.error('Error deleting whatsapp_config:', deleteError)
      return NextResponse.json(
        { error: 'Failed to delete configuration' },
        { status: 500 }
      )
    }

    return NextResponse.json({ success: true })
  } catch (error) {
    console.error('Error in WhatsApp config DELETE:', error)
    return NextResponse.json({ error: 'Internal server error' }, { status: 500 })
  }
}
