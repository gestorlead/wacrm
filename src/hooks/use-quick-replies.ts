import { useCallback, useEffect, useState } from "react";

import type { QuickReply } from "@/types";

/**
 * Loads the quick replies ("mensagens prontas") the current user can see
 * (account-shared + their own personal rows) for use by the composer's
 * `/` picker. Thin wrapper over GET /api/quick-replies — RLS scopes the
 * rows server-side. Fetches once on mount; `refetch` lets callers refresh
 * after a CRUD change elsewhere.
 */
export function useQuickReplies() {
  const [quickReplies, setQuickReplies] = useState<QuickReply[]>([]);
  const [loading, setLoading] = useState(true);

  const refetch = useCallback(async () => {
    try {
      const res = await fetch("/api/quick-replies");
      if (!res.ok) return;
      const data = (await res.json()) as { quickReplies?: QuickReply[] };
      setQuickReplies(data.quickReplies ?? []);
    } catch {
      // Non-fatal — the picker just stays empty.
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refetch();
  }, [refetch]);

  return { quickReplies, loading, refetch };
}
