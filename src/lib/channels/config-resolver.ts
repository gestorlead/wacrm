import type { SupabaseClient } from '@supabase/supabase-js'

/**
 * Channel abstraction for multi-inbox.
 *
 * Each inbox has a `channel_type` discriminator and a 1:1 channel-config
 * row in a dedicated table (`whatsapp_config` today; `instagram_config` /
 * `messenger_config` later). These resolvers map an inbox — or a
 * conversation — to its channel config, dispatching on `channel_type`.
 *
 * Adding a channel = a new `*_config` table + a `case` here + a webhook
 * parser; contacts/conversations/UI stay untouched.
 */

export type ChannelType = 'whatsapp' | 'instagram' | 'messenger'

/** Channels whose `source_id` is a phone number (drives contact dedupe). */
export const PHONE_CHANNELS: readonly ChannelType[] = ['whatsapp']

/** A whatsapp_config row, kept loose to mirror the existing webhook/send
 *  code which reads arbitrary columns off the row. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type WhatsAppConfigRow = Record<string, any>

export interface InboxChannel {
  inboxId: string
  accountId: string
  channelType: ChannelType
  /** The channel-specific config row (e.g. a whatsapp_config row). */
  config: WhatsAppConfigRow
}

/**
 * Resolve an inbox to its channel config. Returns null when the inbox
 * doesn't exist, the channel type isn't implemented yet, or the config
 * row is missing (inbox saved but channel never connected).
 */
export async function getInboxChannel(
  db: SupabaseClient,
  inboxId: string,
): Promise<InboxChannel | null> {
  const { data: inbox, error: inboxErr } = await db
    .from('inboxes')
    .select('id, account_id, channel_type')
    .eq('id', inboxId)
    .maybeSingle()
  if (inboxErr || !inbox) return null

  switch (inbox.channel_type as ChannelType) {
    case 'whatsapp': {
      const { data: config, error } = await db
        .from('whatsapp_config')
        .select('*')
        .eq('inbox_id', inboxId)
        .maybeSingle()
      if (error || !config) return null
      return {
        inboxId,
        accountId: inbox.account_id,
        channelType: 'whatsapp',
        config,
      }
    }
    case 'instagram': {
      const { data: config, error } = await db
        .from('instagram_config')
        .select('*')
        .eq('inbox_id', inboxId)
        .maybeSingle()
      if (error || !config) return null
      return {
        inboxId,
        accountId: inbox.account_id,
        channelType: 'instagram',
        config,
      }
    }
    // 'messenger' plugs in here.
    default:
      return null
  }
}

/**
 * Resolve the channel config that should send/receive for a conversation,
 * via its inbox. Returns null when the conversation has no inbox (should
 * not happen post-migration 032) or the channel is unresolved.
 */
export async function getChannelForConversation(
  db: SupabaseClient,
  conversationId: string,
): Promise<InboxChannel | null> {
  const { data: conv, error } = await db
    .from('conversations')
    .select('inbox_id')
    .eq('id', conversationId)
    .maybeSingle()
  if (error || !conv?.inbox_id) return null
  return getInboxChannel(db, conv.inbox_id)
}

/**
 * The account's "primary" WhatsApp config — the earliest-connected number.
 *
 * Used by WABA-level flows (template sync/submit, registration probe) that
 * are still account-scoped: with multi-inbox an account can have several
 * numbers, so a bare `.single()` would throw. Templates remain per-account
 * for now; per-WABA templates are a documented follow-up.
 */
export async function getPrimaryAccountConfig(
  db: SupabaseClient,
  accountId: string,
): Promise<WhatsAppConfigRow | null> {
  const { data } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('account_id', accountId)
    .order('created_at', { ascending: true })
    .limit(1)
  return data?.[0] ?? null
}

/**
 * Resolve the inbox (and account) that owns a WhatsApp `phone_number_id`.
 * This is the WhatsApp routing key for inbound webhooks. Returns null on
 * zero or multiple matches (multiple => duplicate config rows, a data bug).
 */
export async function resolveWhatsAppInboxByPhoneNumberId(
  db: SupabaseClient,
  phoneNumberId: string,
): Promise<InboxChannel | null> {
  const { data: rows, error } = await db
    .from('whatsapp_config')
    .select('*')
    .eq('phone_number_id', phoneNumberId)
  if (error || !rows || rows.length !== 1) return null
  const config = rows[0]
  if (!config.inbox_id || !config.account_id) return null
  return {
    inboxId: config.inbox_id,
    accountId: config.account_id,
    channelType: 'whatsapp',
    config,
  }
}

/**
 * Resolve the inbox (and account) that owns an Instagram `instagram_id`.
 * This is the Instagram routing key for inbound webhooks (the recipient
 * of an inbound DM = our connected business account). Returns null on
 * zero or multiple matches (multiple => duplicate config rows, a data bug).
 */
export async function resolveInstagramInboxByInstagramId(
  db: SupabaseClient,
  instagramId: string,
): Promise<InboxChannel | null> {
  const { data: rows, error } = await db
    .from('instagram_config')
    .select('*')
    .eq('instagram_id', instagramId)
  if (error || !rows || rows.length !== 1) return null
  const config = rows[0]
  if (!config.inbox_id || !config.account_id) return null
  return {
    inboxId: config.inbox_id,
    accountId: config.account_id,
    channelType: 'instagram',
    config,
  }
}
