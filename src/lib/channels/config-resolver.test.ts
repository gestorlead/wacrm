import { describe, expect, it } from 'vitest'
import type { SupabaseClient } from '@supabase/supabase-js'
import {
  getInboxChannel,
  getPrimaryAccountConfig,
  resolveWhatsAppInboxByPhoneNumberId,
  PHONE_CHANNELS,
} from './config-resolver'

/**
 * Minimal chainable Supabase stub: `.select().eq().order()` are chainable,
 * `.limit()` / `.maybeSingle()` are terminals, and the builder is also
 * thenable so a bare `await db.from().select().eq()` resolves too. Rows are
 * keyed by table name.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function stubDb(tables: Record<string, any[]>): SupabaseClient {
  const make = (table: string) => {
    const rows = tables[table] ?? []
    const builder: Record<string, unknown> = {
      select: () => builder,
      eq: () => builder,
      order: () => builder,
      limit: () => Promise.resolve({ data: rows, error: null }),
      maybeSingle: () => Promise.resolve({ data: rows[0] ?? null, error: null }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      then: (resolve: (v: any) => void) => resolve({ data: rows, error: null }),
    }
    return builder
  }
  return { from: (t: string) => make(t) } as unknown as SupabaseClient
}

describe('getInboxChannel', () => {
  it('resolves a whatsapp inbox to its config', async () => {
    const db = stubDb({
      inboxes: [{ id: 'i1', account_id: 'a1', channel_type: 'whatsapp' }],
      whatsapp_config: [{ id: 'c1', inbox_id: 'i1', phone_number_id: '123' }],
    })
    const channel = await getInboxChannel(db, 'i1')
    expect(channel?.channelType).toBe('whatsapp')
    expect(channel?.accountId).toBe('a1')
    expect(channel?.config.phone_number_id).toBe('123')
  })

  it('returns null when the inbox does not exist', async () => {
    const db = stubDb({ inboxes: [] })
    expect(await getInboxChannel(db, 'missing')).toBeNull()
  })

  it('returns null for a channel type not implemented yet', async () => {
    const db = stubDb({
      inboxes: [{ id: 'i2', account_id: 'a1', channel_type: 'instagram' }],
    })
    expect(await getInboxChannel(db, 'i2')).toBeNull()
  })

  it('returns null when the inbox has no config row', async () => {
    const db = stubDb({
      inboxes: [{ id: 'i1', account_id: 'a1', channel_type: 'whatsapp' }],
      whatsapp_config: [],
    })
    expect(await getInboxChannel(db, 'i1')).toBeNull()
  })
})

describe('getPrimaryAccountConfig', () => {
  it('returns the first config row for the account', async () => {
    const db = stubDb({ whatsapp_config: [{ id: 'c1' }, { id: 'c2' }] })
    const cfg = await getPrimaryAccountConfig(db, 'a1')
    expect(cfg?.id).toBe('c1')
  })

  it('returns null when the account has no config', async () => {
    const db = stubDb({ whatsapp_config: [] })
    expect(await getPrimaryAccountConfig(db, 'a1')).toBeNull()
  })
})

describe('resolveWhatsAppInboxByPhoneNumberId', () => {
  it('resolves a single matching config to its inbox', async () => {
    const db = stubDb({
      whatsapp_config: [{ id: 'c1', inbox_id: 'i1', account_id: 'a1', phone_number_id: '123' }],
    })
    const channel = await resolveWhatsAppInboxByPhoneNumberId(db, '123')
    expect(channel?.inboxId).toBe('i1')
  })

  it('returns null on zero matches', async () => {
    const db = stubDb({ whatsapp_config: [] })
    expect(await resolveWhatsAppInboxByPhoneNumberId(db, '123')).toBeNull()
  })

  it('returns null on multiple matches (duplicate config bug)', async () => {
    const db = stubDb({
      whatsapp_config: [
        { id: 'c1', inbox_id: 'i1', account_id: 'a1' },
        { id: 'c2', inbox_id: 'i2', account_id: 'a2' },
      ],
    })
    expect(await resolveWhatsAppInboxByPhoneNumberId(db, '123')).toBeNull()
  })
})

describe('PHONE_CHANNELS', () => {
  it('includes whatsapp (phone-based dedupe applies)', () => {
    expect(PHONE_CHANNELS).toContain('whatsapp')
  })
})
