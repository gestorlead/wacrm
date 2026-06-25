// ============================================================
// GET /api/instagram/authorize
//
// Starts the Instagram Login OAuth flow. Admin-only. Builds the signed
// `state` (account + user + CSRF/freshness) and 302-redirects the browser
// to Instagram's authorization screen. Meta sends the user back to
// /api/instagram/callback with `code` + `state`.
// ============================================================

import { NextResponse } from 'next/server'
import { requireRole, toErrorResponse } from '@/lib/auth/account'
import { getAuthorizeUrl } from '@/lib/instagram/meta-api'
import { encodeState } from '@/lib/instagram/oauth-state'

function redirectUri(): string {
  const siteUrl = process.env.NEXT_PUBLIC_SITE_URL?.trim()
  if (!siteUrl) {
    throw new Error(
      'NEXT_PUBLIC_SITE_URL is not set. It is required to build the Instagram OAuth redirect URI.',
    )
  }
  return `${siteUrl.replace(/\/$/, '')}/api/instagram/callback`
}

export async function GET() {
  try {
    const { accountId, userId } = await requireRole('admin')
    const url = getAuthorizeUrl({
      redirectUri: redirectUri(),
      state: encodeState(accountId, userId),
    })
    return NextResponse.redirect(url)
  } catch (err) {
    return toErrorResponse(err)
  }
}
