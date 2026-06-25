// ============================================================
// /api/quick-replies
//
// GET  — list the quick replies visible to the caller (shared rows +
//        their own personal rows), ordered by short_code. Optional
//        `?search=` filters short_code/content (case-insensitive).
// POST — create a quick reply (migration 035). `scope: 'shared'` needs
//        admin; `scope: 'personal'` is owned by the caller. RLS + the
//        partial unique indexes enforce permissions/uniqueness; we map a
//        duplicate short_code to a friendly 409.
//
// RLS does the heavy lifting, so these handlers stay thin.
// ============================================================

import { NextResponse } from 'next/server'

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'

/** Postgres unique_violation — a duplicate short_code within a scope. */
const PG_UNIQUE_VIOLATION = '23505'

const SHORT_CODE_MAX = 100
const CONTENT_MAX = 5000

export async function GET(request: Request) {
  try {
    const ctx = await getCurrentAccount()
    const search = new URL(request.url).searchParams.get('search')?.trim()

    let query = ctx.supabase
      .from('quick_replies')
      .select('id, account_id, owner_user_id, short_code, content, created_by, created_at, updated_at')
      .eq('account_id', ctx.accountId)
      .order('short_code', { ascending: true })

    if (search) {
      // Escape PostgREST `or` filter metacharacters in the user term.
      const term = search.replace(/[,()]/g, ' ')
      query = query.or(`short_code.ilike.%${term}%,content.ilike.%${term}%`)
    }

    const { data, error } = await query
    if (error) {
      console.error('[GET /api/quick-replies] fetch error:', error)
      return NextResponse.json({ error: 'Failed to load quick replies' }, { status: 500 })
    }

    return NextResponse.json({ quickReplies: data ?? [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await getCurrentAccount()
    const body = await request.json().catch(() => ({}))

    const shortCode = typeof body.short_code === 'string' ? body.short_code.trim() : ''
    const content = typeof body.content === 'string' ? body.content.trim() : ''
    const scope = body.scope === 'personal' ? 'personal' : 'shared'

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
      .insert({
        account_id: ctx.accountId,
        owner_user_id: scope === 'personal' ? ctx.userId : null,
        short_code: shortCode,
        content,
        created_by: ctx.userId,
      })
      .select('id, account_id, owner_user_id, short_code, content, created_by, created_at, updated_at')
      .single()

    if (error) {
      if (error.code === PG_UNIQUE_VIOLATION) {
        return NextResponse.json(
          { error: `A ${scope} quick reply with short code "${shortCode}" already exists.` },
          { status: 409 },
        )
      }
      // RLS rejection (e.g. agent creating a shared row) surfaces as an
      // insert that violates the WITH CHECK — Supabase reports 42501.
      if (error.code === '42501') {
        return NextResponse.json(
          { error: 'You do not have permission to create a shared quick reply.' },
          { status: 403 },
        )
      }
      console.error('[POST /api/quick-replies] insert error:', error)
      return NextResponse.json({ error: 'Failed to create quick reply' }, { status: 500 })
    }

    return NextResponse.json({ quickReply: data }, { status: 201 })
  } catch (err) {
    return toErrorResponse(err)
  }
}
