'use client';

import { useCallback, useEffect, useState } from 'react';
import { Plus, Loader2, ChevronRight } from 'lucide-react';
import { toast } from 'sonner';

import { useCan } from '@/hooks/use-can';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Card } from '@/components/ui/card';
import { SettingsPanelHead } from '@/components/settings/settings-panel-head';
import { channelDef } from '@/lib/channels/registry';
import type { InboxWithStatus } from '@/types';
import { NewInboxWizard } from './new-inbox-wizard';
import { InboxDetail } from './inbox-detail';

type View = { mode: 'list' | 'new' | 'detail'; inboxId?: string };

/**
 * Multi-inbox settings home. The active view (list / new-inbox wizard /
 * inbox detail) is plain React state — clicking a card flips it
 * synchronously, with no dependency on URL/searchParams reactivity.
 */
export function InboxesPanel() {
  const canManage = useCan('edit-settings');

  const [inboxes, setInboxes] = useState<InboxWithStatus[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<View>({ mode: 'list' });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/inboxes', { cache: 'no-store' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Failed to load inboxes');
      setInboxes(json.inboxes ?? []);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Failed to load inboxes');
      setInboxes([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openInbox = (id: string) => setView({ mode: 'detail', inboxId: id });
  const startNew = () => setView({ mode: 'new' });
  const backToList = () => setView({ mode: 'list' });

  // ---- Detail view ----
  if (view.mode === 'detail' && view.inboxId) {
    return (
      <InboxDetail
        inboxId={view.inboxId}
        canManage={canManage}
        onBack={() => {
          backToList();
          void load();
        }}
        onChanged={load}
      />
    );
  }

  // ---- Wizard view ----
  if (view.mode === 'new') {
    return (
      <NewInboxWizard
        onCancel={backToList}
        onDone={(id) => {
          void load();
          if (id) openInbox(id);
          else backToList();
        }}
      />
    );
  }

  // ---- List view ----
  return (
    <div>
      <SettingsPanelHead
        title="Inboxes"
        description="Conecte e gerencie seus canais de atendimento. Cada número/canal é um inbox com seus próprios agentes."
        action={
          canManage ? (
            <Button onClick={startNew} size="sm">
              <Plus className="size-4" /> Novo inbox
            </Button>
          ) : undefined
        }
      />

      {loading ? (
        <div className="flex items-center justify-center py-16 text-muted-foreground">
          <Loader2 className="size-5 animate-spin" />
        </div>
      ) : inboxes && inboxes.length > 0 ? (
        <div className="grid gap-3 sm:grid-cols-2">
          {inboxes.map((inbox) => (
            <InboxCard key={inbox.id} inbox={inbox} onOpen={() => openInbox(inbox.id)} />
          ))}
        </div>
      ) : (
        <Card className="flex flex-col items-center gap-3 px-6 py-12 text-center">
          <p className="text-sm text-muted-foreground">
            Nenhum inbox conectado ainda.
          </p>
          {canManage ? (
            <Button onClick={startNew} size="sm">
              <Plus className="size-4" /> Conectar um canal
            </Button>
          ) : null}
        </Card>
      )}
    </div>
  );
}

function InboxCard({
  inbox,
  onOpen,
}: {
  inbox: InboxWithStatus;
  onOpen: () => void;
}) {
  const def = channelDef(inbox.channel_type);
  const Icon = def?.icon;
  const conn = inbox.connection;
  const tone: { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' } =
    !conn.configured
      ? { label: 'Não configurado', variant: 'outline' }
      : conn.status === 'connected' && conn.registered
        ? { label: 'Conectado', variant: 'default' }
        : conn.status === 'connected'
          ? { label: 'Não registrado', variant: 'secondary' }
          : { label: 'Desconectado', variant: 'destructive' };

  return (
    <button
      type="button"
      onClick={onOpen}
      className="group flex items-center gap-3 rounded-xl border border-border bg-card p-4 text-left transition-colors hover:bg-muted"
    >
      <span
        className={`flex size-10 shrink-0 items-center justify-center rounded-lg ${def?.accent ?? 'bg-muted'}`}
      >
        {Icon ? <Icon className="size-5" /> : null}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate font-medium text-foreground">{inbox.name}</span>
          <Badge variant={tone.variant} className="shrink-0">
            {tone.label}
          </Badge>
        </div>
        <p className="mt-0.5 text-xs text-muted-foreground">
          {def?.label ?? inbox.channel_type} · {inbox.member_count}{' '}
          {inbox.member_count === 1 ? 'agente' : 'agentes'}
        </p>
      </div>
      <ChevronRight className="size-4 shrink-0 text-muted-foreground transition-transform group-hover:translate-x-0.5" />
    </button>
  );
}
