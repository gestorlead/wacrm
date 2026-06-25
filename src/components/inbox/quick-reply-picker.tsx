"use client";

import { useEffect, useRef } from "react";
import { Zap } from "lucide-react";

import { cn } from "@/lib/utils";
import type { QuickReply } from "@/types";

interface QuickReplyPickerProps {
  /** Filtered, ordered list to show. Empty ⇒ nothing rendered. */
  items: QuickReply[];
  /** Index of the highlighted row (keyboard-driven from the composer). */
  activeIndex: number;
  /** User picked a row (click or Enter). */
  onSelect: (item: QuickReply) => void;
  /** Pointer moved over a row — keeps keyboard/mouse highlight in sync. */
  onActiveIndexChange: (index: number) => void;
}

/**
 * Inline popover listing quick replies that match the `/<query>` token the
 * agent is typing. Purely presentational: the composer owns focus and drives
 * the highlighted index + Enter/Escape via the textarea's keydown handler,
 * so this never steals focus from the input.
 *
 * Positioned absolutely above the composer (the parent is `relative`).
 */
export function QuickReplyPicker({
  items,
  activeIndex,
  onSelect,
  onActiveIndexChange,
}: QuickReplyPickerProps) {
  const listRef = useRef<HTMLUListElement>(null);

  // Keep the highlighted row in view as the agent arrows through a long list.
  useEffect(() => {
    const el = listRef.current?.children[activeIndex] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  if (items.length === 0) return null;

  return (
    <div className="absolute bottom-full left-0 right-0 z-20 mb-2 px-3">
      <div className="overflow-hidden rounded-xl border border-border bg-popover shadow-lg">
        <div className="flex items-center gap-1.5 border-b border-border px-3 py-1.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
          <Zap className="h-3 w-3" />
          Quick replies
        </div>
        <ul ref={listRef} className="max-h-56 overflow-y-auto py-1">
          {items.map((item, i) => (
            <li key={item.id}>
              <button
                type="button"
                // onMouseDown (not onClick) so the textarea doesn't blur
                // before the selection lands.
                onMouseDown={(e) => {
                  e.preventDefault();
                  onSelect(item);
                }}
                onMouseEnter={() => onActiveIndexChange(i)}
                className={cn(
                  "flex w-full flex-col items-start gap-0.5 px-3 py-2 text-left",
                  i === activeIndex ? "bg-muted" : "hover:bg-muted/60",
                )}
              >
                <span className="flex items-center gap-1.5 text-sm font-medium text-foreground">
                  <span className="text-muted-foreground">/</span>
                  {item.short_code}
                  {item.owner_user_id === null && (
                    <span className="rounded bg-primary/10 px-1 py-px text-[9px] font-normal uppercase tracking-wide text-primary">
                      shared
                    </span>
                  )}
                </span>
                <span className="line-clamp-1 text-xs text-muted-foreground">
                  {item.content}
                </span>
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
