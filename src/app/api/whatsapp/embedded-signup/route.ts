import { NextResponse } from 'next/server'
import crypto from 'crypto'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { encrypt } from '@/lib/whatsapp/encryption'
import {
  exchangeCodeForToken,
  fetchWabaPhoneNumbers,
  subscribeWabaToApp,
  overrideWabaCallback,
  registerPhoneNumber,
  COEXISTENCE_SUBSCRIBED_FIELDS,
} from '@/lib/whatsapp/meta-api'

/**
 * POST /api/whatsapp/embedded-signup
 *
 * Completes Meta's Embedded Signup ("Connect with Facebook") for the
 * caller's account. The frontend runs the FB.login popup and posts:
 *
 *   { code, waba_id, phone_number_id?, business_id? }
 *
 * One flow, two outcomes — the SAME steps connect both a Cloud number
 * already in the WABA and a WhatsApp Business *app* number entering
 * Coexistence; the only branch is whether /register runs (skipped when
 * the number is already VERIFIED, which is the Coexistence case).
 *
 * Steps:
 *   1. Exchange the short-lived code for a system-user access token.
 *   2. Read the WABA's phone numbers, pick the connected one.
 *   3. Guard against a number already claimed by another account.
 *   4. Subscribe the app to the WABA, then override its callback to
 *      our webhook (subscribed_fields incl. smb_message_echoes +
 *      history for Coexistence).
 *   5. Conditionally register the number (only if not VERIFIED).
 *   6. Upsert the encrypted config row as connected.
 */
export async function POST(request: Request) {
  try {
    const { supabase, userId, accountId } = await requireRole('admin')

    const siteUrl = process.env.NEXT_PUBLIC_SITE_URL?.trim()
    if (!siteUrl) {
      return NextResponse.json(
        {
          error:
            'NEXT_PUBLIC_SITE_URL is not set. It is required to build the webhook callback URL for Embedded Signup.',
        },
        { status: 500 }
      )
    }

    const body = await request.json().catch(() => ({}))
    const { code, waba_id, phone_number_id, business_id } = body as {
      code?: string
      waba_id?: string
      phone_number_id?: string
      business_id?: string
    }

    if (!code || !waba_id) {
      return NextResponse.json(
        { error: 'code and waba_id are required.' },
        { status: 400 }
      )
    }

    // 1. Exchange the single-use code for a long-lived token.
    let accessToken: string
    try {
      ;({ accessToken } = await exchangeCodeForToken({ code }))
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      return NextResponse.json(
        {
          error: `Token exchange failed: ${message}. The Facebook code is single-use — please run "Connect with Facebook" again.`,
        },
        { status: 400 }
      )
    }

    // 2. Resolve the connected phone number off the WABA.
    let phones
    try {
      phones = await fetchWabaPhoneNumbers({ wabaId: waba_id, accessToken })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error'
      return NextResponse.json(
        { error: `Failed to read WABA phone numbers: ${message}` },
        { status: 400 }
      )
    }

    if (phones.length === 0) {
      return NextResponse.json(
        {
          error:
            'Meta returned no phone numbers for this WhatsApp Business Account. Finish the number setup in WhatsApp Manager and try again.',
        },
        { status: 400 }
      )
    }

    const selected =
      phones.find((p) => p.id === phone_number_id) ?? phones[0]
    const selectedPhoneNumberId = selected.id
    const displayPhoneNumber = selected.display_phone_number
    const isVerified = selected.code_verification_status === 'VERIFIED'

    // 3. Cross-account collision guard — BEFORE any Meta side effect, so
    //    we never repoint a webhook for a number we can't own. Uses the
    //    service role because RLS hides other accounts' rows.
    const { data: claimed, error: claimedError } = await supabaseAdmin()
      .from('whatsapp_config')
      .select('account_id')
      .eq('phone_number_id', selectedPhoneNumberId)
      .neq('account_id', accountId)
      .maybeSingle()

    if (claimedError) {
      console.error('[embedded-signup] collision check failed:', claimedError)
      return NextResponse.json(
        { error: 'Failed to validate the phone number.' },
        { status: 500 }
      )
    }
    if (claimed) {
      return NextResponse.json(
        {
          error:
            'This WhatsApp phone number is already linked to another account on this instance. Each number can connect to only one wacrm account.',
        },
        { status: 409 }
      )
    }

    // 4. Persist the row BEFORE subscribing the webhook. Meta verifies
    //    the callback SYNCHRONOUSLY during overrideWabaCallback — it GETs
    //    our webhook with hub.verify_token, and our GET handler matches it
    //    against saved rows. So the verify_token must already be in the DB
    //    or verification returns 403. Status starts 'disconnected' and is
    //    flipped to 'connected' only after Meta confirms.
    const verifyToken = crypto.randomBytes(24).toString('hex')
    const callbackUrl = `${siteUrl.replace(/\/$/, '')}/api/whatsapp/webhook`

    let encryptedAccessToken: string
    let encryptedVerifyToken: string
    try {
      encryptedAccessToken = encrypt(accessToken)
      encryptedVerifyToken = encrypt(verifyToken)
    } catch (err) {
      console.error('[embedded-signup] encryption failed:', err)
      return NextResponse.json(
        {
          error:
            'Failed to encrypt the access token. Check that ENCRYPTION_KEY is a valid 64-character hex string.',
        },
        { status: 500 }
      )
    }

    // Idempotent upsert (UNIQUE(account_id) → ≤1 row per account). Used
    // for the initial write and the later status/timestamp patches.
    const upsertConfig = async (patch: Record<string, unknown>) => {
      const { data: existing } = await supabase
        .from('whatsapp_config')
        .select('id')
        .eq('account_id', accountId)
        .maybeSingle()
      if (existing) {
        return supabase
          .from('whatsapp_config')
          .update({ ...patch, updated_at: new Date().toISOString() })
          .eq('account_id', accountId)
      }
      return supabase
        .from('whatsapp_config')
        .insert({ account_id: accountId, user_id: userId, ...patch })
    }

    const { error: preSaveError } = await upsertConfig({
      phone_number_id: selectedPhoneNumberId,
      waba_id,
      access_token: encryptedAccessToken,
      verify_token: encryptedVerifyToken,
      status: 'disconnected',
      connection_type: 'embedded_signup',
      is_coexistence: true,
      meta_business_id: business_id ?? null,
      connected_at: null,
      registered_at: null,
      subscribed_apps_at: null,
      last_registration_error: null,
    })
    if (preSaveError) {
      console.error('[embedded-signup] pre-save failed:', preSaveError)
      return NextResponse.json(
        { error: 'Failed to save the connection.' },
        { status: 500 }
      )
    }

    // 5. Webhook subscription — TWO STEPS, order matters. The override
    //    (5b) is rejected unless the app is already subscribed (5a); Meta
    //    verifies our callback synchronously here against the verify_token
    //    persisted above.
    const subscribe = async () => {
      await subscribeWabaToApp({ wabaId: waba_id, accessToken })
      await overrideWabaCallback({
        wabaId: waba_id,
        accessToken,
        callbackUrl,
        verifyToken,
        subscribedFields: COEXISTENCE_SUBSCRIBED_FIELDS,
      })
    }
    try {
      await subscribe()
    } catch {
      // One retry: a transient ordering hiccup (override before the
      // subscription propagated) is the common cause.
      try {
        await subscribe()
      } catch (retryErr) {
        const message =
          retryErr instanceof Error ? retryErr.message : 'Unknown error'
        console.error('[embedded-signup] webhook subscription failed:', message)
        // Leave the row 'disconnected' with the reason — a number with no
        // working callback must never read as connected. The user can retry.
        await upsertConfig({
          status: 'disconnected',
          last_registration_error: `Webhook subscription failed: ${message}`,
        })
        return NextResponse.json(
          { error: `Could not subscribe the webhook on Meta: ${message}` },
          { status: 502 }
        )
      }
    }
    const subscribedAppsAt = new Date().toISOString()

    // 6. Conditional registration. Coexistence numbers come VERIFIED and
    //    skip /register. A non-verified number has no user-supplied PIN
    //    here, so registration is best-effort and any failure is surfaced
    //    via last_registration_error for the manual flow to finish.
    let registeredAt: string | null = null
    let registrationError: string | null = null
    if (isVerified) {
      registeredAt = new Date().toISOString()
    } else {
      try {
        await registerPhoneNumber({
          phoneNumberId: selectedPhoneNumberId,
          accessToken,
          pin: '000000',
        })
        registeredAt = new Date().toISOString()
      } catch (err) {
        registrationError =
          err instanceof Error ? err.message : 'Unknown registration error'
        console.warn(
          '[embedded-signup] /register failed (non-fatal):',
          registrationError
        )
      }
    }

    // 7. Finalize — mark connected and stamp timestamps.
    const { error: finalizeError } = await upsertConfig({
      status: 'connected',
      connected_at: new Date().toISOString(),
      registered_at: registeredAt,
      subscribed_apps_at: subscribedAppsAt,
      last_registration_error: registrationError,
    })
    if (finalizeError) {
      console.error('[embedded-signup] finalize failed:', finalizeError)
      return NextResponse.json(
        { error: 'Connected on Meta but failed to finalize the saved row.' },
        { status: 500 }
      )
    }

    return NextResponse.json({
      success: true,
      phone_number_id: selectedPhoneNumberId,
      display_phone_number: displayPhoneNumber,
      waba_id,
      connection_type: 'embedded_signup',
      registered: registeredAt != null,
    })
  } catch (error) {
    return toErrorResponse(error)
  }
}
