'use client';

import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Loader2, Inbox as InboxIcon, ArrowRight } from 'lucide-react';
import { channelDef } from '@/lib/channels/registry';
import { cn } from '@/lib/utils';
import type { InboxWithStatus } from '@/types';

export interface SelectedInbox {
  id: string;
  name: string;
}

interface Step0Props {
  selectedInbox: SelectedInbox | null;
  onSelect: (inbox: SelectedInbox) => void;
  onNext: () => void;
  onBack: () => void;
}

/**
 * First broadcast step: pick which inbox (WhatsApp number / WABA) sends the
 * broadcast. The chosen inbox scopes the template list in the next step and
 * becomes the sending number on the broadcast row.
 */
export function Step0ChooseInbox({ selectedInbox, onSelect, onNext, onBack }: Step0Props) {
  const [inboxes, setInboxes] = useState<InboxWithStatus[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/inboxes', { cache: 'no-store' });
        const json = await res.json();
        if (!res.ok) throw new Error(json.error || 'Failed to load inboxes');
        const list: InboxWithStatus[] = json.inboxes ?? [];
        setInboxes(list);
        // Auto-select when there's exactly one connected inbox.
        const connected = list.filter((i) => i.connection.configured);
        if (!selectedInbox && connected.length === 1) {
          onSelect({ id: connected[0].id, name: connected[0].name });
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load inboxes');
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (inboxes === null && !error) {
    return (
      <div className="flex h-64 items-center justify-center">
        <Loader2 className="h-6 w-6 animate-spin text-primary" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex h-64 flex-col items-center justify-center gap-2">
        <p className="text-sm text-red-400">{error}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">Choose an Inbox</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Select which number will send this broadcast. Templates are specific to
          each inbox.
        </p>
      </div>

      {inboxes && inboxes.length === 0 ? (
        <div className="flex h-48 flex-col items-center justify-center rounded-xl border border-border bg-card/50">
          <InboxIcon className="mb-2 h-8 w-8 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">No inboxes connected.</p>
          <p className="mt-1 text-xs text-muted-foreground">Connect a number in Settings → Inboxes first.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {(inboxes ?? []).map((inbox) => {
            const isSelected = selectedInbox?.id === inbox.id;
            const def = channelDef(inbox.channel_type);
            const Icon = def?.icon;
            const disabled = !inbox.connection.configured;
            return (
              <button
                key={inbox.id}
                disabled={disabled}
                onClick={() => onSelect({ id: inbox.id, name: inbox.name })}
                className={cn(
                  'flex items-center gap-3 rounded-xl border p-4 text-left transition-all',
                  isSelected
                    ? 'border-primary bg-primary/5 ring-1 ring-primary/30'
                    : 'border-border bg-card/50 hover:bg-card',
                  disabled && 'cursor-not-allowed opacity-50',
                )}
              >
                <span
                  className={cn(
                    'flex size-10 shrink-0 items-center justify-center rounded-lg',
                    def?.accent ?? 'bg-muted',
                  )}
                >
                  {Icon ? <Icon className="size-5" /> : null}
                </span>
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium text-foreground">{inbox.name}</p>
                  <p className="text-xs text-muted-foreground">
                    {disabled
                      ? 'Não conectado'
                      : def?.label ?? inbox.channel_type}
                  </p>
                </div>
              </button>
            );
          })}
        </div>
      )}

      <div className="flex items-center justify-between border-t border-border pt-4">
        <Button variant="outline" onClick={onBack} className="border-border text-muted-foreground">
          Back
        </Button>
        <Button
          onClick={onNext}
          disabled={!selectedInbox}
          className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          Next
          <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
