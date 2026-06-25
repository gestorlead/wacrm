import { NextResponse } from 'next/server'
import { createClient } from '@supabase/supabase-js'
import { decrypt, encrypt, isLegacyFormat } from '@/lib/whatsapp/encryption'
import { verifyHubSignature } from '@/lib/whatsapp/webhook-signature'
import { isUniqueViolation } from '@/lib/contacts/dedupe'
import {
  resolveContactInbox,
  findOrCreateConversation,
} from '@/lib/channels/inbound'
import { resolveInstagramInboxByInstagramId } from '@/lib/channels/config-resolver'
import {
  getInstagramUserProfile,
  fetchStoryById,
  downloadInstagramMedia,
} from '@/lib/instagram/meta-api'
import { runAutomationsForTrigger } from '@/lib/automations/engine'
import { dispatchInboundToFlows } from '@/lib/flows/engine'

// Lazy admin client (service role) — mirrors the WhatsApp webhook.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _adminClient: any = null
function supabaseAdmin() {
  if (!_adminClient) {
    _adminClient = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.SUPABASE_SERVICE_ROLE_KEY!,
    )
  }
  return _adminClient
}

// ============================================================
// Instagram webhook payload shapes (Messaging / Instagram Login API).
// ============================================================
interface IgAttachment {
  type: string // image | video | audio | share | story_mention | ig_reel | reel | file
  payload?: { url?: string; title?: string }
}
interface IgMessage {
  mid: string
  text?: string
  is_echo?: boolean
  is_deleted?: boolean
  is_unsupported?: boolean
  attachments?: IgAttachment[]
  /** Swipe-reply to one of our messages, or a story reply/mention. */
  reply_to?: { mid?: string; story?: { id?: string; url?: string } }
}
interface IgReaction {
  mid: string
  action: 'react' | 'unreact'
  reaction?: string
  emoji?: string
}
interface IgMessagingEvent {
  sender: { id: string }
  recipient: { id: string }
  timestamp?: number
  message?: IgMessage
  reaction?: IgReaction
  // read / postback / seen events are ignored for now.
  read?: unknown
}
interface IgEntry {
  id: string // the connected IG business account id (routing key)
  time?: number
  messaging?: IgMessagingEvent[]
  // Some test payloads use `changes` instead of `messaging`.
  changes?: Array<{ field: string; value: unknown }>
}
interface IgWebhookBody {
  object?: string
  entry?: IgEntry[]
}

// ============================================================
// GET — webhook verification (hub.challenge).
// ============================================================
export async function GET(request: Request) {
  const { searchParams } = new URL(request.url)
  const mode = searchParams.get('hub.mode')
  const challenge = searchParams.get('hub.challenge')
  const verifyToken = searchParams.get('hub.verify_token')

  if (mode !== 'subscribe' || !challenge || !verifyToken) {
    return NextResponse.json({ error: 'Missing verification parameters' }, { status: 400 })
  }

  // App-level webhook setup (Meta dashboard → Webhooks → Instagram) runs
  // BEFORE any inbox exists, so we accept a static token from the env first.
  // This is the token you type into the Meta dashboard. Per-row tokens
  // (below) cover any future per-connection callback flows.
  const staticToken = process.env.INSTAGRAM_WEBHOOK_VERIFY_TOKEN
  if (staticToken && verifyToken === staticToken) {
    return new Response(challenge, { status: 200, headers: { 'Content-Type': 'text/plain' } })
  }

  const { data: configs, error } = await supabaseAdmin()
    .from('instagram_config')
    .select('id, verify_token')
  if (error || !configs) {
    return NextResponse.json({ error: 'Verification failed' }, { status: 403 })
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let matched: any = null
  for (const cfg of configs) {
    if (!cfg.verify_token) continue
    try {
      if (decrypt(cfg.verify_token) === verifyToken) {
        matched = cfg
        break
      }
    } catch {
      // wrong-key / malformed token — skip
    }
  }
  if (!matched) {
    return NextResponse.json({ error: 'Verification token mismatch' }, { status: 403 })
  }

  // Opportunistic GCM upgrade (no-op once already GCM).
  if (isLegacyFormat(matched.verify_token)) {
    void supabaseAdmin()
      .from('instagram_config')
      .update({ verify_token: encrypt(verifyToken) })
      .eq('id', matched.id)
  }
  return new Response(challenge, { status: 200, headers: { 'Content-Type': 'text/plain' } })
}

// ============================================================
// POST — receive events.
//
// Processed synchronously: on a hard failure we return 500 so Meta
// redelivers (processing is idempotent via the `mid` dedup), rather
// than acking an event we lost. Media persistence is best-effort with a
// CDN-url fallback so the sync path stays fast.
// ============================================================
export async function POST(request: Request) {
  const rawBody = await request.text()
  const signature = request.headers.get('x-hub-signature-256')

  const secret = process.env.INSTAGRAM_APP_SECRET || process.env.META_APP_SECRET
  if (!verifyHubSignature(rawBody, signature, secret)) {
    console.warn('[ig-webhook] rejected request with invalid signature')
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  let body: IgWebhookBody
  try {
    body = JSON.parse(rawBody)
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 })
  }

  try {
    await processInstagramWebhook(body)
  } catch (err) {
    console.error('[ig-webhook] processing failed, asking Meta to retry:', err)
    return NextResponse.json({ error: 'processing failed' }, { status: 500 })
  }
  return NextResponse.json({ status: 'received' }, { status: 200 })
}

export async function processInstagramWebhook(body: IgWebhookBody) {
  if (!body.entry) return

  for (const entry of body.entry) {
    const events = entry.messaging ?? []
    if (events.length === 0) continue

    // Route by the connected account id (= entry.id = recipient.id).
    const channel = await resolveInstagramInboxByInstagramId(supabaseAdmin(), entry.id)
    if (!channel) {
      console.error('[ig-webhook] no instagram_config for account id:', entry.id)
      continue
    }
    const accessToken = decrypt(channel.config.access_token)

    for (const event of events) {
      await handleEvent(event, channel, accessToken)
    }
  }
}

interface ResolvedChannel {
  inboxId: string
  accountId: string
  config: { user_id: string; instagram_id: string }
}

async function handleEvent(
  event: IgMessagingEvent,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  channel: any,
  accessToken: string,
) {
  const ch: ResolvedChannel = {
    inboxId: channel.inboxId,
    accountId: channel.accountId,
    config: channel.config,
  }

  // Reactions (top-level) — per-(message, actor) state, not a new message.
  if (event.reaction) {
    await handleReaction(event, ch)
    return
  }

  const message = event.message
  if (!message) return

  // Echo = a message WE sent (from the CRM or from the IG app). Mirror as
  // an outbound 'agent' row. The 2s delay lets the /send route's own insert
  // land first so the `mid` dedup below suppresses the duplicate.
  if (message.is_echo) {
    await new Promise((r) => setTimeout(r, 2000))
    await storeOutboundEcho(event, message, ch, accessToken)
    return
  }

  // Deletion — flag the existing row rather than inserting.
  if (message.is_deleted) {
    await supabaseAdmin()
      .from('messages')
      .update({ content_text: '[Mensagem apagada]', content_type: 'text' })
      .eq('message_id', message.mid)
    return
  }

  await storeInbound(event, message, ch, accessToken)
}

/** True when a message with this Meta mid already exists. */
async function messageAlreadyStored(mid: string): Promise<boolean> {
  const { data } = await supabaseAdmin()
    .from('messages')
    .select('id')
    .eq('message_id', mid)
    .limit(1)
    .maybeSingle()
  return !!data
}

// IG attachment type → our messages.content_type CHECK set.
const ALLOWED_CONTENT_TYPES = new Set([
  'text', 'image', 'document', 'audio', 'video', 'location', 'template', 'interactive',
])
function mapContentType(type: string): string {
  if (ALLOWED_CONTENT_TYPES.has(type)) return type
  if (type === 'audio') return 'audio'
  if (type === 'video' || type === 'ig_reel' || type === 'reel') return 'video'
  if (type === 'image' || type === 'story_mention' || type === 'share') return 'image'
  if (type === 'file') return 'document'
  return 'text'
}

function extFromMime(mime: string): string {
  const map: Record<string, string> = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp', 'image/gif': 'gif',
    'video/mp4': 'mp4', 'audio/mp4': 'm4a', 'audio/mpeg': 'mp3', 'audio/ogg': 'ogg',
    'application/pdf': 'pdf',
  }
  return map[mime.split(';')[0].trim()] || 'bin'
}

/**
 * Persist a media attachment into the public chat-media bucket so it
 * survives Meta's short-lived CDN urls. Best-effort: falls back to the
 * raw CDN url on any failure.
 */
async function persistMedia(url: string, accountId: string, mid: string): Promise<string> {
  try {
    const { buffer, contentType } = await downloadInstagramMedia(url)
    const mime = contentType || 'application/octet-stream'
    const path = `account-${accountId}/ig-${mid}.${extFromMime(mime)}`
    const { error } = await supabaseAdmin()
      .storage.from('chat-media')
      .upload(path, buffer, { contentType: mime, upsert: true })
    if (!error) {
      const { data } = supabaseAdmin().storage.from('chat-media').getPublicUrl(path)
      if (data?.publicUrl) return data.publicUrl
    }
  } catch (e) {
    console.warn('[ig-webhook] media persist failed, using CDN url:', e instanceof Error ? e.message : e)
  }
  return url
}

interface ParsedContent {
  contentText: string | null
  mediaUrl: string | null
  contentType: string
}

async function parseMessageContent(
  message: IgMessage,
  accountId: string,
  accessToken: string,
): Promise<ParsedContent> {
  // Story reply / mention — resolve the story media for context.
  if (message.reply_to?.story?.id || message.reply_to?.story?.url) {
    const storyUrl =
      message.reply_to.story.url ||
      (await fetchStoryById(message.reply_to.story.id!, accessToken).then((s) => s?.mediaUrl)) ||
      null
    const mediaUrl = storyUrl ? await persistMedia(storyUrl, accountId, message.mid) : null
    return {
      contentText: message.text || '[Resposta ao story]',
      mediaUrl,
      contentType: 'image',
    }
  }

  const att = message.attachments?.[0]
  if (att?.payload?.url) {
    const mediaUrl = await persistMedia(att.payload.url, accountId, message.mid)
    return { contentText: message.text || att.payload.title || null, mediaUrl, contentType: mapContentType(att.type) }
  }

  if (message.is_unsupported) {
    return { contentText: '[Mensagem não suportada]', mediaUrl: null, contentType: 'text' }
  }

  return { contentText: message.text ?? null, mediaUrl: null, contentType: 'text' }
}

async function resolveCustomer(
  igsid: string,
  ch: ResolvedChannel,
  accessToken: string,
) {
  // Fetch the public profile only when we don't yet have a contact link
  // (first contact). Privacy (error 230) -> name stays the IGSID.
  const { data: existingLink } = await supabaseAdmin()
    .from('contact_inboxes')
    .select('id')
    .eq('inbox_id', ch.inboxId)
    .eq('source_id', igsid)
    .maybeSingle()

  let name = ''
  if (!existingLink) {
    const profile = await getInstagramUserProfile(igsid, accessToken)
    name = profile?.name || profile?.username || ''
  }

  return resolveContactInbox({
    db: supabaseAdmin(),
    inboxId: ch.inboxId,
    accountId: ch.accountId,
    channelType: 'instagram',
    sourceId: igsid,
    name,
    userId: ch.config.user_id,
  })
}

async function storeInbound(
  event: IgMessagingEvent,
  message: IgMessage,
  ch: ResolvedChannel,
  accessToken: string,
) {
  const igsid = event.sender.id

  const outcome = await resolveCustomer(igsid, ch, accessToken)
  if (!outcome) return
  const contact = outcome.contact

  const conversation = await findOrCreateConversation({
    db: supabaseAdmin(),
    accountId: ch.accountId,
    inboxId: ch.inboxId,
    userId: ch.config.user_id,
    contactId: contact.id,
    contactInboxId: outcome.contactInbox.id,
  })
  if (!conversation) return

  // Dedup: Meta redelivers. Skip if we already stored this mid.
  if (await messageAlreadyStored(message.mid)) return

  const { contentText, mediaUrl, contentType } = await parseMessageContent(message, ch.accountId, accessToken)

  // Swipe-reply to one of our messages.
  let replyToInternalId: string | null = null
  if (message.reply_to?.mid) {
    const { data } = await supabaseAdmin()
      .from('messages')
      .select('id')
      .eq('message_id', message.reply_to.mid)
      .eq('conversation_id', conversation.id)
      .maybeSingle()
    replyToInternalId = data?.id ?? null
  }

  const { count: priorCustomerMsgCount } = await supabaseAdmin()
    .from('messages')
    .select('id', { count: 'exact', head: true })
    .eq('conversation_id', conversation.id)
    .eq('sender_type', 'customer')
  const isFirstInboundMessage = (priorCustomerMsgCount ?? 0) === 0

  const createdAt = event.timestamp
    ? new Date(event.timestamp).toISOString()
    : new Date().toISOString()

  const { error: msgError } = await supabaseAdmin().from('messages').insert({
    conversation_id: conversation.id,
    sender_type: 'customer',
    content_type: contentType,
    content_text: contentText,
    media_url: mediaUrl,
    message_id: message.mid,
    status: 'delivered',
    created_at: createdAt,
    reply_to_message_id: replyToInternalId,
  })
  if (msgError) {
    if (isUniqueViolation(msgError)) return // racing redelivery won
    console.error('[ig-webhook] message insert failed:', msgError)
    return
  }

  await supabaseAdmin()
    .from('conversations')
    .update({
      last_message_text: contentText || '[mídia]',
      last_message_at: new Date().toISOString(),
      unread_count: (conversation.unread_count || 0) + 1,
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversation.id)

  // Flow + automation dispatch — identical contract to the WhatsApp webhook.
  const flowResult = await dispatchInboundToFlows({
    accountId: ch.accountId,
    userId: ch.config.user_id,
    contactId: contact.id,
    conversationId: conversation.id,
    message: { kind: 'text', text: contentText ?? '', meta_message_id: message.mid },
    isFirstInboundMessage,
  })

  const triggers: (
    | 'new_contact_created'
    | 'first_inbound_message'
    | 'new_message_received'
    | 'keyword_match'
  )[] = []
  if (!flowResult.consumed) triggers.push('new_message_received', 'keyword_match')
  if (outcome.contactWasCreated) triggers.unshift('new_contact_created')
  if (isFirstInboundMessage) triggers.unshift('first_inbound_message')
  for (const triggerType of triggers) {
    runAutomationsForTrigger({
      accountId: ch.accountId,
      triggerType,
      contactId: contact.id,
      context: { message_text: contentText ?? '', conversation_id: conversation.id },
    }).catch((err) => console.error('[ig-webhook] automation dispatch failed:', err))
  }
}

async function storeOutboundEcho(
  event: IgMessagingEvent,
  message: IgMessage,
  ch: ResolvedChannel,
  accessToken: string,
) {
  // On an echo the customer is the RECIPIENT (we're the sender).
  const igsid = event.recipient.id
  if (await messageAlreadyStored(message.mid)) return

  const outcome = await resolveCustomer(igsid, ch, accessToken)
  if (!outcome) return
  const conversation = await findOrCreateConversation({
    db: supabaseAdmin(),
    accountId: ch.accountId,
    inboxId: ch.inboxId,
    userId: ch.config.user_id,
    contactId: outcome.contact.id,
    contactInboxId: outcome.contactInbox.id,
  })
  if (!conversation) return

  const { contentText, mediaUrl, contentType } = await parseMessageContent(message, ch.accountId, accessToken)
  const createdAt = event.timestamp ? new Date(event.timestamp).toISOString() : new Date().toISOString()

  const { error } = await supabaseAdmin().from('messages').insert({
    conversation_id: conversation.id,
    sender_type: 'agent',
    content_type: contentType,
    content_text: contentText,
    media_url: mediaUrl,
    message_id: message.mid,
    status: 'sent',
    created_at: createdAt,
  })
  if (error) {
    if (isUniqueViolation(error)) return
    console.error('[ig-webhook] echo insert failed:', error)
    return
  }

  // Surface in the inbox preview, but never bump unread (it's outbound).
  await supabaseAdmin()
    .from('conversations')
    .update({
      last_message_text: contentText || '[mídia]',
      last_message_at: createdAt,
      updated_at: new Date().toISOString(),
    })
    .eq('id', conversation.id)
}

async function handleReaction(event: IgMessagingEvent, ch: ResolvedChannel) {
  const reaction = event.reaction!
  const igsid = event.sender.id

  // Resolve the contact + conversation so the reaction is account-correct.
  const { data: link } = await supabaseAdmin()
    .from('contact_inboxes')
    .select('contact_id')
    .eq('inbox_id', ch.inboxId)
    .eq('source_id', igsid)
    .maybeSingle()
  if (!link) return // reaction before any message — nothing to attach to

  const { data: conv } = await supabaseAdmin()
    .from('conversations')
    .select('id')
    .eq('inbox_id', ch.inboxId)
    .eq('contact_id', link.contact_id)
    .maybeSingle()
  if (!conv) return

  // The reacted-to message, scoped to this conversation.
  const { data: target } = await supabaseAdmin()
    .from('messages')
    .select('id')
    .eq('message_id', reaction.mid)
    .eq('conversation_id', conv.id)
    .maybeSingle()
  if (!target) return

  if (reaction.action === 'unreact') {
    await supabaseAdmin()
      .from('message_reactions')
      .delete()
      .eq('message_id', target.id)
      .eq('actor_type', 'customer')
      .eq('actor_id', link.contact_id)
    return
  }

  await supabaseAdmin()
    .from('message_reactions')
    .upsert(
      {
        message_id: target.id,
        conversation_id: conv.id,
        actor_type: 'customer',
        actor_id: link.contact_id,
        emoji: reaction.emoji || reaction.reaction || '❤️',
      },
      { onConflict: 'message_id,actor_type,actor_id' },
    )
}
