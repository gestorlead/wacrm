// ============================================================
// /api/quick-replies/[id]
//
// PUT    — update a quick reply's short_code / content.
// DELETE — remove a quick reply.
//
// RLS (migration 035) limits both to the row's owner (personal) or an
// account admin (shared), so these handlers only validate input and map
// the duplicate short_code to a 409.
// ============================================================

import { NextResponse } from 'next/server'

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'

const PG_UNIQUE_VIOLATION = '23505'
const SHORT_CODE_MAX = 100
const CONTENT_MAX = 5000

// Loose UUID check — reject malformed ids before they reach Supabase.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function PUT(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params
    if (!UUID_RE.test(id)) {
      return NextResponse.json({ error: 'Invalid id' }, { status: 400 })
    }

    const ctx = await getCurrentAccount()
    const body = await request.json().catch(() => ({}))

    const shortCode = typeof body.short_code === 'string' ? body.short_code.trim() : ''
    const content = typeof body.content === 'string' ? body.content.trim() : ''

    if (!shortCode || !content) {
      return NextResponse.json(
        { error: 'short_code and content are required' },
        { status: 400 },
      )
    }
    if (shortCode.length > SHORT_CODE_MAX || content.length > CONTENT_MAX) {
      return NextResponse.json({ error: 'short_code or content is too long' }, { status: 400 })
    }

    const { data, error } = await ctx.supabase
      .from('quick_replies')
      .update({ short_code: shortCode, content, updated_at: new Date().toISOString() })
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .select('id, account_id, owner_user_id, short_code, content, created_by, created_at, updated_at')
      .maybeSingle()

    if (error) {
      if (error.code === PG_UNIQUE_VIOLATION) {
        return NextResponse.json(
          { error: `A quick reply with short code "${shortCode}" already exists.` },
          { status: 409 },
        )
      }
      console.error('[PUT /api/quick-replies/[id]] update error:', error)
      return NextResponse.json({ error: 'Failed to update quick reply' }, { status: 500 })
    }
    // No row returned ⇒ not found OR RLS hid it (not the owner/admin).
    if (!data) {
      return NextResponse.json({ error: 'Quick reply not found' }, { status: 404 })
    }

    return NextResponse.json({ quickReply: data })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await context.params
    if (!UUID_RE.test(id)) {
      return NextResponse.json({ error: 'Invalid id' }, { status: 400 })
    }

    const ctx = await getCurrentAccount()

    const { data, error } = await ctx.supabase
      .from('quick_replies')
      .delete()
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .select('id')
      .maybeSingle()

    if (error) {
      console.error('[DELETE /api/quick-replies/[id]] delete error:', error)
      return NextResponse.json({ error: 'Failed to delete quick reply' }, { status: 500 })
    }
    if (!data) {
      return NextResponse.json({ error: 'Quick reply not found' }, { status: 404 })
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
