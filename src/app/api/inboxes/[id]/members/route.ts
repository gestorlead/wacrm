// ============================================================
// /api/inboxes/[id]/members
//
// GET    — list the agents assigned to this inbox (any account member).
// POST   — set the inbox's members (admin+). Body: { user_ids: string[] }.
//          Replaces the membership set with the given users (all must
//          belong to the caller's account).
// DELETE — remove one member (admin+). Body: { user_id }.
// ============================================================

import { NextResponse } from 'next/server'
import { getCurrentAccount, requireRole, toErrorResponse } from '@/lib/auth/account'

/** Confirm the inbox belongs to the caller's account (defense-in-depth
 *  on top of RLS) and return it, or null. */
async function loadInbox(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: any,
  inboxId: string,
  accountId: string,
) {
  const { data } = await supabase
    .from('inboxes')
    .select('id, account_id')
    .eq('id', inboxId)
    .eq('account_id', accountId)
    .maybeSingle()
  return data ?? null
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const ctx = await getCurrentAccount()

    const { data: members, error } = await ctx.supabase
      .from('inbox_members')
      .select('user_id, created_at, profile:profiles!inbox_members_user_id_fkey(full_name, avatar_url, account_role)')
      .eq('inbox_id', id)
    if (error) {
      // The FK-name join above is best-effort; fall back to bare rows.
      const { data: bare } = await ctx.supabase
        .from('inbox_members')
        .select('user_id, created_at')
        .eq('inbox_id', id)
      return NextResponse.json({ members: bare ?? [] })
    }
    return NextResponse.json({ members: members ?? [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const ctx = await requireRole('admin')
    const body = await request.json()
    const userIds: unknown = body.user_ids

    if (!Array.isArray(userIds) || userIds.some((u) => typeof u !== 'string')) {
      return NextResponse.json({ error: 'user_ids must be an array of strings' }, { status: 400 })
    }

    const inbox = await loadInbox(ctx.supabase, id, ctx.accountId)
    if (!inbox) return NextResponse.json({ error: 'Inbox not found' }, { status: 404 })

    // Only allow users who are members of this account.
    const { data: accountMembers } = await ctx.supabase
      .from('profiles')
      .select('user_id')
      .eq('account_id', ctx.accountId)
    const allowed = new Set((accountMembers ?? []).map((p: { user_id: string }) => p.user_id))
    const targets = (userIds as string[]).filter((u) => allowed.has(u))

    // Replace the membership set: clear, then insert the targets. An admin
    // settings action, so the brief empty window between the two is fine.
    const { error: delErr } = await ctx.supabase
      .from('inbox_members')
      .delete()
      .eq('inbox_id', id)
    if (delErr) {
      console.error('[POST /api/inboxes/[id]/members] clear failed:', delErr)
      return NextResponse.json({ error: 'Failed to update members' }, { status: 500 })
    }

    if (targets.length) {
      const rows = targets.map((user_id) => ({ inbox_id: id, user_id }))
      const { error: insErr } = await ctx.supabase.from('inbox_members').insert(rows)
      if (insErr) {
        console.error('[POST /api/inboxes/[id]/members] insert failed:', insErr)
        return NextResponse.json({ error: 'Failed to update members' }, { status: 500 })
      }
    }

    return NextResponse.json({ success: true, member_count: targets.length })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const ctx = await requireRole('admin')
    const body = await request.json().catch(() => ({}))
    const userId = body.user_id
    if (typeof userId !== 'string') {
      return NextResponse.json({ error: 'user_id is required' }, { status: 400 })
    }

    const { error } = await ctx.supabase
      .from('inbox_members')
      .delete()
      .eq('inbox_id', id)
      .eq('user_id', userId)
    if (error) {
      return NextResponse.json({ error: 'Failed to remove member' }, { status: 500 })
    }
    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
