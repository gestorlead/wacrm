-- ============================================================
-- 034_instagram_channel
--
-- Adiciona o Instagram como segundo canal do multi-inbox, usando a
-- Instagram Login API direta (graph.instagram.com, conta
-- instagram_business_account própria — sem depender de Página do
-- Facebook). Espelha a estrutura de `whatsapp_config`.
--
-- Conteúdo:
--   1. Destrava contatos sem telefone (canais não-telefônicos: IG/Messenger).
--   2. Amplia o CHECK de `inboxes.channel_type` para aceitar 'instagram'.
--   3. Cria `instagram_config` (chave de rota do webhook = instagram_id)
--      + índices + RLS espelhando whatsapp_config (017/032).
--
-- Idempotente onde possível (IF NOT EXISTS / DROP POLICY IF EXISTS),
-- seguindo o padrão das migrações 017/032.
-- ============================================================

-- ============================================================
-- 1. CONTATOS SEM TELEFONE
--
-- O webhook do Instagram cria contatos identificados por IGSID, não por
-- telefone. `contacts.phone` era NOT NULL (migração 001). A coluna
-- gerada `phone_normalized` (022) é `regexp_replace(phone,'\D','','g')`:
-- com phone NULL ela resolve para NULL, e o índice unique parcial é
-- `WHERE phone_normalized <> ''` — NULL não satisfaz `<> ''`, então
-- múltiplos contatos IG sem telefone NÃO colidem. Basta soltar o NOT NULL.
-- ============================================================
ALTER TABLE contacts ALTER COLUMN phone DROP NOT NULL;

-- ============================================================
-- 2. inboxes.channel_type — aceitar 'instagram'
--
-- O CHECK inline da 032 tem nome auto-gerado `inboxes_channel_type_check`.
-- Recria incluindo 'instagram' (e 'messenger', já previsto no ChannelType
-- do código, para evitar nova migração quando ele entrar).
-- ============================================================
ALTER TABLE inboxes DROP CONSTRAINT IF EXISTS inboxes_channel_type_check;
ALTER TABLE inboxes
  ADD CONSTRAINT inboxes_channel_type_check
  CHECK (channel_type IN ('whatsapp', 'instagram', 'messenger'));

-- ============================================================
-- 3. instagram_config
--
-- 1:1 por inbox (UNIQUE(inbox_id)), espelhando whatsapp_config. A chave
-- de roteamento do webhook é `instagram_id` (= entry[].id / recipient.id),
-- UNIQUE global como `phone_number_id` é para o WhatsApp. Token de longa
-- duração (60 dias) encriptado em GCM; `token_expires_at`/`token_refreshed_at`
-- alimentam o refresh lazy (src/lib/instagram/token.ts).
-- ============================================================
CREATE TABLE IF NOT EXISTS instagram_config (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES auth.users(id),
  inbox_id   UUID NOT NULL REFERENCES inboxes(id) ON DELETE CASCADE,
  -- Instagram business account id — chave de rota dos webhooks.
  instagram_id TEXT NOT NULL,
  username TEXT,
  -- Token long-lived (ig_exchange_token, ~60 dias), encriptado (GCM).
  access_token TEXT NOT NULL,
  token_expires_at   TIMESTAMPTZ,
  token_refreshed_at TIMESTAMPTZ,
  -- Verify token do webhook (hub.verify_token), encriptado.
  verify_token TEXT,
  status TEXT NOT NULL DEFAULT 'disconnected'
    CHECK (status IN ('connected', 'disconnected')),
  connected_at        TIMESTAMPTZ,
  subscribed_apps_at  TIMESTAMPTZ,
  last_error TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Um número/conta IG por inbox; um instagram_id por instância.
  CONSTRAINT instagram_config_inbox_id_key   UNIQUE (inbox_id),
  CONSTRAINT instagram_config_instagram_id_key UNIQUE (instagram_id)
);

CREATE INDEX IF NOT EXISTS idx_instagram_config_account ON instagram_config(account_id);
CREATE INDEX IF NOT EXISTS idx_instagram_config_instagram_id ON instagram_config(instagram_id);

ALTER TABLE instagram_config ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS set_updated_at ON instagram_config;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON instagram_config
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- RLS espelhando whatsapp_config (017): leitura para membros da conta,
-- escrita só admin+. O service-role (webhook/callback) ignora RLS.
DROP POLICY IF EXISTS instagram_config_select ON instagram_config;
DROP POLICY IF EXISTS instagram_config_insert ON instagram_config;
DROP POLICY IF EXISTS instagram_config_update ON instagram_config;
DROP POLICY IF EXISTS instagram_config_delete ON instagram_config;
CREATE POLICY instagram_config_select ON instagram_config FOR SELECT USING (is_account_member(account_id));
CREATE POLICY instagram_config_insert ON instagram_config FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));
CREATE POLICY instagram_config_update ON instagram_config FOR UPDATE USING (is_account_member(account_id, 'admin'));
CREATE POLICY instagram_config_delete ON instagram_config FOR DELETE USING (is_account_member(account_id, 'admin'));
