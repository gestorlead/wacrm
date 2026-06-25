import type { SupabaseClient } from '@supabase/supabase-js'
import { decrypt, encrypt } from '@/lib/whatsapp/encryption'
import { refreshLongLivedToken } from './meta-api'

/**
 * Lazy refresh of an Instagram long-lived token, mirroring Chatwoot's
 * `Instagram::RefreshOauthTokenService`. A long-lived token lasts ~60
 * days and can be refreshed (extending another 60) as long as it is:
 *   - not yet expired, AND
 *   - at least 24h old (Meta rejects refreshes of fresh tokens), AND
 *   - within 10 days of expiry (no point refreshing earlier).
 *
 * Call this before using `config.access_token` to send. Returns the
 * decrypted token to use right now (refreshed or not). Refresh failures
 * are swallowed (logged) and the existing token is returned — a refresh
 * hiccup must not block an otherwise-valid send.
 */
const DAY_MS = 24 * 3600 * 1000

export async function getFreshAccessToken(
  db: SupabaseClient,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  config: Record<string, any>,
): Promise<string> {
  const current = decrypt(config.access_token)

  if (!shouldRefresh(config)) return current

  try {
    const { accessToken, expiresInSeconds } = await refreshLongLivedToken(current)
    const now = new Date()
    const expiresAt = new Date(now.getTime() + expiresInSeconds * 1000)
    await db
      .from('instagram_config')
      .update({
        access_token: encrypt(accessToken),
        token_expires_at: expiresAt.toISOString(),
        token_refreshed_at: now.toISOString(),
        last_error: null,
        updated_at: now.toISOString(),
      })
      .eq('id', config.id)
    return accessToken
  } catch (err) {
    console.warn(
      '[instagram] token refresh failed, using existing token:',
      err instanceof Error ? err.message : err,
    )
    return current
  }
}

/** Pure eligibility check — exported for the daily cron sweep. */
export function shouldRefresh(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  config: Record<string, any>,
): boolean {
  const expiresAt = config.token_expires_at ? new Date(config.token_expires_at).getTime() : null
  if (expiresAt == null) return false // unknown expiry — don't risk an invalid refresh

  const now = Date.now()
  if (expiresAt <= now) return false // already expired — refresh would fail; needs reauth

  const refreshedAt = config.token_refreshed_at
    ? new Date(config.token_refreshed_at).getTime()
    : config.connected_at
      ? new Date(config.connected_at).getTime()
      : null
  // Meta rejects refreshing a token younger than 24h.
  if (refreshedAt != null && now - refreshedAt < DAY_MS) return false

  // Only refresh within the last 10 days of the token's life.
  return expiresAt - now < 10 * DAY_MS
}
