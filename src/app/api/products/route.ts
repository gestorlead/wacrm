// ============================================================
// /api/products
//
// GET  — list the account's products/services, ordered by name.
//        Optional `?search=` filters name/description (case-insensitive).
//        Pass `?active=true` to return only non-archived products (used
//        by the deal line-item picker).
// POST — create a product. Admin-only (RLS, migration 036). Validates the
//        one-time vs subscription shape (subscriptions require a
//        billing_period; one-time must not have one).
//
// RLS does the heavy lifting, so these handlers stay thin.
// ============================================================

import { NextResponse } from 'next/server'

import { getCurrentAccount, toErrorResponse } from '@/lib/auth/account'
import type { BillingPeriod, ProductType } from '@/types'

const NAME_MAX = 200
const DESCRIPTION_MAX = 2000

const PRODUCT_TYPES: ProductType[] = ['one_time', 'subscription']
const BILLING_PERIODS: BillingPeriod[] = ['monthly', 'quarterly', 'semiannual', 'annual']

const COLUMNS =
  'id, account_id, name, description, type, price, billing_period, active, created_by, created_at, updated_at'

export async function GET(request: Request) {
  try {
    const ctx = await getCurrentAccount()
    const params = new URL(request.url).searchParams
    const search = params.get('search')?.trim()
    const activeOnly = params.get('active') === 'true'

    let query = ctx.supabase
      .from('products')
      .select(COLUMNS)
      .eq('account_id', ctx.accountId)
      .order('name', { ascending: true })

    if (activeOnly) query = query.eq('active', true)

    if (search) {
      // Escape PostgREST `or` filter metacharacters in the user term.
      const term = search.replace(/[,()]/g, ' ')
      query = query.or(`name.ilike.%${term}%,description.ilike.%${term}%`)
    }

    const { data, error } = await query
    if (error) {
      console.error('[GET /api/products] fetch error:', error)
      return NextResponse.json({ error: 'Failed to load products' }, { status: 500 })
    }

    return NextResponse.json({ products: data ?? [] })
  } catch (err) {
    return toErrorResponse(err)
  }
}

/**
 * Validate + normalize a product body shared by POST and PUT. Returns
 * either a normalized field object or an error message.
 */
export function parseProductBody(body: Record<string, unknown>):
  | { ok: true; fields: { name: string; description: string | null; type: ProductType; price: number; billing_period: BillingPeriod | null; active: boolean } }
  | { ok: false; error: string } {
  const name = typeof body.name === 'string' ? body.name.trim() : ''
  const description = typeof body.description === 'string' ? body.description.trim() : ''
  const type = PRODUCT_TYPES.includes(body.type as ProductType)
    ? (body.type as ProductType)
    : 'one_time'
  const price = Number(body.price)
  const billingPeriod = BILLING_PERIODS.includes(body.billing_period as BillingPeriod)
    ? (body.billing_period as BillingPeriod)
    : null
  const active = typeof body.active === 'boolean' ? body.active : true

  if (!name) return { ok: false, error: 'Name is required' }
  if (name.length > NAME_MAX) return { ok: false, error: 'Name is too long' }
  if (description.length > DESCRIPTION_MAX) return { ok: false, error: 'Description is too long' }
  if (!Number.isFinite(price) || price < 0) return { ok: false, error: 'Price must be a non-negative number' }
  if (type === 'subscription' && !billingPeriod) {
    return { ok: false, error: 'Subscriptions require a billing period' }
  }

  return {
    ok: true,
    fields: {
      name,
      description: description || null,
      type,
      price,
      // Coherence: one-time products never carry a billing period.
      billing_period: type === 'subscription' ? billingPeriod : null,
      active,
    },
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await getCurrentAccount()
    const body = (await request.json().catch(() => ({}))) as Record<string, unknown>

    const parsed = parseProductBody(body)
    if (!parsed.ok) {
      return NextResponse.json({ error: parsed.error }, { status: 400 })
    }

    const { data, error } = await ctx.supabase
      .from('products')
      .insert({
        account_id: ctx.accountId,
        created_by: ctx.userId,
        ...parsed.fields,
      })
      .select(COLUMNS)
      .single()

    if (error) {
      // RLS rejection (non-admin) surfaces as a WITH CHECK violation.
      if (error.code === '42501') {
        return NextResponse.json(
          { error: 'You do not have permission to create products.' },
          { status: 403 },
        )
      }
      console.error('[POST /api/products] insert error:', error)
      return NextResponse.json({ error: 'Failed to create product' }, { status: 500 })
    }

    return NextResponse.json({ product: data }, { status: 201 })
  } catch (err) {
    return toErrorResponse(err)
  }
}
