/**
 * Instagram Graph API wrappers (Instagram Login API, "direct" model).
 *
 * Uses graph.instagram.com against the connected `instagram_business_account`
 * — no Facebook Page in the loop. Mirrors the Chatwoot `Channel::Instagram`
 * flow: OAuth code -> short token -> long-lived (60d) token, webhook
 * subscription on `subscribed_apps`, and Send API on /{instagram_id}/messages.
 *
 * Env:
 *   INSTAGRAM_APP_ID      — Instagram app id (Meta app, Instagram product)
 *   INSTAGRAM_APP_SECRET  — Instagram app secret (also signs webhooks)
 *   META_API_VERSION      — defaults to v22.0 (shared with WhatsApp)
 */

const IG_API_VERSION = process.env.META_API_VERSION || 'v22.0'
/** Token-exchange / authorize endpoints live under api.instagram.com. */
const IG_OAUTH_BASE = 'https://api.instagram.com'
/** Graph calls (me, messages, subscribed_apps, refresh) under graph.instagram.com. */
const IG_GRAPH_BASE = `https://graph.instagram.com/${IG_API_VERSION}`
/** Versionless graph host — token endpoints reject a version prefix. */
const IG_GRAPH_ROOT = 'https://graph.instagram.com'

/** Scopes required to read the business profile and manage DMs. */
export const IG_SCOPES = [
  'instagram_business_basic',
  'instagram_business_manage_messages',
].join(',')

/** Webhook fields we subscribe the app to for an inbox. */
export const IG_SUBSCRIBED_FIELDS = [
  'messages',
  'message_reactions',
  'messaging_seen',
  'messaging_postbacks',
].join(',')

export interface IgSendResult {
  /** Meta-side message id (mid) returned by the Send API. */
  messageId: string
  /** The recipient IGSID echoed back by Meta. */
  recipientId?: string
}

interface IgErrorResponse {
  error?: { message?: string; code?: number; type?: string; error_subcode?: number }
}

/**
 * Throw a clean Error from a non-2xx Instagram response, surfacing Meta's
 * own message and tagging the numeric code so callers can branch (e.g.
 * code 190 = invalid/expired token -> reauth).
 */
async function throwIgError(response: Response, fallback: string): Promise<never> {
  let message = fallback
  let code: number | undefined
  try {
    const data = (await response.json()) as IgErrorResponse
    if (data.error?.message) message = data.error.message
    code = data.error?.code
  } catch {
    // body wasn't JSON — keep the fallback
  }
  const err = new Error(message) as Error & { metaCode?: number }
  if (code != null) err.metaCode = code
  throw err
}

function requireAppCreds(): { appId: string; appSecret: string } {
  const appId = process.env.INSTAGRAM_APP_ID
  const appSecret = process.env.INSTAGRAM_APP_SECRET
  if (!appId || !appSecret) {
    throw new Error(
      'INSTAGRAM_APP_ID / INSTAGRAM_APP_SECRET are not set. Configure them ' +
        '(Meta App → Instagram → API setup with Instagram login) to connect Instagram.',
    )
  }
  return { appId, appSecret }
}

// ============================================================
// OAuth
// ============================================================

/**
 * Build the Instagram authorization URL the admin is redirected to.
 * `redirectUri` must exactly match one registered on the Meta app, and is
 * echoed back on the token exchange.
 */
export function getAuthorizeUrl(args: { redirectUri: string; state: string }): string {
  const { appId } = requireAppCreds()
  const params = new URLSearchParams({
    client_id: appId,
    redirect_uri: args.redirectUri,
    response_type: 'code',
    scope: IG_SCOPES,
    state: args.state,
  })
  return `${IG_OAUTH_BASE}/oauth/authorize?${params.toString()}`
}

/**
 * Exchange the one-time `code` for a SHORT-lived access token + the
 * connected instagram business account id (`user_id`).
 */
export async function exchangeCodeForToken(args: {
  code: string
  redirectUri: string
}): Promise<{ accessToken: string; instagramId: string }> {
  const { appId, appSecret } = requireAppCreds()
  const form = new URLSearchParams({
    client_id: appId,
    client_secret: appSecret,
    grant_type: 'authorization_code',
    redirect_uri: args.redirectUri,
    code: args.code,
  })
  const response = await fetch(`${IG_OAUTH_BASE}/oauth/access_token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: form.toString(),
  })
  if (!response.ok) {
    await throwIgError(response, `Instagram code exchange failed: ${response.status}`)
  }
  const data = await response.json()
  // Instagram returns { access_token, user_id, permissions }.
  const instagramId = data.user_id != null ? String(data.user_id) : ''
  if (!data.access_token || !instagramId) {
    throw new Error('Instagram code exchange returned no access_token / user_id.')
  }
  return { accessToken: data.access_token, instagramId }
}

/**
 * Exchange a short-lived token for a LONG-lived one (~60 days).
 * Returns the token and its lifetime in seconds.
 */
export async function exchangeForLongLivedToken(
  shortToken: string,
): Promise<{ accessToken: string; expiresInSeconds: number }> {
  const { appSecret } = requireAppCreds()
  const params = new URLSearchParams({
    grant_type: 'ig_exchange_token',
    client_secret: appSecret,
    access_token: shortToken,
  })
  const response = await fetch(`${IG_GRAPH_ROOT}/access_token?${params.toString()}`)
  if (!response.ok) {
    await throwIgError(response, `Instagram long-lived exchange failed: ${response.status}`)
  }
  const data = await response.json()
  if (!data.access_token) throw new Error('Instagram long-lived exchange returned no token.')
  return {
    accessToken: data.access_token,
    expiresInSeconds: Number(data.expires_in) || 60 * 24 * 3600,
  }
}

/**
 * Refresh a long-lived token before it expires (extends another ~60 days).
 * The token must be at least 24h old and not yet expired.
 */
export async function refreshLongLivedToken(
  token: string,
): Promise<{ accessToken: string; expiresInSeconds: number }> {
  const params = new URLSearchParams({
    grant_type: 'ig_refresh_token',
    access_token: token,
  })
  const response = await fetch(`${IG_GRAPH_ROOT}/refresh_access_token?${params.toString()}`)
  if (!response.ok) {
    await throwIgError(response, `Instagram token refresh failed: ${response.status}`)
  }
  const data = await response.json()
  if (!data.access_token) throw new Error('Instagram token refresh returned no token.')
  return {
    accessToken: data.access_token,
    expiresInSeconds: Number(data.expires_in) || 60 * 24 * 3600,
  }
}

// ============================================================
// Account / profile
// ============================================================

export interface IgMe {
  id: string
  username?: string
  name?: string
  profile_picture_url?: string
  account_type?: string
}

/** Fetch the connected business account's own profile (post-OAuth). */
export async function fetchMe(token: string): Promise<IgMe> {
  const params = new URLSearchParams({
    fields: 'id,username,name,profile_picture_url,account_type',
    access_token: token,
  })
  const response = await fetch(`${IG_GRAPH_BASE}/me?${params.toString()}`)
  if (!response.ok) {
    await throwIgError(response, `Instagram /me failed: ${response.status}`)
  }
  const data = await response.json()
  return { ...data, id: String(data.id) }
}

export interface IgContactProfile {
  name?: string
  username?: string
  profilePicUrl?: string
}

/**
 * Fetch a sender's public profile by IGSID on first contact. Instagram
 * returns error 230 when the user hasn't consented to profile sharing —
 * callers should fall back to an "Unknown" contact rather than failing.
 */
export async function getInstagramUserProfile(
  igsid: string,
  token: string,
): Promise<IgContactProfile | null> {
  const params = new URLSearchParams({
    fields: 'name,username,profile_pic',
    access_token: token,
  })
  const response = await fetch(`${IG_GRAPH_BASE}/${igsid}?${params.toString()}`)
  if (!response.ok) {
    // Privacy / consent errors are expected — don't throw, just skip.
    console.warn('[instagram] profile fetch failed for', igsid, response.status)
    return null
  }
  const data = await response.json()
  return {
    name: data.name,
    username: data.username,
    profilePicUrl: data.profile_pic,
  }
}

/**
 * Fetch a story object (used to render a story reply / mention). The
 * story media url is short-lived; callers persist the bytes if needed.
 */
export async function fetchStoryById(
  storyId: string,
  token: string,
): Promise<{ mediaUrl?: string; mediaType?: string } | null> {
  const params = new URLSearchParams({
    fields: 'id,media_type,media_url',
    access_token: token,
  })
  const response = await fetch(`${IG_GRAPH_BASE}/${storyId}?${params.toString()}`)
  if (!response.ok) {
    console.warn('[instagram] story fetch failed for', storyId, response.status)
    return null
  }
  const data = await response.json()
  return { mediaUrl: data.media_url, mediaType: data.media_type }
}

// ============================================================
// Webhook subscription
// ============================================================

/**
 * Subscribe the app to webhook fields for a connected account. Idempotent
 * on Meta's side — safe to call on every (re)connect.
 */
export async function subscribeInstagramApp(args: {
  instagramId: string
  accessToken: string
}): Promise<void> {
  const { instagramId, accessToken } = args
  const params = new URLSearchParams({
    subscribed_fields: IG_SUBSCRIBED_FIELDS,
    access_token: accessToken,
  })
  const response = await fetch(
    `${IG_GRAPH_BASE}/${instagramId}/subscribed_apps?${params.toString()}`,
    { method: 'POST' },
  )
  if (!response.ok) {
    await throwIgError(response, `Instagram subscribe failed: ${response.status}`)
  }
}

// ============================================================
// Send API
// ============================================================

export type IgMediaKind = 'image' | 'video' | 'audio'

interface SendBase {
  instagramId: string
  accessToken: string
  /** Recipient IGSID. */
  recipientId: string
  /** HUMAN_AGENT tag — required to reply outside the 24h window. */
  humanAgentTag?: boolean
}

async function postMessage(
  instagramId: string,
  accessToken: string,
  body: Record<string, unknown>,
): Promise<IgSendResult> {
  const response = await fetch(`${IG_GRAPH_BASE}/${instagramId}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    await throwIgError(response, `Instagram send failed: ${response.status}`)
  }
  const data = await response.json()
  return { messageId: data.message_id, recipientId: data.recipient_id }
}

/** Send a text DM. */
export async function sendInstagramMessage(
  args: SendBase & { text: string },
): Promise<IgSendResult> {
  const body: Record<string, unknown> = {
    recipient: { id: args.recipientId },
    message: { text: args.text },
  }
  if (args.humanAgentTag) {
    body.messaging_type = 'MESSAGE_TAG'
    body.tag = 'HUMAN_AGENT'
  }
  return postMessage(args.instagramId, args.accessToken, body)
}

/** Send a media DM (image / video / audio) by public URL. */
export async function sendInstagramMedia(
  args: SendBase & { kind: IgMediaKind; link: string },
): Promise<IgSendResult> {
  if (!args.link) throw new Error('sendInstagramMedia requires a link.')
  const body: Record<string, unknown> = {
    recipient: { id: args.recipientId },
    message: {
      attachment: {
        type: args.kind,
        payload: { url: args.link },
      },
    },
  }
  if (args.humanAgentTag) {
    body.messaging_type = 'MESSAGE_TAG'
    body.tag = 'HUMAN_AGENT'
  }
  return postMessage(args.instagramId, args.accessToken, body)
}

/**
 * Download attachment bytes from a (short-lived) Instagram CDN url. No auth
 * header needed — the url is pre-signed. Mirrors the WhatsApp downloadMedia
 * shape so the webhook can reuse the same storage-upload path.
 */
export async function downloadInstagramMedia(
  downloadUrl: string,
): Promise<{ buffer: Buffer; contentType: string }> {
  const response = await fetch(downloadUrl)
  if (!response.ok) {
    throw new Error(`Instagram media download failed: ${response.status}`)
  }
  const contentType = response.headers.get('content-type') || 'application/octet-stream'
  const buffer = Buffer.from(await response.arrayBuffer())
  return { buffer, contentType }
}
