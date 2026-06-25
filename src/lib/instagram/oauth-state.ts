import crypto from 'node:crypto'

/**
 * Signed, self-contained OAuth `state` for the Instagram connect flow.
 *
 * The authorize route issues a state carrying the initiating account/user
 * + an issue timestamp, HMAC-signed with ENCRYPTION_KEY. The callback
 * verifies the signature and freshness — this is the CSRF guard and also
 * lets the callback resolve the account WITHOUT depending on the session
 * cookie surviving the round-trip to Meta.
 */

const STATE_TTL_MS = 10 * 60 * 1000 // 10 minutes

interface StatePayload {
  accountId: string
  userId: string
  /** issued-at, ms */
  iat: number
}

function key(): Buffer {
  const k = process.env.ENCRYPTION_KEY
  if (!k) throw new Error('ENCRYPTION_KEY is not set — required to sign the OAuth state.')
  return Buffer.from(k, 'hex')
}

function sign(data: string): string {
  return crypto.createHmac('sha256', key()).update(data).digest('hex')
}

export function encodeState(accountId: string, userId: string): string {
  const payload: StatePayload = { accountId, userId, iat: Date.now() }
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url')
  return `${body}.${sign(body)}`
}

/** Returns the payload if the state is authentic and fresh, else null. */
export function decodeState(state: string | null): StatePayload | null {
  if (!state) return null
  const [body, sig] = state.split('.')
  if (!body || !sig) return null

  const expected = sign(body)
  const a = Buffer.from(sig)
  const b = Buffer.from(expected)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null

  try {
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString()) as StatePayload
    if (!payload.accountId || !payload.userId || !payload.iat) return null
    if (Date.now() - payload.iat > STATE_TTL_MS) return null
    return payload
  } catch {
    return null
  }
}
