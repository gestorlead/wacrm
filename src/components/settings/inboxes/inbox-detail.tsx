'use client';

import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, Loader2, Trash2 } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { Badge } from '@/components/ui/badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { channelDef } from '@/lib/channels/registry';
import { TemplateManager } from '@/components/settings/template-manager';
import {
  runEmbeddedSignup,
  isEmbeddedSignupConfigured,
} from '@/lib/whatsapp/embedded-signup-client';
import type { AccountMember, Inbox } from '@/types';

interface ConnectionInfo {
  connected: boolean;
  reason?: string;
  message?: string;
  phone_info?: {
    display_phone_number?: string;
    verified_name?: string;
    quality_rating?: string;
  };
  phone_number_id?: string;
  waba_id?: string;
  connection_type?: 'manual' | 'embedded_signup';
  registered?: boolean;
}

export function InboxDetail({
  inboxId,
  canManage,
  onBack,
  onChanged,
}: {
  inboxId: string;
  canManage: boolean;
  onBack: () => void;
  onChanged: () => void;
}) {
  const [inbox, setInbox] = useState<Inbox | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/inboxes/${inboxId}`, { cache: 'no-store' });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Inbox não encontrado');
      setInbox(json.inbox);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Erro ao carregar inbox');
      onBack();
    } finally {
      setLoading(false);
    }
  }, [inboxId, onBack]);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading || !inbox) {
    return (
      <div className="flex items-center justify-center py-16 text-muted-foreground">
        <Loader2 className="size-5 animate-spin" />
      </div>
    );
  }

  const def = channelDef(inbox.channel_type);
  const Icon = def?.icon;

  return (
    <div>
      <button
        type="button"
        onClick={onBack}
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" /> Voltar para inboxes
      </button>

      <div className="mb-5 flex items-center gap-3">
        <span className={`flex size-10 items-center justify-center rounded-lg ${def?.accent ?? 'bg-muted'}`}>
          {Icon ? <Icon className="size-5" /> : null}
        </span>
        <div>
          <h2 className="text-lg font-semibold text-foreground">{inbox.name}</h2>
          <p className="text-xs text-muted-foreground">{def?.label ?? inbox.channel_type}</p>
        </div>
      </div>

      <Tabs defaultValue="general">
        <TabsList>
          <TabsTrigger value="general">Geral</TabsTrigger>
          <TabsTrigger value="connection">Conexão</TabsTrigger>
          {inbox.channel_type === 'whatsapp' ? (
            <TabsTrigger value="templates">Templates</TabsTrigger>
          ) : null}
          <TabsTrigger value="agents">Agentes</TabsTrigger>
        </TabsList>

        <TabsContent value="general" className="mt-4">
          <GeneralTab
            inbox={inbox}
            canManage={canManage}
            onSaved={() => {
              void load();
              onChanged();
            }}
            onDeleted={() => {
              onChanged();
              onBack();
            }}
          />
        </TabsContent>

        <TabsContent value="agents" className="mt-4">
          <AgentsTab inboxId={inboxId} canManage={canManage} onChanged={onChanged} />
        </TabsContent>

        <TabsContent value="connection" className="mt-4">
          <ConnectionTab inboxId={inboxId} canManage={canManage} onChanged={load} />
        </TabsContent>

        {inbox.channel_type === 'whatsapp' ? (
          <TabsContent value="templates" className="mt-4">
            <TemplateManager inboxId={inboxId} />
          </TabsContent>
        ) : null}
      </Tabs>
    </div>
  );
}

function GeneralTab({
  inbox,
  canManage,
  onSaved,
  onDeleted,
}: {
  inbox: Inbox;
  canManage: boolean;
  onSaved: () => void;
  onDeleted: () => void;
}) {
  const [name, setName] = useState(inbox.name);
  const [saving, setSaving] = useState(false);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch(`/api/inboxes/${inbox.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      });
      if (!res.ok) {
        const json = await res.json();
        throw new Error(json.error || 'Falha ao salvar');
      }
      toast.success('Inbox atualizado');
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha ao salvar');
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    setDeleting(true);
    try {
      const res = await fetch(`/api/inboxes/${inbox.id}`, { method: 'DELETE' });
      if (!res.ok) {
        const json = await res.json();
        throw new Error(json.error || 'Falha ao excluir');
      }
      toast.success('Inbox excluído');
      onDeleted();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha ao excluir');
    } finally {
      setDeleting(false);
      setConfirmOpen(false);
    }
  };

  return (
    <Card className="space-y-4 p-5">
      <div className="space-y-1.5">
        <Label>Nome do inbox</Label>
        <Input value={name} onChange={(e) => setName(e.target.value)} disabled={!canManage} />
      </div>
      {canManage ? (
        <div className="flex items-center justify-between">
          <Button onClick={save} disabled={saving || name === inbox.name}>
            {saving ? <Loader2 className="size-4 animate-spin" /> : null}
            Salvar
          </Button>
          <Button variant="ghost" className="text-destructive" onClick={() => setConfirmOpen(true)}>
            <Trash2 className="size-4" /> Excluir inbox
          </Button>
        </div>
      ) : null}

      <Dialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Excluir “{inbox.name}”?</DialogTitle>
            <DialogDescription>
              Isso remove o canal, suas conversas e mensagens deste inbox. Esta ação não pode ser
              desfeita.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirmOpen(false)} disabled={deleting}>
              Cancelar
            </Button>
            <Button variant="destructive" onClick={remove} disabled={deleting}>
              {deleting ? <Loader2 className="size-4 animate-spin" /> : null}
              Excluir
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function AgentsTab({
  inboxId,
  canManage,
  onChanged,
}: {
  inboxId: string;
  canManage: boolean;
  onChanged: () => void;
}) {
  const [members, setMembers] = useState<AccountMember[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const [accRes, inbRes] = await Promise.all([
          fetch('/api/account/members', { cache: 'no-store' }).then((r) => r.json()),
          fetch(`/api/inboxes/${inboxId}/members`, { cache: 'no-store' }).then((r) => r.json()),
        ]);
        setMembers(accRes.members ?? []);
        setSelected(
          new Set((inbRes.members ?? []).map((m: { user_id: string }) => m.user_id)),
        );
      } catch {
        setMembers([]);
      }
    })();
  }, [inboxId]);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const save = async () => {
    setSaving(true);
    try {
      const res = await fetch(`/api/inboxes/${inboxId}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ user_ids: [...selected] }),
      });
      if (!res.ok) {
        const json = await res.json();
        throw new Error(json.error || 'Falha ao salvar');
      }
      toast.success('Agentes atualizados');
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha ao salvar');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="space-y-1 p-3">
      {members === null ? (
        <div className="flex justify-center py-8">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      ) : (
        <>
          {members.map((m) => (
            <label
              key={m.user_id}
              className="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-2 hover:bg-muted"
            >
              <Checkbox
                checked={selected.has(m.user_id)}
                onCheckedChange={() => toggle(m.user_id)}
                disabled={!canManage}
              />
              <span className="flex-1 text-sm text-foreground">{m.full_name || m.email}</span>
              <span className="text-xs text-muted-foreground">{m.role}</span>
            </label>
          ))}
          {canManage ? (
            <div className="flex justify-end pt-2">
              <Button onClick={save} disabled={saving}>
                {saving ? <Loader2 className="size-4 animate-spin" /> : null}
                Salvar agentes
              </Button>
            </div>
          ) : null}
        </>
      )}
    </Card>
  );
}

function ConnectionTab({
  inboxId,
  canManage,
  onChanged,
}: {
  inboxId: string;
  canManage: boolean;
  onChanged: () => void;
}) {
  const [info, setInfo] = useState<ConnectionInfo | null>(null);
  const [testing, setTesting] = useState(false);
  const [reconnecting, setReconnecting] = useState(false);
  const [showManual, setShowManual] = useState(false);

  const webhookUrl =
    typeof window !== 'undefined' ? `${window.location.origin}/api/whatsapp/webhook` : '';

  const test = useCallback(async () => {
    setTesting(true);
    try {
      const res = await fetch(`/api/whatsapp/config?inbox_id=${inboxId}`, { cache: 'no-store' });
      const json = await res.json();
      setInfo(json);
    } catch {
      setInfo({ connected: false, message: 'Falha ao testar conexão' });
    } finally {
      setTesting(false);
    }
  }, [inboxId]);

  useEffect(() => {
    void test();
  }, [test]);

  // Reconnect via Embedded Signup — refreshes the token + webhook for the
  // same number (Coexistence). The route keys by phone_number_id, so an
  // existing inbox's number is updated in place.
  const reconnectFacebook = async () => {
    setReconnecting(true);
    try {
      const result = await runEmbeddedSignup();
      if (!result) return;
      const res = await fetch('/api/whatsapp/embedded-signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(result),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Falha ao reconectar');
      toast.success('WhatsApp reconectado');
      await test();
      onChanged();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha ao reconectar');
    } finally {
      setReconnecting(false);
    }
  };

  const phone = info?.phone_info;
  const quality = phone?.quality_rating;
  const qualityTone =
    quality === 'GREEN' ? 'default' : quality === 'YELLOW' ? 'secondary' : 'destructive';

  return (
    <div className="space-y-4">
      {/* Status + health */}
      <Card className="space-y-3 p-5">
        <div className="flex items-center gap-2">
          <span className="text-sm font-medium">Status:</span>
          {info === null ? (
            <Loader2 className="size-4 animate-spin text-muted-foreground" />
          ) : info.connected ? (
            <Badge>Conectado</Badge>
          ) : (
            <Badge variant="destructive">Desconectado</Badge>
          )}
          {info?.connected && info.registered === false ? (
            <Badge variant="secondary">Não registrado</Badge>
          ) : null}
        </div>

        {info && !info.connected && info.message ? (
          <p className="text-sm text-muted-foreground">{info.message}</p>
        ) : null}

        {phone ? (
          <dl className="grid grid-cols-1 gap-2 text-sm sm:grid-cols-2">
            {phone.display_phone_number ? (
              <Info label="Número" value={phone.display_phone_number} />
            ) : null}
            {phone.verified_name ? (
              <Info label="Nome verificado" value={phone.verified_name} />
            ) : null}
            {quality ? (
              <div>
                <dt className="text-xs text-muted-foreground">Qualidade</dt>
                <dd className="mt-0.5">
                  <Badge variant={qualityTone}>{quality}</Badge>
                </dd>
              </div>
            ) : null}
            {info?.connection_type ? (
              <Info
                label="Tipo de conexão"
                value={info.connection_type === 'embedded_signup' ? 'Coexistence' : 'Manual'}
              />
            ) : null}
          </dl>
        ) : null}

        {canManage ? (
          <Button variant="outline" size="sm" onClick={test} disabled={testing}>
            {testing ? <Loader2 className="size-4 animate-spin" /> : null}
            Testar conexão
          </Button>
        ) : null}
      </Card>

      {/* Webhook */}
      <Card className="space-y-2 p-5">
        <Label className="text-xs text-muted-foreground">Webhook URL</Label>
        <code className="block break-all rounded-lg bg-muted px-3 py-2 text-xs">{webhookUrl}</code>
      </Card>

      {/* Reconnection */}
      {canManage ? (
        <Card className="space-y-3 p-5">
          <div>
            <h3 className="text-sm font-medium text-foreground">Reconectar</h3>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Renove a conexão se o token expirou ou o número parou de receber mensagens.
            </p>
          </div>
          {isEmbeddedSignupConfigured() ? (
            <Button variant="outline" onClick={reconnectFacebook} disabled={reconnecting}>
              {reconnecting ? <Loader2 className="size-4 animate-spin" /> : null}
              Reconectar com Facebook
            </Button>
          ) : null}
          <button
            type="button"
            onClick={() => setShowManual((s) => !s)}
            className="block text-xs text-muted-foreground hover:text-foreground"
          >
            Atualizar token manualmente
          </button>
          {showManual ? (
            <ManualReconnectForm
              inboxId={inboxId}
              phoneNumberId={info?.phone_number_id}
              wabaId={info?.waba_id}
              onDone={() => {
                void test();
                onChanged();
              }}
            />
          ) : null}
        </Card>
      ) : null}
    </div>
  );
}

function Info({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-foreground">{value}</dd>
    </div>
  );
}

function ManualReconnectForm({
  inboxId,
  phoneNumberId,
  wabaId,
  onDone,
}: {
  inboxId: string;
  phoneNumberId?: string;
  wabaId?: string;
  onDone: () => void;
}) {
  const [accessToken, setAccessToken] = useState('');
  const [pin, setPin] = useState('');
  const [saving, setSaving] = useState(false);

  const save = async () => {
    if (!accessToken) {
      toast.error('Informe o novo Access Token.');
      return;
    }
    if (!phoneNumberId) {
      toast.error('Phone Number ID indisponível — reconecte via Facebook.');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/whatsapp/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          inbox_id: inboxId,
          phone_number_id: phoneNumberId,
          waba_id: wabaId,
          access_token: accessToken,
          pin: pin || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Falha ao atualizar');
      toast.success('Token atualizado');
      setAccessToken('');
      setPin('');
      onDone();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha ao atualizar');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3 rounded-lg border border-border p-3">
      <div className="space-y-1.5">
        <Label>Novo Access Token</Label>
        <Input type="password" value={accessToken} onChange={(e) => setAccessToken(e.target.value)} />
      </div>
      <div className="space-y-1.5">
        <Label>PIN de 2 etapas (opcional)</Label>
        <Input value={pin} onChange={(e) => setPin(e.target.value)} inputMode="numeric" maxLength={6} />
      </div>
      <Button size="sm" onClick={save} disabled={saving}>
        {saving ? <Loader2 className="size-4 animate-spin" /> : null}
        Salvar token
      </Button>
    </div>
  );
}
