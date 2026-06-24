'use client';

import { useEffect, useMemo, useState } from 'react';
import { createClient } from '@/lib/supabase/client';
import { MessageTemplate } from '@/types';
import { Button } from '@/components/ui/button';
import { Loader2, FileText, ArrowRight } from 'lucide-react';
import { channelDef } from '@/lib/channels/registry';
import { cn } from '@/lib/utils';

const categoryColors: Record<string, string> = {
  Marketing: 'bg-purple-500/10 text-purple-400 border-purple-500/20',
  Utility: 'bg-blue-500/10 text-blue-400 border-blue-500/20',
  Authentication: 'bg-orange-500/10 text-orange-400 border-orange-500/20',
};

interface InboxLite {
  id: string;
  name: string;
  channel_type: string;
}

interface Step1Props {
  /** When set, only this inbox's (WABA's) templates are shown — the inbox is
   *  chosen in the preceding step. */
  inboxId?: string;
  selectedTemplate: MessageTemplate | null;
  onSelect: (template: MessageTemplate) => void;
  onNext: () => void;
  onBack: () => void;
}

export function Step1ChooseTemplate({ inboxId, selectedTemplate, onSelect, onNext, onBack }: Step1Props) {
  const [templates, setTemplates] = useState<MessageTemplate[]>([]);
  const [inboxes, setInboxes] = useState<Record<string, InboxLite>>({});
  const [inboxFilter, setInboxFilter] = useState<string>('all');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function fetchTemplates() {
      try {
        const supabase = createClient();
        // Only APPROVED templates can be sent via Meta — anything else
        // would 400 at broadcast time. Hide them rather than letting
        // the user pick a template that will fail.
        let tplQuery = supabase
          .from('message_templates')
          .select('*')
          .eq('status', 'APPROVED')
          .order('created_at', { ascending: false });
        if (inboxId) tplQuery = tplQuery.eq('inbox_id', inboxId);
        const [tplRes, inboxRes] = await Promise.all([
          tplQuery,
          supabase.from('inboxes').select('id, name, channel_type'),
        ]);

        if (tplRes.error) throw tplRes.error;
        setTemplates(tplRes.data ?? []);
        const map: Record<string, InboxLite> = {};
        for (const i of (inboxRes.data ?? []) as InboxLite[]) map[i.id] = i;
        setInboxes(map);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load templates');
      } finally {
        setLoading(false);
      }
    }

    fetchTemplates();
  }, [inboxId]);

  // Inboxes that actually have at least one approved template — drives the
  // filter chips (only shown when templates span more than one inbox).
  const inboxOptions = useMemo(() => {
    const ids = new Set<string>();
    for (const t of templates) if (t.inbox_id) ids.add(t.inbox_id);
    return [...ids].map((id) => inboxes[id]).filter(Boolean) as InboxLite[];
  }, [templates, inboxes]);

  const visibleTemplates = useMemo(
    () =>
      inboxFilter === 'all'
        ? templates
        : templates.filter((t) => t.inbox_id === inboxFilter),
    [templates, inboxFilter],
  );

  if (loading) {
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
        <h2 className="text-lg font-semibold text-foreground">Choose a Template</h2>
        <p className="mt-1 text-sm text-muted-foreground">
          Select an approved message template for your broadcast. The template&apos;s
          inbox is the number it will be sent from.
        </p>
      </div>

      {inboxOptions.length > 1 ? (
        <div className="flex flex-wrap gap-2">
          <FilterChip active={inboxFilter === 'all'} onClick={() => setInboxFilter('all')}>
            Todos os inboxes
          </FilterChip>
          {inboxOptions.map((i) => (
            <FilterChip
              key={i.id}
              active={inboxFilter === i.id}
              onClick={() => setInboxFilter(i.id)}
            >
              {i.name}
            </FilterChip>
          ))}
        </div>
      ) : null}

      {templates.length === 0 ? (
        <div className="flex h-48 flex-col items-center justify-center rounded-xl border border-border bg-card/50">
          <FileText className="mb-2 h-8 w-8 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">No templates available.</p>
          <p className="mt-1 text-xs text-muted-foreground">Create a template in Settings first.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {visibleTemplates.map((template) => {
            const isSelected = selectedTemplate?.id === template.id;
            const catColor = categoryColors[template.category] ?? categoryColors.Utility;
            const inbox = template.inbox_id ? inboxes[template.inbox_id] : undefined;
            const ChannelIcon = inbox ? channelDef(inbox.channel_type)?.icon : undefined;

            return (
              <button
                key={template.id}
                onClick={() => onSelect(template)}
                className={`flex flex-col gap-3 rounded-xl border p-4 text-left transition-all ${
                  isSelected
                    ? 'border-primary bg-primary/5 ring-1 ring-primary/30'
                    : 'border-border bg-card/50 hover:border-border hover:bg-card'
                }`}
              >
                <div className="flex items-start justify-between">
                  <h3 className="text-sm font-medium text-foreground">{template.name}</h3>
                  <span
                    className={`inline-flex items-center rounded-full border px-2 py-0.5 text-[10px] font-medium ${catColor}`}
                  >
                    {template.category}
                  </span>
                </div>
                <p className="line-clamp-3 text-xs text-muted-foreground">{template.body_text}</p>
                <div className="flex items-center gap-2 text-[10px] text-muted-foreground">
                  <span>{template.language ?? 'en_US'}</span>
                  {inbox ? (
                    <span className="inline-flex items-center gap-1 rounded-full bg-muted px-1.5 py-0.5">
                      {ChannelIcon ? <ChannelIcon className="size-2.5" /> : null}
                      {inbox.name}
                    </span>
                  ) : null}
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
          disabled={!selectedTemplate}
          className="bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
        >
          Next
          <ArrowRight className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}

function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-full border px-3 py-1 text-xs font-medium transition-colors',
        active
          ? 'border-primary bg-primary/10 text-primary'
          : 'border-border text-muted-foreground hover:bg-muted',
      )}
    >
      {children}
    </button>
  );
}
