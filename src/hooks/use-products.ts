import { useCallback, useEffect, useState } from "react";

import type { Product } from "@/types";

interface UseProductsOptions {
  /** When true, only non-archived products are returned (deal picker). */
  activeOnly?: boolean;
}

/**
 * Loads the account's products/services catalog (migration 036). Thin
 * wrapper over GET /api/products — RLS scopes the rows server-side.
 * Fetches once on mount; `refetch` lets callers refresh after a CRUD
 * change elsewhere. Errors are non-fatal (the list just stays empty).
 */
export function useProducts({ activeOnly = false }: UseProductsOptions = {}) {
  const [products, setProducts] = useState<Product[]>([]);
  const [loading, setLoading] = useState(true);

  const refetch = useCallback(async () => {
    try {
      const res = await fetch(`/api/products${activeOnly ? "?active=true" : ""}`);
      if (!res.ok) return;
      const data = (await res.json()) as { products?: Product[] };
      setProducts(data.products ?? []);
    } catch {
      // Non-fatal.
    } finally {
      setLoading(false);
    }
  }, [activeOnly]);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return { products, loading, refetch };
}
