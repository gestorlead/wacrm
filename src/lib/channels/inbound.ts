import type { SupabaseClient } from '@supabase/supabase-js'
import { findExistingContact, isUniqueViolation } from '@/lib/contacts/dedupe'
import { PHONE_CHANNELS, type ChannelType } from './config-resolver'

/**
 * Channel-agnostic inbound resolution for multi-inbox.
 *
 * Replaces the phone-coupled find-or-create logic that lived inline in the
 * WhatsApp webhook. A contact is linked to an inbox through `contact_inboxes`
 * keyed by `source_id` (the contact's identity ON that channel: phone for
 * WhatsApp, IGSID for Instagram, PSID for Messenger). This is what lets
 * channels without a phone number work without touching the contact model.
 *
 * Contacts stay account-scoped: the same person reaching two inboxes is one
 * contact with two `contact_inboxes` rows (and two conversations).
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>

export interface ResolveContactInboxArgs {
  db: SupabaseClient
  inboxId: string
  accountId: string
  channelType: ChannelType
  /** Identity of the contact on this channel (phone / IGSID / PSID). */
  sourceId: string
  /** Display name from the platform payload; '' when unknown. */
  name: string
  /** Audit user_id for NOT NULL FK columns on created rows. */
  userId: string
}

export interface ContactInboxOutcome {
  contact: Row
  contactInbox: Row
  /** True when this call created the contact row (drives new_contact_created). */
  contactWasCreated: boolean
}

/**
 * Resolve (or create) the contact + contact_inbox for an inbound message.
 *
 *   1. Existing `contact_inboxes` for (inbox_id, source_id) → reuse its contact.
 *   2. Phone channels only: dedupe into an existing account contact by phone.
 *   3. Otherwise create a new contact.
 *   4. Ensure the `contact_inboxes` link exists.
 *
 * Returns null only on an unrecoverable DB error.
 */
export async function resolveContactInbox(
  args: ResolveContactInboxArgs,
): Promise<ContactInboxOutcome | null> {
  const { db, inboxId, accountId, channelType, sourceId, name, userId } = args

  // (1) Existing link on this channel.
  const { data: existingCi } = await db
    .from('contact_inboxes')
    .select('*')
    .eq('inbox_id', inboxId)
    .eq('source_id', sourceId)
    .maybeSingle()

  if (existingCi) {
    const { data: contact } = await db
      .from('contacts')
      .select('*')
      .eq('id', existingCi.contact_id)
      .maybeSingle()
    if (contact) {
      if (name && name !== contact.name) {
        await db
          .from('contacts')
          .update({ name, updated_at: new Date().toISOString() })
          .eq('id', contact.id)
      }
      return { contact, contactInbox: existingCi, contactWasCreated: false }
    }
    // Dangling link (contact deleted): fall through and re-resolve a contact,
    // then re-point this contact_inbox row below.
  }

  // (2)/(3) Resolve the contact row.
  let contact: Row | null = null
  let contactWasCreated = false

  const isPhoneChannel = PHONE_CHANNELS.includes(channelType)

  if (isPhoneChannel) {
    const existing = await findExistingContact(db, accountId, sourceId)
    if (existing) {
      contact = existing
      if (name && name !== existing.name) {
        await db
          .from('contacts')
          .update({ name, updated_at: new Date().toISOString() })
          .eq('id', existing.id)
      }
    }
  }

  if (!contact) {
    // Phone channels store the source_id as the contact's phone (and dedupe
    // on it). Non-phone channels (Instagram/Messenger) leave `phone` NULL —
    // identity lives entirely in the `contact_inboxes.source_id` link, so
    // the unique-on-source_id index (not phone) is what prevents duplicates.
    // `contacts.phone` is nullable since migration 034; the generated
    // `phone_normalized` is NULL for these rows and excluded from the
    // per-account phone unique index.
    const insertRow: Record<string, unknown> = {
      account_id: accountId,
      user_id: userId,
      name: name || sourceId,
      phone: isPhoneChannel ? sourceId : null,
    }
    const { data: created, error: createErr } = await db
      .from('contacts')
      .insert(insertRow)
      .select()
      .single()
    if (createErr) {
      // Phone channels can lose a race against a concurrent inbound on the
      // per-account phone unique index — re-resolve. Non-phone channels have
      // no such constraint, so a failure there is a real error.
      if (isPhoneChannel && isUniqueViolation(createErr)) {
        const raced = await findExistingContact(db, accountId, sourceId)
        if (raced) contact = raced
      }
      if (!contact) {
        console.error('[inbound] contact create failed:', createErr)
        return null
      }
    } else {
      contact = created
      contactWasCreated = true
    }
  }

  if (!contact) return null

  // (4) Ensure the contact_inbox link.
  const contactInbox = await upsertContactInbox(db, {
    accountId,
    inboxId,
    contactId: contact.id,
    sourceId,
  })
  if (!contactInbox) return null

  return { contact, contactInbox, contactWasCreated }
}

async function upsertContactInbox(
  db: SupabaseClient,
  args: { accountId: string; inboxId: string; contactId: string; sourceId: string },
): Promise<Row | null> {
  const { accountId, inboxId, contactId, sourceId } = args

  const { data: existing } = await db
    .from('contact_inboxes')
    .select('*')
    .eq('inbox_id', inboxId)
    .eq('contact_id', contactId)
    .maybeSingle()
  if (existing) {
    // Re-point a dangling source_id if it drifted (rare).
    if (existing.source_id !== sourceId) {
      await db.from('contact_inboxes').update({ source_id: sourceId }).eq('id', existing.id)
    }
    return existing
  }

  const { data: created, error } = await db
    .from('contact_inboxes')
    .insert({ account_id: accountId, inbox_id: inboxId, contact_id: contactId, source_id: sourceId })
    .select()
    .single()
  if (error) {
    if (isUniqueViolation(error)) {
      const { data: raced } = await db
        .from('contact_inboxes')
        .select('*')
        .eq('inbox_id', inboxId)
        .eq('contact_id', contactId)
        .maybeSingle()
      if (raced) return raced
    }
    console.error('[inbound] contact_inbox create failed:', error)
    return null
  }
  return created
}

export interface FindOrCreateConversationArgs {
  db: SupabaseClient
  accountId: string
  inboxId: string
  userId: string
  contactId: string
  contactInboxId: string
}

/**
 * Find or create the single conversation for (inbox_id, contact_id).
 * Backed by the unique index `idx_one_conv_per_inbox_contact` — a racing
 * insert is recovered by re-fetching.
 */
export async function findOrCreateConversation(
  args: FindOrCreateConversationArgs,
): Promise<Row | null> {
  const { db, accountId, inboxId, userId, contactId, contactInboxId } = args

  const { data: existing } = await db
    .from('conversations')
    .select('*')
    .eq('inbox_id', inboxId)
    .eq('contact_id', contactId)
    .maybeSingle()
  if (existing) return existing

  const { data: created, error } = await db
    .from('conversations')
    .insert({
      account_id: accountId,
      user_id: userId,
      inbox_id: inboxId,
      contact_id: contactId,
      contact_inbox_id: contactInboxId,
    })
    .select()
    .single()

  if (error) {
    if (isUniqueViolation(error)) {
      const { data: raced } = await db
        .from('conversations')
        .select('*')
        .eq('inbox_id', inboxId)
        .eq('contact_id', contactId)
        .maybeSingle()
      if (raced) return raced
    }
    console.error('[inbound] conversation create failed:', error)
    return null
  }
  return created
}
