// ============================================================
// /api/products/[id]
//
// PUT    — update a product's fields. Admin-only (RLS, migration 036).
// DELETE — remove a product. Blocked with 409 if it's still attached to
//          a deal (deal_products FK is ON DELETE RESTRICT) — archive it
//          (active=false) instead.
// ============================================================

import { NextResponse } from 'next/server'

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import { parseProductBody } from '../route'

const PG_FK_VIOLATION = '23503'

// Loose UUID check — reject malformed ids before they reach Supabase.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

const COLUMNS =
  'id, account_id, name, description, type, price, billing_period, active, created_by, created_at, updated_at'

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
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>

    const parsed = parseProductBody(body)
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 })
    }

    const { data, error } = await ctx.supabase
      .from('products')
      .update(parsed.fields)
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .select(COLUMNS)
      .maybeSingle()

    if (error) {
      console.error('[PUT /api/products/[id]] update error:', error)
      return NextResponse.json({ error: 'Failed to update product' }, { status: 500 })
    }
    // No row returned ⇒ not found OR RLS hid it (not an admin).
    if (!data) {
      return NextResponse.json({ error: 'Product not found' }, { status: 404 })
    }

    return NextResponse.json({ product: data })
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
      .from('products')
      .delete()
      .eq('id', id)
      .eq('account_id', ctx.accountId)
      .select('id')
      .maybeSingle()

    if (error) {
      // Still referenced by a deal line item (ON DELETE RESTRICT).
      if (error.code === PG_FK_VIOLATION) {
        return NextResponse.json(
          { error: 'This product is used in a deal. Archive it instead of deleting.' },
          { status: 409 },
        )
      }
      console.error('[DELETE /api/products/[id]] delete error:', error)
      return NextResponse.json({ error: 'Failed to delete product' }, { status: 500 })
    }
    if (!data) {
      return NextResponse.json({ error: 'Product not found' }, { status: 404 })
    }

    return NextResponse.json({ success: true })
  } catch (err) {
    return toErrorResponse(err)
  }
}
