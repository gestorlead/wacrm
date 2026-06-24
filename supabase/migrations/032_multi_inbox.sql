-- ============================================================
-- 032_multi_inbox.sql — Multi-inbox (canais por conta)
--
-- Transforma o wacrm de "um número WhatsApp por conta" para
-- N inboxes por conta, com arquitetura channel-agnostic (pronta
-- para Instagram/Messenger, que se identificam por source_id de
-- plataforma e não por telefone).
--
-- O que esta migração faz
--   1. Tabela central `inboxes` (discriminada por `channel_type`).
--   2. `inbox_members` (quais agentes acessam cada inbox).
--   3. `contact_inboxes` (elo contato↔inbox via `source_id` — a peça
--      que habilita canais sem telefone).
--   4. Liga `whatsapp_config` a um inbox (`inbox_id`) e remove o
--      `UNIQUE(account_id)` (criado na 017) → vários números por conta.
--   5. Adiciona `conversations.inbox_id` + `contact_inbox_id` e
--      `broadcasts.inbox_id`.
--   6. Helper `can_access_inbox()` + reescreve a RLS de conversations
--      / messages / message_reactions para isolamento por inbox.
--   7. Backfill: 1 inbox por config existente, contact_inboxes a partir
--      das conversas atuais, e todos os membros atuais em todos os
--      inboxes (preserva o "todo mundo vê tudo" de antes).
--
-- Multi-tenant: toda tabela nova carrega `account_id` e RLS via
-- `is_account_member` / `can_access_inbox`. `source_id` é único POR
-- inbox (nunca global) — duas contas podem ter o mesmo telefone.
--
-- Idempotente — `IF NOT EXISTS`, drop-before-create de policies
-- (Postgres não tem CREATE POLICY IF NOT EXISTS). Padrão da 017.
-- ============================================================

-- ============================================================
-- 1. INBOXES
-- ============================================================
CREATE TABLE IF NOT EXISTS inboxes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  -- Discriminador de canal. CHECK estende para 'instagram','messenger'
  -- numa migração futura quando esses canais forem implementados.
  channel_type TEXT NOT NULL DEFAULT 'whatsapp'
    CHECK (channel_type IN ('whatsapp')),
  -- Cor do badge na UI (opcional).
  color TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_inboxes_account ON inboxes(account_id);

ALTER TABLE inboxes ENABLE ROW LEVEL SECURITY;

DROP TRIGGER IF EXISTS set_updated_at ON inboxes;
CREATE TRIGGER set_updated_at BEFORE UPDATE ON inboxes
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- 2. INBOX_MEMBERS
-- ============================================================
CREATE TABLE IF NOT EXISTS inbox_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  inbox_id UUID NOT NULL REFERENCES inboxes(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(inbox_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_inbox_members_inbox ON inbox_members(inbox_id);
CREATE INDEX IF NOT EXISTS idx_inbox_members_user  ON inbox_members(user_id);

ALTER TABLE inbox_members ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- 3. ACCESS HELPER
--
-- can_access_inbox(inbox_id): true se o caller é admin+ na conta do
-- inbox (admins veem tudo) OU é membro explícito do inbox. SECURITY
-- DEFINER para ler inboxes/inbox_members sem RLS recursiva. Criado
-- DEPOIS de inbox_members existir — funções LANGUAGE sql resolvem
-- colunas no CREATE (como is_account_member na 017).
-- ============================================================
CREATE OR REPLACE FUNCTION can_access_inbox(target_inbox_id UUID)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM inboxes i
    WHERE i.id = target_inbox_id
      AND (
        is_account_member(i.account_id, 'admin')
        OR EXISTS (
          SELECT 1 FROM inbox_members m
          WHERE m.inbox_id = i.id AND m.user_id = auth.uid()
        )
      )
  );
$$;

ALTER FUNCTION can_access_inbox(UUID) OWNER TO postgres;
GRANT EXECUTE ON FUNCTION can_access_inbox(UUID) TO authenticated, service_role;

-- ============================================================
-- 4. CONTACT_INBOXES (elo contato↔inbox via source_id)
--
-- source_id = identidade do contato NAQUELE canal: telefone (WhatsApp),
-- IGSID (Instagram), PSID (Messenger). UNIQUE(inbox_id, source_id)
-- garante isolamento por inbox; UNIQUE(inbox_id, contact_id) garante
-- que um contato apareça uma única vez por inbox.
-- ============================================================
CREATE TABLE IF NOT EXISTS contact_inboxes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  contact_id UUID NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  inbox_id UUID NOT NULL REFERENCES inboxes(id) ON DELETE CASCADE,
  source_id TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(inbox_id, source_id),
  UNIQUE(inbox_id, contact_id)
);

CREATE INDEX IF NOT EXISTS idx_contact_inboxes_account ON contact_inboxes(account_id);
CREATE INDEX IF NOT EXISTS idx_contact_inboxes_contact ON contact_inboxes(contact_id);
CREATE INDEX IF NOT EXISTS idx_contact_inboxes_inbox   ON contact_inboxes(inbox_id);

ALTER TABLE contact_inboxes ENABLE ROW LEVEL SECURITY;

-- ============================================================
-- 5. COLUNAS DE LIGAÇÃO (nullable até o backfill rodar)
-- ============================================================
ALTER TABLE whatsapp_config ADD COLUMN IF NOT EXISTS inbox_id UUID REFERENCES inboxes(id) ON DELETE CASCADE;
ALTER TABLE conversations   ADD COLUMN IF NOT EXISTS inbox_id UUID REFERENCES inboxes(id) ON DELETE CASCADE;
ALTER TABLE conversations   ADD COLUMN IF NOT EXISTS contact_inbox_id UUID REFERENCES contact_inboxes(id) ON DELETE SET NULL;
ALTER TABLE broadcasts      ADD COLUMN IF NOT EXISTS inbox_id UUID REFERENCES inboxes(id) ON DELETE SET NULL;

-- whatsapp_config: derruba a unicidade por conta (017 linhas 319-328).
-- phone_number_id segue único global (013) — chave de roteamento do webhook.
ALTER TABLE whatsapp_config DROP CONSTRAINT IF EXISTS whatsapp_config_account_id_key;

-- ============================================================
-- 6. BACKFILL (re-convergente)
-- ============================================================
DO $$
DECLARE
  r RECORD;
  v_inbox_id UUID;
BEGIN
  -- (1) Um inbox por whatsapp_config ainda não ligado.
  FOR r IN SELECT id, account_id, phone_number_id FROM whatsapp_config WHERE inbox_id IS NULL LOOP
    INSERT INTO inboxes (account_id, name, channel_type)
    VALUES (
      r.account_id,
      'WhatsApp' || COALESCE(' ' || NULLIF(r.phone_number_id, ''), ''),
      'whatsapp'
    )
    RETURNING id INTO v_inbox_id;
    UPDATE whatsapp_config SET inbox_id = v_inbox_id WHERE id = r.id;
  END LOOP;

  -- (2) Contas com conversas mas sem nenhum inbox (sem config) → inbox padrão.
  FOR r IN
    SELECT DISTINCT c.account_id
    FROM conversations c
    WHERE NOT EXISTS (SELECT 1 FROM inboxes i WHERE i.account_id = c.account_id)
  LOOP
    INSERT INTO inboxes (account_id, name, channel_type)
    VALUES (r.account_id, 'WhatsApp', 'whatsapp');
  END LOOP;

  -- (3) conversations.inbox_id = inbox da conta (no backfill cada conta tem 1).
  UPDATE conversations conv
  SET inbox_id = (
    SELECT i.id FROM inboxes i
    WHERE i.account_id = conv.account_id
    ORDER BY i.created_at, i.id
    LIMIT 1
  )
  WHERE conv.inbox_id IS NULL;

  -- (4) contact_inboxes a partir das conversas existentes. source_id =
  -- telefone normalizado (digits-only) do contato; fallback p/ phone bruto.
  INSERT INTO contact_inboxes (account_id, contact_id, inbox_id, source_id)
  SELECT DISTINCT conv.account_id, conv.contact_id, conv.inbox_id,
         COALESCE(NULLIF(ct.phone_normalized, ''), ct.phone)
  FROM conversations conv
  JOIN contacts ct ON ct.id = conv.contact_id
  WHERE conv.inbox_id IS NOT NULL
  ON CONFLICT (inbox_id, contact_id) DO NOTHING;

  -- (5) liga conversations.contact_inbox_id.
  UPDATE conversations conv
  SET contact_inbox_id = ci.id
  FROM contact_inboxes ci
  WHERE ci.inbox_id = conv.inbox_id
    AND ci.contact_id = conv.contact_id
    AND conv.contact_inbox_id IS NULL;

  -- (6) inbox_members: todos os membros atuais em todos os inboxes da
  -- conta → preserva o acesso atual (ninguém perde visibilidade).
  INSERT INTO inbox_members (inbox_id, user_id)
  SELECT i.id, p.user_id
  FROM inboxes i
  JOIN profiles p ON p.account_id = i.account_id
  ON CONFLICT (inbox_id, user_id) DO NOTHING;

  -- (7) broadcasts.inbox_id = inbox da conta (nullable — contas sem inbox
  -- ficam NULL e o runner resolve/erra no envio).
  UPDATE broadcasts b
  SET inbox_id = (
    SELECT i.id FROM inboxes i
    WHERE i.account_id = b.account_id
    ORDER BY i.created_at, i.id
    LIMIT 1
  )
  WHERE b.inbox_id IS NULL;
END $$;

-- ============================================================
-- 7. NOT NULL + UNIQUE + índices (DDL no nível transacional do topo)
-- ============================================================
ALTER TABLE whatsapp_config ALTER COLUMN inbox_id SET NOT NULL;
ALTER TABLE conversations   ALTER COLUMN inbox_id SET NOT NULL;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'whatsapp_config_inbox_id_key'
  ) THEN
    ALTER TABLE whatsapp_config ADD CONSTRAINT whatsapp_config_inbox_id_key UNIQUE (inbox_id);
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_conversations_inbox ON conversations(inbox_id);
CREATE INDEX IF NOT EXISTS idx_broadcasts_inbox    ON broadcasts(inbox_id);

-- Identidade da conversa: uma por (inbox, contato).
CREATE UNIQUE INDEX IF NOT EXISTS idx_one_conv_per_inbox_contact
  ON conversations(inbox_id, contact_id);

-- ============================================================
-- 8. RLS — TABELAS NOVAS
-- ============================================================

-- ---- inboxes ----------------------------------------------------
-- SELECT por can_access_inbox (agente vê só os seus; admin vê todos);
-- escrita (criar/editar/excluir canal) é settings-class = admin+.
DROP POLICY IF EXISTS inboxes_select ON inboxes;
DROP POLICY IF EXISTS inboxes_insert ON inboxes;
DROP POLICY IF EXISTS inboxes_update ON inboxes;
DROP POLICY IF EXISTS inboxes_delete ON inboxes;
CREATE POLICY inboxes_select ON inboxes FOR SELECT USING (can_access_inbox(id));
CREATE POLICY inboxes_insert ON inboxes FOR INSERT WITH CHECK (is_account_member(account_id, 'admin'));
CREATE POLICY inboxes_update ON inboxes FOR UPDATE USING (is_account_member(account_id, 'admin'));
CREATE POLICY inboxes_delete ON inboxes FOR DELETE USING (is_account_member(account_id, 'admin'));

-- ---- inbox_members ---------------------------------------------
-- Qualquer membro da conta lê a composição dos inboxes da sua conta;
-- só admin+ altera.
DROP POLICY IF EXISTS inbox_members_select ON inbox_members;
DROP POLICY IF EXISTS inbox_members_modify ON inbox_members;
CREATE POLICY inbox_members_select ON inbox_members FOR SELECT USING (
  EXISTS (SELECT 1 FROM inboxes i WHERE i.id = inbox_members.inbox_id AND is_account_member(i.account_id))
);
CREATE POLICY inbox_members_modify ON inbox_members FOR ALL USING (
  EXISTS (SELECT 1 FROM inboxes i WHERE i.id = inbox_members.inbox_id AND is_account_member(i.account_id, 'admin'))
) WITH CHECK (
  EXISTS (SELECT 1 FROM inboxes i WHERE i.id = inbox_members.inbox_id AND is_account_member(i.account_id, 'admin'))
);

-- ---- contact_inboxes -------------------------------------------
DROP POLICY IF EXISTS contact_inboxes_select ON contact_inboxes;
DROP POLICY IF EXISTS contact_inboxes_modify ON contact_inboxes;
CREATE POLICY contact_inboxes_select ON contact_inboxes FOR SELECT USING (can_access_inbox(inbox_id));
CREATE POLICY contact_inboxes_modify ON contact_inboxes FOR ALL USING (
  can_access_inbox(inbox_id) AND is_account_member(account_id, 'agent')
) WITH CHECK (
  can_access_inbox(inbox_id) AND is_account_member(account_id, 'agent')
);

-- ============================================================
-- 9. RLS REWRITE — conversations / messages / message_reactions
--
-- Troca o isolamento de "membro da conta" para "acessa o inbox".
-- Leitura = can_access_inbox; escrita = can_access_inbox + agent+.
-- Inserts do webhook/cron usam service-role e ignoram RLS (como antes).
-- ============================================================

-- ---- conversations ---------------------------------------------
DROP POLICY IF EXISTS conversations_select ON conversations;
DROP POLICY IF EXISTS conversations_insert ON conversations;
DROP POLICY IF EXISTS conversations_update ON conversations;
DROP POLICY IF EXISTS conversations_delete ON conversations;
CREATE POLICY conversations_select ON conversations FOR SELECT USING (can_access_inbox(inbox_id));
CREATE POLICY conversations_insert ON conversations FOR INSERT WITH CHECK (
  can_access_inbox(inbox_id) AND is_account_member(account_id, 'agent')
);
CREATE POLICY conversations_update ON conversations FOR UPDATE USING (
  can_access_inbox(inbox_id) AND is_account_member(account_id, 'agent')
);
CREATE POLICY conversations_delete ON conversations FOR DELETE USING (
  can_access_inbox(inbox_id) AND is_account_member(account_id, 'agent')
);

-- ---- messages --------------------------------------------------
DROP POLICY IF EXISTS messages_select ON messages;
DROP POLICY IF EXISTS messages_modify ON messages;
CREATE POLICY messages_select ON messages FOR SELECT USING (
  EXISTS (SELECT 1 FROM conversations c WHERE c.id = messages.conversation_id AND can_access_inbox(c.inbox_id))
);
CREATE POLICY messages_modify ON messages FOR ALL USING (
  EXISTS (
    SELECT 1 FROM conversations c
    WHERE c.id = messages.conversation_id
      AND can_access_inbox(c.inbox_id)
      AND is_account_member(c.account_id, 'agent')
  )
) WITH CHECK (
  EXISTS (
    SELECT 1 FROM conversations c
    WHERE c.id = messages.conversation_id
      AND can_access_inbox(c.inbox_id)
      AND is_account_member(c.account_id, 'agent')
  )
);

-- ---- message_reactions -----------------------------------------
DROP POLICY IF EXISTS message_reactions_select ON message_reactions;
DROP POLICY IF EXISTS message_reactions_modify ON message_reactions;
CREATE POLICY message_reactions_select ON message_reactions FOR SELECT USING (
  EXISTS (
    SELECT 1 FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE m.id = message_reactions.message_id
      AND can_access_inbox(c.inbox_id)
  )
);
CREATE POLICY message_reactions_modify ON message_reactions FOR ALL USING (
  EXISTS (
    SELECT 1 FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE m.id = message_reactions.message_id
      AND can_access_inbox(c.inbox_id)
      AND is_account_member(c.account_id, 'agent')
  )
) WITH CHECK (
  EXISTS (
    SELECT 1 FROM messages m
    JOIN conversations c ON c.id = m.conversation_id
    WHERE m.id = message_reactions.message_id
      AND can_access_inbox(c.inbox_id)
      AND is_account_member(c.account_id, 'agent')
  )
);

-- ============================================================
-- 10. REALTIME — publicar `inboxes`
-- ============================================================
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'inboxes'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE inboxes;
  END IF;
END $$;
