import { NextResponse } from 'next/server'
import { createClient } from '@/lib/supabase/server'
import { supabaseAdmin } from '@/lib/flows/admin-client'
import { getInboxChannel } from '@/lib/channels/config-resolver'
import { getFreshAccessToken } from '@/lib/instagram/token'
import {
  sendInstagramMessage,
  sendInstagramMedia,
  type IgMediaKind,
} from '@/lib/instagram/meta-api'
import { checkRateLimit, rateLimitResponse, RATE_LIMITS } from '@/lib/rate-limit'

/** Extract Meta's numeric error code from a message, if present. */
function parseMetaErrorCode(message: string): string | null {
  const m = message.match(/\(#(\d+)\)/) || message.match(/\bcode[:\s]+(\d+)/i)
  return m ? m[1] : null
}

const MEDIA_KINDS = ['image', 'video', 'audio'] as const
const TWENTY_FOUR_HOURS = 24 * 60 * 60 * 1000

export async function POST(request: Request) {
  try {
    const supabase = await createClient()
    const {
      data: { user },
      error: authError,
    } = await supabase.auth.getUser()
    if (authError || !user) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
    }

    const limit = checkRateLimit(`send:${user.id}`, RATE_LIMITS.send)
    if (!limit.success) return rateLimitResponse(limit)

    const { data: profile } = await supabase
      .from('profiles')
      .select('account_id')
      .eq('user_id', user.id)
      .maybeSingle()
    const accountId = profile?.account_id as string | undefined
    if (!accountId) {
      return NextResponse.json({ error: 'Your profile is not linked to an account.' }, { status: 403 })
    }

    const body = await request.json()
    const { conversation_id, message_type, content_text, media_url } = body

    if (!conversation_id || !message_type) {
      return NextResponse.json({ error: 'conversation_id and message_type are required' }, { status: 400 })
    }
    const isMediaKind = (MEDIA_KINDS as readonly string[]).includes(message_type)
    if (message_type !== 'text' && !isMediaKind) {
      return NextResponse.json({ error: `Unsupported message_type "${message_type}"` }, { status: 400 })
    }
    if (message_type === 'text' && !content_text) {
      return NextResponse.json({ error: 'content_text is required for text messages' }, { status: 400 })
    }
    if (isMediaKind && !media_url) {
      return NextResponse.json({ error: `media_url is required for ${message_type} messages` }, { status: 400 })
    }

    // Load the conversation (account-scoped) + the contact_inbox holding
    // the recipient IGSID.
    const { data: conversation, error: convError } = await supabase
      .from('conversations')
      .select('*')
      .eq('id', conversation_id)
      .eq('account_id', accountId)
      .single()
    if (convError || !conversation) {
      return NextResponse.json({ error: 'Conversation not found' }, { status: 404 })
    }

    const { data: contactInbox } = await supabase
      .from('contact_inboxes')
      .select('source_id')
      .eq('inbox_id', conversation.inbox_id)
      .eq('contact_id', conversation.contact_id)
      .maybeSingle()
    const recipientId = contactInbox?.source_id as string | undefined
    if (!recipientId) {
      return NextResponse.json({ error: 'Instagram recipient (IGSID) not found for this conversation.' }, { status: 400 })
    }

    // Resolve the Instagram channel config from the conversation's inbox.
    const channel = await getInboxChannel(supabase, conversation.inbox_id)
    if (!channel || channel.channelType !== 'instagram') {
      return NextResponse.json(
        { error: 'Instagram is not configured for this inbox.' },
        { status: 400 },
      )
    }
    const config = channel.config

    // Refresh the long-lived token if it's near expiry (returns the token
    // to use now). Uses the admin client so the refresh write isn't gated
    // by the caller's RLS.
    const accessToken = await getFreshAccessToken(supabaseAdmin(), config)

    // 24h standard messaging window. Outside it, Instagram still allows a
    // reply tagged HUMAN_AGENT (up to 7 days), so we don't hard-block —
    // we send with the tag instead (mirrors Chatwoot's merge_human_agent_tag).
    const { data: lastInbound } = await supabase
      .from('messages')
      .select('created_at')
      .eq('conversation_id', conversation_id)
      .eq('sender_type', 'customer')
      .order('created_at', { ascending: false })
      .limit(1)
      .maybeSingle()
    const withinWindow =
      !!lastInbound && Date.now() - new Date(lastInbound.created_at).getTime() < TWENTY_FOUR_HOURS
    const humanAgentTag = !withinWindow

    // Pre-insert the outbound row as 'sending'.
    const { data: messageRecord, error: preInsertError } = await supabase
      .from('messages')
      .insert({
        conversation_id,
        sender_type: 'agent',
        content_type: message_type,
        content_text: content_text || null,
        media_url: media_url || null,
        message_id: null,
        status: 'sending',
      })
      .select()
      .single()
    if (preInsertError || !messageRecord) {
      console.error('[instagram/send] pre-insert failed:', preInsertError)
      return NextResponse.json({ error: 'Failed to save the message before sending.' }, { status: 500 })
    }

    await supabase
      .from('conversations')
      .update({
        last_message_text: content_text || `[${message_type}]`,
        last_message_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', conversation_id)

    let igMessageId = ''
    try {
      const common = {
        instagramId: config.instagram_id,
        accessToken,
        recipientId,
        humanAgentTag,
      }
      const result = isMediaKind
        ? await sendInstagramMedia({ ...common, kind: message_type as IgMediaKind, link: media_url })
        : await sendInstagramMessage({ ...common, text: content_text })
      igMessageId = result.messageId
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown Instagram API error'
      const metaCode = (err as { metaCode?: number }).metaCode
      console.error('[instagram/send] send failed:', message)

      // Code 190 = invalid/expired token -> mark the channel disconnected
      // so the UI prompts a reconnect.
      if (metaCode === 190) {
        await supabaseAdmin()
          .from('instagram_config')
          .update({ status: 'disconnected', last_error: message })
          .eq('id', config.id)
      }

      await supabase
        .from('messages')
        .update({ status: 'failed', error_code: parseMetaErrorCode(message), error_text: message })
        .eq('id', messageRecord.id)
      return NextResponse.json(
        { error: `Instagram API error: ${message}`, message_id: messageRecord.id },
        { status: 502 },
      )
    }

    const { error: finalizeError } = await supabase
      .from('messages')
      .update({ status: 'sent', message_id: igMessageId })
      .eq('id', messageRecord.id)
    if (finalizeError) {
      console.error('[instagram/send] finalize failed:', finalizeError)
    }

    return NextResponse.json({ success: true, message_id: messageRecord.id, ig_message_id: igMessageId })
  } catch (err) {
    console.error('[instagram/send] unexpected error:', err)
    return NextResponse.json(
      { error: err instanceof Error ? err.message : 'Internal server error' },
      { status: 500 },
    )
  }
}
