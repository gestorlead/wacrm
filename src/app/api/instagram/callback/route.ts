// ============================================================
// GET /api/instagram/callback
//
// Completes the Instagram Login OAuth flow. Meta redirects the browser
// here with `code` + `state`. We:
//   1. Verify the signed state (CSRF + freshness) -> account/user.
//   2. Exchange code -> short token -> long-lived (~60d) token.
//   3. Fetch the connected account profile (/me).
//   4. Guard against the instagram_id already claimed by another account.
//   5. Create the inbox + instagram_config + inbox_members (service role).
//   6. Subscribe the app to webhook fields.
//   7. Redirect back to Settings -> Inboxes with a status param.
//
// Writes use the service-role client: the cross-account collision check
// needs to see other accounts' rows (hidden by RLS), and the flow must
// not depend on the session cookie surviving the round-trip to Meta.
// ============================================================

import { NextResponse } from 'next/server'
import crypto from 'node:crypto'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { encrypt } from '@/lib/whatsapp/encryption'
import {
  exchangeCodeForToken,
  exchangeForLongLivedToken,
  fetchMe,
  subscribeInstagramApp,
} from '@/lib/instagram/meta-api'
import { decodeState } from '@/lib/instagram/oauth-state'

function siteUrl(): string {
  const url = process.env.NEXT_PUBLIC_SITE_URL?.trim()
  if (!url) throw new Error('NEXT_PUBLIC_SITE_URL is not set.')
  return url.replace(/\/$/, '')
}

/** Redirect back to the inboxes settings with an Instagram status param. */
function settingsRedirect(params: Record<string, string>): NextResponse {
  const qs = new URLSearchParams({ tab: 'inboxes', ...params })
  return NextResponse.redirect(`${siteUrl()}/settings?${qs.toString()}`)
}

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)

  // User declined or Meta returned an error on the consent screen.
  const oauthError = searchParams.get('error')
  if (oauthError) {
    const desc = searchParams.get('error_description') || oauthError
    return settingsRedirect({ instagram: 'error', reason: desc })
  }

  const code = searchParams.get('code')
  const payload = decodeState(searchParams.get('state'))
  if (!code || !payload) {
    return settingsRedirect({ instagram: 'error', reason: 'Invalid or expired authorization state.' })
  }
  const { accountId, userId } = payload

  const redirectUri = `${siteUrl()}/api/instagram/callback`
  const db = supabaseAdmin()

  try {
    // 2. code -> short -> long-lived token.
    const { accessToken: shortToken, instagramId } = await exchangeCodeForToken({ code, redirectUri })
    const { accessToken: longToken, expiresInSeconds } = await exchangeForLongLivedToken(shortToken)

    // 3. Connected account profile.
    const me = await fetchMe(longToken)
    const resolvedInstagramId = me.id || instagramId
    const username = me.username ?? null

    // 4. Cross-account collision — a given IG account maps to one inbox.
    const { data: claimed, error: claimErr } = await db
      .from('instagram_config')
      .select('account_id')
      .eq('instagram_id', resolvedInstagramId)
      .neq('account_id', accountId)
      .maybeSingle()
    if (claimErr) {
      console.error('[instagram/callback] collision check failed:', claimErr)
      return settingsRedirect({ instagram: 'error', reason: 'Failed to validate the Instagram account.' })
    }
    if (claimed) {
      return settingsRedirect({
        instagram: 'error',
        reason: 'This Instagram account is already connected to another workspace.',
      })
    }

    // If THIS account already has it, treat as a reconnect: refresh the token.
    const { data: existing } = await db
      .from('instagram_config')
      .select('id, inbox_id')
      .eq('instagram_id', resolvedInstagramId)
      .eq('account_id', accountId)
      .maybeSingle()

    const verifyToken = crypto.randomBytes(24).toString('hex')
    const now = new Date()
    const expiresAt = new Date(now.getTime() + expiresInSeconds * 1000)

    let inboxId: string

    if (existing) {
      inboxId = existing.inbox_id
      const { error: updErr } = await db
        .from('instagram_config')
        .update({
          access_token: encrypt(longToken),
          token_expires_at: expiresAt.toISOString(),
          token_refreshed_at: now.toISOString(),
          verify_token: encrypt(verifyToken),
          username,
          status: 'connected',
          connected_at: now.toISOString(),
          last_error: null,
          updated_at: now.toISOString(),
        })
        .eq('id', existing.id)
      if (updErr) {
        console.error('[instagram/callback] reconnect update failed:', updErr)
        return settingsRedirect({ instagram: 'error', reason: 'Failed to save the connection.' })
      }
    } else {
      // 5. New inbox + config + membership.
      const inboxName = username ? `Instagram @${username}` : 'Instagram'
      const { data: inbox, error: inboxErr } = await db
        .from('inboxes')
        .insert({ account_id: accountId, name: inboxName, channel_type: 'instagram' })
        .select('id')
        .single()
      if (inboxErr || !inbox) {
        console.error('[instagram/callback] inbox insert failed:', inboxErr)
        return settingsRedirect({ instagram: 'error', reason: 'Failed to create the inbox.' })
      }
      inboxId = inbox.id

      const { error: cfgErr } = await db.from('instagram_config').insert({
        account_id: accountId,
        user_id: userId,
        inbox_id: inboxId,
        instagram_id: resolvedInstagramId,
        username,
        access_token: encrypt(longToken),
        token_expires_at: expiresAt.toISOString(),
        token_refreshed_at: now.toISOString(),
        verify_token: encrypt(verifyToken),
        status: 'connected',
        connected_at: now.toISOString(),
      })
      if (cfgErr) {
        await db.from('inboxes').delete().eq('id', inboxId)
        console.error('[instagram/callback] config insert failed:', cfgErr)
        return settingsRedirect({ instagram: 'error', reason: 'Failed to save the Instagram configuration.' })
      }

      await db.from('inbox_members').insert({ inbox_id: inboxId, user_id: userId })
    }

    // 6. Subscribe the app to webhook fields (best-effort — surfaced via
    //    last_error so a number with no working webhook is visible).
    try {
      await subscribeInstagramApp({ instagramId: resolvedInstagramId, accessToken: longToken })
      await db
        .from('instagram_config')
        .update({ subscribed_apps_at: now.toISOString(), updated_at: now.toISOString() })
        .eq('instagram_id', resolvedInstagramId)
        .eq('account_id', accountId)
    } catch (subErr) {
      const reason = subErr instanceof Error ? subErr.message : 'subscribe failed'
      console.warn('[instagram/callback] subscribe failed:', reason)
      await db
        .from('instagram_config')
        .update({ last_error: `Webhook subscription failed: ${reason}`, updated_at: now.toISOString() })
        .eq('instagram_id', resolvedInstagramId)
        .eq('account_id', accountId)
    }

    return settingsRedirect({ instagram: 'connected', inbox_id: inboxId })
  } catch (err) {
    const reason = err instanceof Error ? err.message : 'Unknown error'
    console.error('[instagram/callback] failed:', reason)
    return settingsRedirect({ instagram: 'error', reason })
  }
}
