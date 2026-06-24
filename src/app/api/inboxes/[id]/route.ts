// ============================================================
// /api/inboxes/[id]
//
// GET    — single inbox (members of it / admins).
// PATCH  — rename / recolour (admin+).
// DELETE — remove the inbox and its channel config + conversations
//          (admin+). CASCADE on whatsapp_config / conversations FKs
//          does the cleanup.
// ============================================================

import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const ctx = await getCurrentAccount()
    // RLS (can_access_inbox) gates visibility.
    const { data: inbox, error } = await ctx.supabase
      .from('inboxes')
      .select('id, account_id, name, channel_type, color, created_at')
      .eq('id', id)
      .maybeSingle()
    if (error || !inbox) {
      return NextResponse.json({ error: 'Inbox not found' }, { status: 404 })
    }
    return NextResponse.json({ inbox })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const ctx = await requireRole('admin')
    const body = await request.json()

    const patch: Record<string, unknown> = {}
    if (typeof body.name === 'string' && body.name.trim()) patch.name = body.name.trim()
    if (typeof body.color === 'string' || body.color === null) patch.color = body.color
    if (Object.keys(patch).length === 0) {
      return NextResponse.json({ error: 'Nothing to update' }, { status: 400 })
    }
    patch.updated_at = new Date().toISOString()

    // RLS (inboxes_update = admin of the inbox's account) enforces tenancy.
    const { data: inbox, error } = await ctx.supabase
      .from('inboxes')
      .update(patch)
      .eq('id', id)
      .select('id, name, channel_type, color, created_at')
      .single()
    if (error || !inbox) {
      return NextResponse.json({ error: 'Failed to update inbox' }, { status: 500 })
    }
    return NextResponse.json({ inbox })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const ctx = await requireRole('admin')

    const { error } = await ctx.supabase.from('inboxes').delete().eq('id', id)
    if (error) {
      console.error('[DELETE /api/inboxes/[id]] failed:', error)
      return NextResponse.json({ error: 'Failed to delete inbox' }, { status: 500 })
    }
    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
