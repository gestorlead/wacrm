# SPEC: wacrm — Onboarding WhatsApp Simplificado

> Feature independente. Não depende dos Agentes de IA (ver `SPEC-Agentes-IA.md`) e não deve ser bloqueada por eles.

## Visão Geral

Hoje o wacrm exige que o usuário saiba Phone Number ID, WABA ID, Access Token, Verify Token e PIN. Isso é nível técnico — nenhum cliente final consegue configurar.

O cliente-alvo **já usa o app WhatsApp Business** no celular e não tem (nem quer montar) Cloud API. Objetivo: conectar esse mesmo número ao wacrm **sem conhecimento técnico**, via **Coexistence** (Embedded Signup da Meta — "Onboard WhatsApp Business app users"), igual ao que Chatwoot/360dialog/Wati oferecem. O cliente continua atendendo 1:1 pelo celular e o wacrm automatiza/escala pela Cloud API, no mesmo número.

---

## Princípios de Design

1. **Zero código** — o cliente clica, confirma o número e escaneia um QR no próprio app. Nada de tokens.
2. **Coexistence primeiro** — o número continua funcionando no app WhatsApp Business; a Cloud API roda em paralelo.
3. **Tech Provider** — um único Meta App do wacrm onboarda todos os tenants.
4. **Multi-tenant nativo** — cada conexão isolada por `account_id` + RLS.

---

## Solução: Coexistence (modo principal) + fallbacks

### Modo 1 — Coexistence (Recomendado): conectar o WhatsApp Business app que o cliente já usa

Cenário-alvo: o cliente **já usa o app WhatsApp Business** no celular. Com **Coexistence**, o mesmo número passa a funcionar no app **e** na Cloud API ao mesmo tempo.

```
┌─────────────────────────────────────────────────┐
│  Conectar WhatsApp                               │
│                                                  │
│  ┌─────────────────────────────────────────┐    │
│  │ ✅ Coexistence (Recomendado)              │    │
│  │ Conecte o WhatsApp Business que você      │    │
│  │ já usa no celular                         │    │
│  │ [Conectar com Facebook]                  │    │
│  │                                           │    │
│  │ ✓ Continua usando o app no celular        │    │
│  │ ✓ Mesmo número, sem migrar                │    │
│  │ ✓ Importa até 6 meses de histórico        │    │
│  └─────────────────────────────────────────┘    │
│                                                  │
│  Fluxo:                                          │
│  1. Clica "Conectar com Facebook"               │
│  2. Confirma o número do WhatsApp Business      │
│  3. Aparece um QR Code                          │
│  4. Abre o app → Configurações → Aparelhos      │
│     conectados → Conectar → escaneia            │
│  5. ✅ Conectado (app + API no mesmo número)     │
└─────────────────────────────────────────────────┘
```

O que acontece por baixo:
- **Continua usando o app** no celular para conversas 1:1 (⚠️ não desinstalar — isso quebra a conexão)
- Mensagens novas **sincronizam em tempo real** entre app e API
- Importa **até 6 meses** de histórico 1:1 e os contatos durante o onboarding

**Implementação técnica (mesmo backbone do Embedded Signup):**

Pré-requisitos no Meta App (configurados **uma vez** pelo admin do wacrm — nós somos o *Tech Provider*):
- Produto **Facebook Login for Business** com uma **Configuration** que habilite o onboarding de WhatsApp Business app (Coexistence) → gera o `config_id`
- Permissões: `whatsapp_business_management`, `whatsapp_business_messaging`
- App no modo **Live** com webhook configurado (a callback por-tenant é apontada via `override_callback_uri` no `subscribed_apps` de cada WABA)
- **System User Token** do business do wacrm (chamadas server-to-server)

Fluxo (frontend + backend), o cliente só confirma o número e escaneia o QR:
1. Frontend carrega o **Facebook JS SDK** e chama `FB.init({ appId, version })`
2. Usuário clica "Conectar com Facebook" → `FB.login(cb, { config_id, response_type: 'code', override_default_response_type: true, extras: { setup: {}, featureType: 'whatsapp_business_app_onboarding', sessionInfoVersion: '3' } })`
3. Popup da Meta conduz: confirma o número → exibe **QR Code** → cliente escaneia no app (Configurações → Aparelhos conectados) para linkar
4. Retornam **dois** sinais assíncronos (ordem não garantida — só prossiga com os dois):
   - `message` event (`type: 'WA_EMBEDDED_SIGNUP'`) com `{ event, data: { phone_number_id, waba_id, business_id } }`. O finish da coexistence é **`FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING`** (trate junto com `FINISH`); demais eventos: `CANCEL`, `error`
   - callback do `FB.login` com um **authorization `code`**
5. Backend troca o `code` por um **business integration system user access token**:
   `GET /{version}/oauth/access_token?client_id={app-id}&client_secret={app-secret}&code={code}` (sem `redirect_uri`)
6. Backend busca o número na WABA: `GET /{version}/{waba-id}/phone_numbers` → escolhe o `phone_number_id` (ou o primeiro) e lê `display_phone_number`, `code_verification_status`, `verified_name`
7. Backend **assina o webhook da WABA em 2 passos** (a ordem importa):
   1. `POST /{version}/{waba-id}/subscribed_apps` (sem body) — inscreve o app na WABA
   2. `POST /{version}/{waba-id}/subscribed_apps` com `{ override_callback_uri, verify_token, subscribed_fields: ['messages', 'smb_message_echoes'] }` — aponta a callback por-tenant (ex: `/webhooks/whatsapp/{phone_number}`)
8. **Registro do número (condicional):** só chama `POST /{version}/{phone-number-id}/register` `{ messaging_product:'whatsapp', pin }` **se** o número não estiver `VERIFIED` / estiver em estado pendente. **Na coexistence o número já vem verificado → o register é pulado.**
9. Salva `phone_number_id`, `waba_id`, `business_id` e o token no `whatsapp_config` → pronto pra enviar/receber

> 🔑 **`smb_message_echoes` é o que faz a coexistence funcionar:** quando o dono responde 1:1 **pelo app no celular**, a Meta envia um *echo* dessa mensagem pro webhook e o CRM enxerga o que foi digitado no telefone. Sem esse campo, o CRM só veria as mensagens de entrada.
> ⚠️ O app precisa estar inscrito (passo 7.1) **antes** do override da callback (passo 7.2), senão o webhook falha (ressalva do Chatwoot).
> ⚠️ Coexistence tem limitações (limites de mensagens/qualidade, restrições de templates/marketing, 1 conexão por número) — ver doc da Meta.

> 💡 **Variante — migração total p/ Cloud API:** para quem quer só a API (sem usar o app), o mesmo Embedded Signup roda com `featureType: ''`; aí o número entra não-verificado e o `POST /{version}/{phone-number-id}/register` (passo 8) de fato roda. O número **deixa de funcionar** no app WhatsApp Business.

### Modo 2 — Manual (Avançado, atual)
Manter o modo atual para usuários técnicos que já têm Cloud API e tokens configurados.

> Sem conexões não-oficiais (`whatsapp-web.js`/`baileys`). A Coexistence já cobre, de forma **oficial**, o caso "conectar o app que eu já uso".

---

## Schema do Banco

Adicionar colunas na `whatsapp_config`:
```sql
ALTER TABLE whatsapp_config
ADD COLUMN connection_type TEXT DEFAULT 'coexistence', -- coexistence | cloud_api_migration | manual
ADD COLUMN meta_business_id TEXT,        -- business_id retornado pelo Embedded Signup
ADD COLUMN meta_waba_id TEXT,            -- WABA do cliente
ADD COLUMN meta_phone_number_id TEXT,    -- número conectado
ADD COLUMN meta_access_token TEXT,       -- business integration system user token (trocado do code)
ADD COLUMN is_coexistence BOOLEAN DEFAULT true; -- número continua ativo no app WhatsApp Business
```

---

## Configuração do Meta App (Coexistence / Embedded Signup)

O wacrm atua como **Tech Provider**: um único Meta App (do wacrm/white-label) onboarda todos os tenants. O cliente final nunca cria app nem token — só confirma o número e escaneia o QR.

Variáveis de ambiente (configuradas pelo admin, à la `WHATSAPP_*` do Chatwoot):
```bash
META_APP_ID=                 # Facebook App ID
META_APP_SECRET=             # App Secret (troca do code → token)
META_CONFIG_ID=              # Configuration ID do Embedded Signup (Facebook Login for Business)
META_SYSTEM_USER_TOKEN=      # System User token do business do wacrm (server-to-server)
META_WEBHOOK_VERIFY_TOKEN=   # verify token usado no override_callback_uri por WABA
META_GRAPH_VERSION=v22.0      # versão da Graph API (default do Chatwoot)
```

```typescript
// /lib/whatsapp/embedded-signup.ts

// --- Frontend: lança o popup da Meta (Coexistence) ---
FB.init({ appId: META_APP_ID, version: META_GRAPH_VERSION, xfbml: false });

FB.login((response) => {
  if (response.authResponse?.code) {
    // POST /api/whatsapp/embedded-signup { code, phone_number_id, waba_id }
    finishSignup(response.authResponse.code);
  }
}, {
  config_id: META_CONFIG_ID,
  response_type: 'code',
  override_default_response_type: true,
  extras: {
    setup: {},
    featureType: 'whatsapp_business_app_onboarding', // Coexistence ('' = migração total)
    sessionInfoVersion: '3',
  },
});

// Captura phone_number_id / waba_id / business_id emitidos pelo popup
window.addEventListener('message', (e) => {
  if (!e.origin.endsWith('facebook.com')) return;
  const msg = typeof e.data === 'string' ? JSON.parse(e.data) : e.data;
  if (msg?.type !== 'WA_EMBEDDED_SIGNUP') return;
  if (msg.event === 'FINISH' || msg.event === 'FINISH_WHATSAPP_BUSINESS_APP_ONBOARDING') {
    const { phone_number_id, waba_id, business_id } = msg.data; // valida business_id + waba_id
    // guardar e resolver só quando também tiver o `code` (ordem não garantida)
  }
});

// --- Backend: POST /api/whatsapp/embedded-signup ---
// 1. Trocar code → business integration system user access token
//    GET /{version}/oauth/access_token?client_id=&client_secret=&code=        (sem redirect_uri)
// 2. GET /{version}/{waba_id}/phone_numbers → phone_number_id, display_phone_number, code_verification_status
// 3. Assinar webhook (2 passos, nessa ordem):
//    POST /{version}/{waba_id}/subscribed_apps                                 (inscreve o app)
//    POST /{version}/{waba_id}/subscribed_apps { override_callback_uri, verify_token,
//                                                subscribed_fields: ['messages','smb_message_echoes'] }
// 4. Registro condicional: se NÃO verified → POST /{version}/{phone_number_id}/register { messaging_product, pin }
//    (coexistence já vem verified → pula)
// 5. Salvar { phone_number_id, waba_id, business_id, access_token } no whatsapp_config
```

---

## Roadmap de Implementação

### Sprint 0 — Coexistence (1-2 semanas)
- [ ] Meta App como Tech Provider: Facebook Login for Business + Configuration de Coexistence (`config_id`)
- [ ] Embedded Signup no frontend com `featureType: 'whatsapp_business_app_onboarding'` (FB JS SDK + `FB.login` + listener `WA_EMBEDDED_SIGNUP`)
- [ ] Tela com instrução de escanear o QR no app (Aparelhos conectados)
- [ ] Backend: troca `code` → token, busca `phone_numbers`, `subscribed_apps` em 2 passos com `smb_message_echoes`, `/register` condicional
- [ ] Webhook ingest: tratar o echo `smb_message_echoes` (mensagens enviadas pelo dono direto no app do celular)
- [ ] `ALTER TABLE whatsapp_config` com colunas de Coexistence
- [ ] Sincronização: histórico importado + mensagens novas em ambos os lados
- [ ] Tela de settings simplificada (Coexistence / Migração total / Manual)
- [ ] Status visual (✅ Conectado / ⚠ Pendente / ❌ Erro)

### Sprint 1 (opcional) — Migração total p/ Cloud API
- [ ] Mesmo fluxo com `featureType: ''` + `POST /{phone_number_id}/register` (PIN)
- [ ] Aviso de que o número deixa de funcionar no app WhatsApp Business

---

## Referências

- Meta — Onboard WhatsApp Business app users (Coexistence): https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/onboarding-business-app-users
- Meta — Coexistence custom flow: https://developers.facebook.com/docs/whatsapp/embedded-signup/custom-flows/onboarding-business-app-users/
- Meta — Embedded Signup Overview: https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/overview
- Meta — Embedded Signup Implementation: https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/implementation
- Chatwoot — WhatsApp Embedded Signup: https://developers.chatwoot.com/self-hosted/configuration/features/integrations/whatsapp-embedded-signup
