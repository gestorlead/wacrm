// ============================================================
// Deal value is derived from its line items (migration 036): a deal no
// longer stores a flat `value`. Every place that used to read
// `deal.value` now sums the attached products as Σ(quantity × unit_price),
// in the account's default currency.
//
// Intentionally structural-typed (not tied to the full Deal interface) so
// both client components and the server-side dashboard aggregations can
// share it after embedding `deal_products(quantity, unit_price)`.
// ============================================================

export interface LineItemLike {
  quantity: number | null;
  unit_price: number | null;
}

export interface DealWithItems {
  deal_products?: LineItemLike[] | null;
}

/** Sum of a deal's line items: Σ(quantity × unit_price). */
export function dealTotal(deal: DealWithItems): number {
  const items = deal.deal_products ?? [];
  return items.reduce(
    (sum, item) => sum + Number(item.quantity ?? 0) * Number(item.unit_price ?? 0),
    0,
  );
}
