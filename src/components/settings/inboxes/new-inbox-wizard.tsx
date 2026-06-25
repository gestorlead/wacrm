'use client';

import { useEffect, useState } from 'react';
import { ArrowLeft, Check, Loader2, Smartphone, Settings2, Camera } from 'lucide-react';
import { toast } from 'sonner';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card } from '@/components/ui/card';
import { Checkbox } from '@/components/ui/checkbox';
import { SettingsPanelHead } from '@/components/settings/settings-panel-head';
import { CHANNEL_LIST, type ChannelDef } from '@/lib/channels/registry';
import {
  runEmbeddedSignup,
  isEmbeddedSignupConfigured,
} from '@/lib/whatsapp/embedded-signup-client';
import type { AccountMember, ChannelType } from '@/types';

type Step = 'channel' | 'config' | 'agents' | 'finish';

export function NewInboxWizard({
  onCancel,
  onDone,
}: {
  onCancel: () => void;
  onDone: (inboxId?: string) => void;
}) {
  const [step, setStep] = useState<Step>('channel');
  const [channel, setChannel] = useState<ChannelType | null>(null);
  const [createdInboxId, setCreatedInboxId] = useState<string | null>(null);

  return (
    <div>
      <button
        type="button"
        onClick={onCancel}
        className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground"
      >
        <ArrowLeft className="size-4" /> Voltar para inboxes
      </button>

      {step === 'channel' && (
        <ChannelStep
          onPick={(c) => {
            setChannel(c);
            setStep('config');
          }}
        />
      )}

      {step === 'config' && channel === 'whatsapp' && (
        <WhatsAppConfigStep
          onBack={() => setStep('channel')}
          onCreated={(id) => {
            setCreatedInboxId(id);
            setStep('agents');
          }}
        />
      )}

      {step === 'config' && channel === 'instagram' && (
        <InstagramConfigStep onBack={() => setStep('channel')} />
      )}

      {step === 'agents' && createdInboxId && (
        <AgentsStep
          inboxId={createdInboxId}
          onSkip={() => setStep('finish')}
          onSaved={() => setStep('finish')}
        />
      )}

      {step === 'finish' && (
        <FinishStep onDone={() => onDone(createdInboxId ?? undefined)} />
      )}
    </div>
  );
}

function ChannelStep({ onPick }: { onPick: (c: ChannelType) => void }) {
  return (
    <div>
      <SettingsPanelHead
        title="Novo inbox"
        description="Escolha o tipo de canal que você quer conectar."
      />
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {CHANNEL_LIST.map((def) => (
          <ChannelCard key={def.type} def={def} onPick={onPick} />
        ))}
      </div>
    </div>
  );
}

function ChannelCard({
  def,
  onPick,
}: {
  def: ChannelDef;
  onPick: (c: ChannelType) => void;
}) {
  const Icon = def.icon;
  const disabled = def.status !== 'available';
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={() => onPick(def.type)}
      className="relative flex flex-col items-start gap-3 rounded-xl border border-border bg-card p-4 text-left transition-colors enabled:hover:bg-muted disabled:cursor-not-allowed disabled:opacity-60"
    >
      <span className={`flex size-10 items-center justify-center rounded-lg ${def.accent}`}>
        <Icon className="size-5" />
      </span>
      <div>
        <div className="flex items-center gap-2">
          <span className="font-medium text-foreground">{def.label}</span>
          {disabled ? (
            <span className="rounded-full bg-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              Em breve
            </span>
          ) : null}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">{def.description}</p>
      </div>
    </button>
  );
}

function WhatsAppConfigStep({
  onBack,
  onCreated,
}: {
  onBack: () => void;
  onCreated: (inboxId: string) => void;
}) {
  const [showManual, setShowManual] = useState(false);
  const embeddedAvailable = isEmbeddedSignupConfigured();

  return (
    <div>
      <SettingsPanelHead
        title="Conectar WhatsApp"
        description="Conecte o WhatsApp Business que você já usa no celular — sem tokens nem conhecimento técnico."
      />

      {/* Coexistence (recommended) — the zero-config onboarding from the spec. */}
      <Card className="space-y-4 p-5">
        <div className="flex items-start gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-emerald-500/10 text-emerald-600">
            <Smartphone className="size-5" />
          </span>
          <div className="min-w-0">
            <h3 className="font-medium text-foreground">Coexistence (Recomendado)</h3>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Conecte o número do app WhatsApp Business via Facebook. Você confirma o
              número e escaneia um QR no celular — continua atendendo no app e o wacrm
              escala pela API no mesmo número.
            </p>
            <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
              <li>✓ Continua usando o app no celular</li>
              <li>✓ Mesmo número, sem migrar</li>
              <li>✓ Importa até 6 meses de histórico</li>
            </ul>
          </div>
        </div>

        <EmbeddedSignupButton onConnected={onCreated} disabled={!embeddedAvailable} />
        {!embeddedAvailable ? (
          <p className="text-xs text-muted-foreground">
            Onboarding via Facebook indisponível (faltam variáveis Meta no ambiente).
            Use a configuração manual abaixo.
          </p>
        ) : null}
      </Card>

      {/* Manual (advanced) — kept for technical users with Cloud API + tokens. */}
      <div className="mt-4">
        <button
          type="button"
          onClick={() => setShowManual((s) => !s)}
          className="inline-flex items-center gap-2 text-sm text-muted-foreground hover:text-foreground"
        >
          <Settings2 className="size-4" />
          Configuração manual (avançado)
        </button>
        {showManual ? <ManualWhatsAppForm onCreated={onCreated} /> : null}
      </div>

      <div className="mt-5">
        <Button variant="ghost" onClick={onBack}>
          Voltar
        </Button>
      </div>
    </div>
  );
}

function EmbeddedSignupButton({
  onConnected,
  disabled,
}: {
  onConnected: (inboxId: string) => void;
  disabled: boolean;
}) {
  const [connecting, setConnecting] = useState(false);

  const connect = async () => {
    setConnecting(true);
    try {
      const result = await runEmbeddedSignup();
      if (!result) return; // user cancelled the popup
      const res = await fetch('/api/whatsapp/embedded-signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(result),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Falha ao conectar o WhatsApp');
      toast.success(
        `WhatsApp conectado${data.display_phone_number ? `: ${data.display_phone_number}` : ''}`,
      );
      if (data.inbox_id) onConnected(data.inbox_id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha ao conectar o WhatsApp');
    } finally {
      setConnecting(false);
    }
  };

  return (
    <Button onClick={connect} disabled={disabled || connecting} className="w-full sm:w-auto">
      {connecting ? <Loader2 className="size-4 animate-spin" /> : null}
      Conectar com Facebook
    </Button>
  );
}

function ManualWhatsAppForm({ onCreated }: { onCreated: (inboxId: string) => void }) {
  const [name, setName] = useState('');
  const [phoneNumberId, setPhoneNumberId] = useState('');
  const [wabaId, setWabaId] = useState('');
  const [accessToken, setAccessToken] = useState('');
  const [verifyToken, setVerifyToken] = useState('');
  const [pin, setPin] = useState('');
  const [saving, setSaving] = useState(false);

  const submit = async () => {
    if (!phoneNumberId || !accessToken) {
      toast.error('Phone Number ID e Access Token são obrigatórios.');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch('/api/inboxes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          channel_type: 'whatsapp',
          name: name || undefined,
          phone_number_id: phoneNumberId,
          waba_id: wabaId || undefined,
          access_token: accessToken,
          verify_token: verifyToken || undefined,
          pin: pin || undefined,
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error || 'Falha ao conectar');
      if (json.registration_error) {
        toast.warning(`Inbox criado, mas o registro falhou: ${json.registration_error}`);
      } else {
        toast.success('Inbox do WhatsApp conectado!');
      }
      onCreated(json.inbox.id);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha ao conectar');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Card className="mt-3 space-y-4 p-5">
      <Field label="Nome do inbox (opcional)">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Ex.: Suporte" />
      </Field>
      <Field label="Phone Number ID *">
        <Input value={phoneNumberId} onChange={(e) => setPhoneNumberId(e.target.value)} />
      </Field>
      <Field label="WhatsApp Business Account ID (WABA)">
        <Input value={wabaId} onChange={(e) => setWabaId(e.target.value)} />
      </Field>
      <Field label="Access Token *">
        <Input type="password" value={accessToken} onChange={(e) => setAccessToken(e.target.value)} />
      </Field>
      <Field label="Verify Token (webhook)">
        <Input value={verifyToken} onChange={(e) => setVerifyToken(e.target.value)} />
      </Field>
      <Field label="PIN de 2 etapas (6 dígitos, p/ registrar)">
        <Input value={pin} onChange={(e) => setPin(e.target.value)} inputMode="numeric" maxLength={6} />
      </Field>
      <div className="flex justify-end pt-1">
        <Button onClick={submit} disabled={saving}>
          {saving ? <Loader2 className="size-4 animate-spin" /> : null}
          Conectar e continuar
        </Button>
      </div>
    </Card>
  );
}

function InstagramConfigStep({ onBack }: { onBack: () => void }) {
  const [connecting, setConnecting] = useState(false);

  // OAuth is a full-page redirect: we leave the SPA, Instagram authorizes,
  // and Meta returns the browser to /settings?tab=inboxes&instagram=...
  // The inboxes panel reads that param and shows the result; the inbox is
  // created server-side by /api/instagram/callback.
  const connect = () => {
    setConnecting(true);
    window.location.href = '/api/instagram/authorize';
  };

  return (
    <div>
      <SettingsPanelHead
        title="Conectar Instagram"
        description="Conecte uma conta profissional do Instagram para receber e responder DMs no wacrm."
      />
      <Card className="space-y-4 p-5">
        <div className="flex items-start gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-pink-500/10 text-pink-600">
            <Camera className="size-5" />
          </span>
          <div className="min-w-0">
            <h3 className="font-medium text-foreground">Login com Instagram</h3>
            <p className="mt-0.5 text-sm text-muted-foreground">
              Você será redirecionado ao Instagram para autorizar o acesso às
              mensagens. Ao voltar, o inbox será criado automaticamente.
            </p>
            <ul className="mt-2 space-y-1 text-xs text-muted-foreground">
              <li>✓ Conta profissional (Business/Creator)</li>
              <li>✓ Receba e responda DMs, story replies e reações</li>
              <li>✓ Janela de 24h (tag de agente humano fora dela)</li>
            </ul>
          </div>
        </div>
        <Button onClick={connect} disabled={connecting} className="w-full sm:w-auto">
          {connecting ? <Loader2 className="size-4 animate-spin" /> : null}
          Conectar com Instagram
        </Button>
      </Card>
      <div className="mt-5">
        <Button variant="ghost" onClick={onBack}>
          Voltar
        </Button>
      </div>
    </div>
  );
}

function AgentsStep({
  inboxId,
  onSkip,
  onSaved,
}: {
  inboxId: string;
  onSkip: () => void;
  onSaved: () => void;
}) {
  const [members, setMembers] = useState<AccountMember[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch('/api/account/members', { cache: 'no-store' });
        const json = await res.json();
        setMembers(json.members ?? []);
        // Pre-select admins/owners by default.
        const preset = new Set<string>(
          (json.members ?? [])
            .filter((m: AccountMember) => m.role === 'owner' || m.role === 'admin')
            .map((m: AccountMember) => m.user_id),
        );
        setSelected(preset);
      } catch {
        setMembers([]);
      }
    })();
  }, []);

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
        throw new Error(json.error || 'Falha ao salvar agentes');
      }
      onSaved();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : 'Falha ao salvar agentes');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div>
      <SettingsPanelHead
        title="Adicionar agentes"
        description="Escolha quem pode ver e responder às conversas deste inbox."
      />
      <Card className="space-y-1 p-3">
        {members === null ? (
          <div className="flex justify-center py-8">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : members.length === 0 ? (
          <p className="px-2 py-6 text-center text-sm text-muted-foreground">
            Nenhum membro na conta.
          </p>
        ) : (
          members.map((m) => (
            <label
              key={m.user_id}
              className="flex cursor-pointer items-center gap-3 rounded-lg px-2 py-2 hover:bg-muted"
            >
              <Checkbox
                checked={selected.has(m.user_id)}
                onCheckedChange={() => toggle(m.user_id)}
              />
              <span className="flex-1 text-sm text-foreground">{m.full_name || m.email}</span>
              <span className="text-xs text-muted-foreground">{m.role}</span>
            </label>
          ))
        )}
      </Card>
      <div className="mt-4 flex justify-between">
        <Button variant="ghost" onClick={onSkip} disabled={saving}>
          Pular
        </Button>
        <Button onClick={save} disabled={saving}>
          {saving ? <Loader2 className="size-4 animate-spin" /> : null}
          Salvar agentes
        </Button>
      </div>
    </div>
  );
}

function FinishStep({ onDone }: { onDone: () => void }) {
  const webhookUrl =
    typeof window !== 'undefined' ? `${window.location.origin}/api/whatsapp/webhook` : '';
  return (
    <div>
      <SettingsPanelHead
        title="Tudo pronto"
        description="Seu inbox foi criado. Confirme a configuração do webhook na Meta se ainda não o fez."
      />
      <Card className="space-y-4 p-5">
        <div className="flex items-center gap-2 text-emerald-600">
          <Check className="size-5" />
          <span className="font-medium">Inbox conectado</span>
        </div>
        <div>
          <Label className="text-xs text-muted-foreground">Webhook URL</Label>
          <code className="mt-1 block break-all rounded-lg bg-muted px-3 py-2 text-xs">
            {webhookUrl}
          </code>
        </div>
        <div className="flex justify-end">
          <Button onClick={onDone}>Ir para as configurações do inbox</Button>
        </div>
      </Card>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <Label>{label}</Label>
      {children}
    </div>
  );
}
