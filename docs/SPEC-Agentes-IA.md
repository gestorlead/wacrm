# SPEC: wacrm — Agentes de IA

> Feature independente. O onboarding do WhatsApp é tratado em `SPEC-WhatsApp-Onboarding.md` e não deve bloquear esta feature — os agentes funcionam sobre qualquer conexão WhatsApp já existente (e via chat de teste, sem WhatsApp).

## Visão Geral

**Agentes de IA** — motor enxuto inspirado no OpenClaw, configurável por UI.

O motor de IA é enxuto — sem channels múltiplos, sem plugin system, sem subagents. Foco: **LLM + tools + memória de conversa**, tudo dentro do Next.js.

---

## Princípios de Design

1. **Zero código** — usuário configura tudo por UI (sliders, toggles, textareas com placeholders explicativos)
2. **Templates primeiro** — usuário começa de um template (Vendas, Suporte, Agendamento) e customiza
3. **Transparência de custo** — dashboard mostra tokens consumidos e custo estimado em tempo real
4. **Escala humana** — agente sabe quando transferir pra humano (regras + IA)
5. **Multi-tenant nativo** — cada account tem seus próprios agentes, isolados por RLS

---

## Agentes de IA — Detalhamento

```
wacrm (Next.js + Supabase)
│
├── /app/(dashboard)/agents          ← UI de gestão (novo)
│   ├── page.tsx                     ← Lista de agentes
│   ├── new/page.tsx                 ← Criar (escolher template)
│   └── [id]/page.tsx                ← Editar / Dashboard do agente
│
├── /app/api/agent                   ← Motor de IA (novo)
│   ├── route.ts                     ← POST: executa agente (chamado pelo webhook)
│   ├── models/route.ts              ← GET: lista modelos disponíveis
│   └── [id]/
│       ├── route.ts                 ← CRUD do agente
│       ├── stats/route.ts           ← GET: usage/tokens/custo
│       └── test/route.ts            ← POST: testar agente (chat de teste)
│
├── /lib/agent                       ← Lógica do motor (novo)
│   ├── engine.ts                    ← Core: system prompt + tools → LLM → resposta
│   ├── tools.ts                     ← Ferramentas disponíveis (buscar contato, criar deal, etc)
│   ├── context.ts                   ← Constrói contexto da conversa (histórico + compaction)
│   ├── models.ts                    ← Configuração de modelos (providers, preços, fallbacks)
│   ├── knowledge.ts                 ← RAG: indexar e buscar em documentos do usuário
│   └── templates.ts                 ← Templates de agentes (Vendas, Suporte, etc)
│
└── Supabase
    ├── agents                       ← Config de cada agente (nova tabela)
    ├── agent_documents              ← Base de conhecimento (nova tabela)
    ├── agent_conversation_stats     ← Tokens/custo por conversa (nova tabela)
    └── agent_usage_daily            ← Agregado diário por account (nova tabela)
```

---

## Schema do Banco (Novas Tabelas)

### `agents`
```sql
CREATE TABLE agents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  name TEXT NOT NULL,                    -- "Ana - Vendas"
  description TEXT,                      -- "Atende leads do WhatsApp"
  
  -- Modelo
  provider TEXT NOT NULL DEFAULT 'zai',  -- zai | openrouter | anthropic | ollama
  model TEXT NOT NULL DEFAULT 'glm-5.1', -- modelo específico
  fallback_model TEXT,                   -- modelo de fallback (ex: minimax-m3)
  temperature REAL DEFAULT 0.7,
  max_tokens INTEGER DEFAULT 1000,
  
  -- Comportamento
  system_prompt TEXT NOT NULL,           -- instrução principal
  persona TEXT,                          -- "Você é uma vendedora simpática..."
  knowledge_base TEXT[],                 -- IDs de documentos
  
  -- Horário
  active_hours JSONB,                    -- {"days": [1-5], "start": "09:00", "end": "18:00", "tz": "America/Sao_Paulo"}
  out_of_hours_reply TEXT,               -- "Fora do horário de atendimento..."
  
  -- Escalada
  auto_transfer_keywords TEXT[],         -- ["humano", "falar com atendente"]
  transfer_to UUID,                      -- member_id pra transferir
  
  -- Ferramentas (quais tools o agente pode usar)
  enabled_tools TEXT[] DEFAULT '{search_contact,create_deal,send_message}',
  
  -- Status
  is_active BOOLEAN DEFAULT true,
  
  -- Limites
  daily_token_limit BIGINT,              -- teto de tokens por dia
  monthly_cost_limit_cents INTEGER,      -- teto de custo em centavos
  
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);
```

### `agent_documents` (Base de Conhecimento / RAG)
```sql
CREATE TABLE agent_documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  content TEXT NOT NULL,                 -- texto extraído
  source_type TEXT,                      -- manual | pdf | url | csv
  source_url TEXT,
  embedding VECTOR(1536),                -- pgvector (Supabase suporta nativo)
  tokens INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

### `agent_conversation_stats` (Por mensagem)
```sql
CREATE TABLE agent_conversation_stats (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  conversation_id UUID REFERENCES conversations(id) ON DELETE CASCADE,
  message_id UUID REFERENCES messages(id) ON DELETE CASCADE,
  model TEXT,
  input_tokens INTEGER DEFAULT 0,
  output_tokens INTEGER DEFAULT 0,
  cache_read_tokens INTEGER DEFAULT 0,
  total_tokens INTEGER DEFAULT 0,
  cost_cents INTEGER DEFAULT 0,          -- custo em centavos (BRL)
  latency_ms INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);
```

### `agent_usage_daily` (Agregado por dia)
```sql
CREATE TABLE agent_usage_daily (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  agent_id UUID REFERENCES agents(id) ON DELETE CASCADE,
  date DATE NOT NULL DEFAULT CURRENT_DATE,
  total_messages INTEGER DEFAULT 0,
  total_tokens BIGINT DEFAULT 0,
  input_tokens BIGINT DEFAULT 0,
  output_tokens BIGINT DEFAULT 0,
  cost_cents INTEGER DEFAULT 0,
  conversations_count INTEGER DEFAULT 0,
  UNIQUE(account_id, agent_id, date)
);
```

---

## Templates de Agentes (Pré-configurados)

O usuário escolhe um template e customiza. Cada template define: system_prompt, persona, tools, e dicas.

### 1. Template "Vendas / SDR"
```
Persona: Consultora de vendas experiente, amigável e persistente
System Prompt: Você é [nome], consultora da [empresa]. Seu objetivo é qualificar
o lead e conduzi-lo até o fechamento. Faça perguntas estratégicas (BANT). Use o
tom [formal/descontraído]. Nunca invente preços — consulte a tabela. Quando o
lead estiver quente, transfira para um humano.

Tools: search_contact, update_contact_tags, create_deal, move_deal_stage
Horário: Seg-Sex 9h-18h
Escala: "quero falar com vendedor", "humano"
```

### 2. Template "Suporte / Atendimento"
```
Persona: Especialista em suporte técnico, paciente e claro
System Prompt: Você é [nome], do suporte da [empresa]. Resolva dúvidas
usando a base de conhecimento. Se não souber a resposta, diga que vai
consultar e transfira. Nunca invente informações.

Tools: search_knowledge_base, search_contact, create_note
Horário: 24/7 (configurável)
Escala: "falar com gerente", "reclamação"
```

### 3. Template "Agendamento"
```
Persona: Recepcionista eficiente e organizada
System Prompt: Você é [nome], responsável por agendamentos da [empresa].
Colete data/hora preferida, confirme disponibilidade e agende. Envie
lembretes se configurado.

Tools: search_contact, create_appointment, check_availability
Horário: Seg-Sex 9h-18h, Sáb 9h-13h
Escala: "cancelar agendamento", "falar com responsável"
```

### 4. Template "Em Branco"
- Sistema prompt vazio com placeholders guiados
- Sem tools ativas
- Usuário configura tudo do zero

---

## Interface de Usuário (Detalhada)

### Página: /agents (Lista de Agentes)

```
┌─────────────────────────────────────────────────┐
│  Agentes de IA                       [+ Novo Agente] │
├─────────────────────────────────────────────────┤
│                                                  │
│  ┌──────────────┐  ┌──────────────┐            │
│  │ 🟢 Ana       │  │ ⚫ Suporte    │            │
│  │ Vendas       │  │ Desativado   │            │
│  │ 1.2k msgs    │  │ 340 msgs     │            │
│  │ R$ 23,40/mês │  │ R$ 8,10/mês  │            │
│  └──────────────┘  └──────────────┘            │
│                                                  │
│  Resumo do mês:                                  │
│  Total: 1.540 mensagens | R$ 31,50 | 2.1M tokens│
│                                                  │
└─────────────────────────────────────────────────┘
```

### Página: /agents/new (Criar Agente)

**Step 1 — Escolher template**
```
┌─────────────────────────────────────────────────┐
│  Criar novo agente                               │
│                                                  │
│  Escolha um modelo para começar:                 │
│                                                  │
│  ┌─────────┐ ┌─────────┐ ┌──────────┐ ┌──────┐ │
│  │ 💰       │ │ 🎧       │ │ 📅        │ │ ✏️    │ │
│  │ Vendas   │ │ Suporte  │ │ Agendam. │ │ Em   │ │
│  │ Qualifiq │ │ Resolva  │ │ Agende   │ │ Branco│ │
│  │ leads    │ │ dúvidas  │ │ atendim. │ │      │ │
│  └─────────┘ └─────────┘ └──────────┘ └──────┘ │
└─────────────────────────────────────────────────┘
```

**Step 2 — Identidade**
```
┌─────────────────────────────────────────────────┐
│  Identidade do Agente                            │
│                                                  │
│  Nome: [Ana - Vendas_____________________]      │
│  Descrição: [Atende leads do WhatsApp___]       │
│                                                  │
│  Sobre o seu negócio (ajuda a IA a entender):   │
│  ┌─────────────────────────────────────────┐    │
│  │ Empresa: [QQEnglish_____________________] │    │
│  │ Produto: [Curso de inglês online________] │    │
│  │ Público-alvo: [Adultos 25-45_____________] │    │
│  │ Tom de voz: [Amigável ▾]                  │    │
│  │   Options: Formal | Amigável | Descontraído│    │
│  └─────────────────────────────────────────┘    │
│                                                  │
│  💡 Dica: Quanto mais detalhes você der sobre   │
│  seu negócio, melhor a IA vai atender.          │
└─────────────────────────────────────────────────┘
```

**Step 3 — Personalidade (System Prompt)**
```
┌─────────────────────────────────────────────────┐
│  Personalidade e Comportamento                   │
│                                                  │
│  Como o agente deve se comportar?                │
│  ┌─────────────────────────────────────────┐    │
│  │ Você é a Ana, consultora de vendas da    │    │
│  │ QQEnglish. Seu objetivo é qualificar     │    │
│  │ leads e agendar a aula experimental.     │    │
│  │ Seja amigável, faça perguntas sobre os   │    │
│  │ objetivos do aluno. Apresente os planos  │    │
│  │ quando o lead demonstrar interesse.      │    │
│  │                                          │    │
│  │ Nunca invente preços. Se não souber,     │    │
│  │ diga que vai verificar.                  │    │
│  └─────────────────────────────────────────┘    │
│                                                  │
│  📋 Guias rápidos (clique para inserir):        │
│  • Como qualificar leads (BANT)                  │
│  • Como lidar com objeções                       │
│  • Como agendar follow-up                        │
│                                                  │
│  Regras importantes:                             │
│  ☑ Sempre cumprimentar pelo nome                 │
│  ☑ Usar emojis com moderação                     │
│  ☐ Não enviar links sem pedir                    │
│  ☑ Perguntar idade do aluno (kids vs adults)     │
│                                                  │
│  Quando transferir para humano:                  │
│  [Palavras-chave: "humano", "vendedor"___]      │
│  ☑ Transferir se lead pedir desconto             │
│  ☑ Transferir se IA não souber responder 2x     │
└─────────────────────────────────────────────────┘
```

**Step 4 — Conhecimento (RAG)**
```
┌─────────────────────────────────────────────────┐
│  Base de Conhecimento                            │
│                                                  │
│  O agente usa estes documentos para responder.   │
│  Arraste arquivos ou cole texto:                 │
│                                                  │
│  ┌─────────────────────────────────────────┐    │
│  │ 📄 Tabela de Preços 2026.pdf    [X]     │    │
│  │    1.2k tokens · indexado                │    │
│  │ 📄 FAQ - Dúvidas Comuns.txt     [X]     │    │
│  │    800 tokens · indexado                 │    │
│  │                                          │    │
│  │ [+ Arraste arquivos aqui]                │    │
│  │    PDF, TXT, CSV, DOCX até 5MB           │    │
│  └─────────────────────────────────────────┘    │
│                                                  │
│  Ou adicione uma URL:                            │
│  [https://qqenglish.com.br_________] [Importar] │
│                                                  │
│  Ou escreva diretamente:                         │
│  [+ Escrever anotação]                           │
│                                                  │
│  💡 Você pode atualizar a base a qualquer        │
│  momento. O agente usa instantaneamente.         │
└─────────────────────────────────────────────────┘
```

**Step 5 — Modelo e Custo**
```
┌─────────────────────────────────────────────────┐
│  Modelo de IA e Orçamento                        │
│                                                  │
│  Modelo principal:                               │
│  ○ Econômico (GLM-5.1) — ~R$ 0,02/conversa      │
│  ● Recomendado (GLM-5.2) — ~R$ 0,05/conversa    │
│  ○ Premium (Claude Sonnet) — ~R$ 0,30/conversa  │
│                                                  │
│  Modelo de fallback (se o principal cair):       │
│  [MiniMax M3 ▾] — ~R$ 0,03/conversa             │
│                                                  │
│  Criatividade: [────●─────] Equilibrado (0.7)   │
│  Máx. tokens por resposta: [1000]                │
│                                                  │
│  Limites:                                        │
│  Teto diário: [50.000] tokens (~R$ 5/dia)       │
│  Teto mensal: [R$ 100____]                       │
│                                                  │
│  ⚠️ Se atingir o limite, o agente pausa e       │
│  transfere todas as conversas para humano.       │
│                                                  │
│  💡 Estimativa baseada em conversas anteriores.  │
│  Você pode ajustar quando quiser.                │
└─────────────────────────────────────────────────┘
```

**Step 6 — Horário**
```
┌─────────────────────────────────────────────────┐
│  Horário de Atendimento                          │
│                                                  │
│  Dias ativos:                                    │
│  ☑ Seg  ☑ Ter  ☑ Qua  ☑ Qui  ☑ Sex  ☐ Sáb  ☐ Dom│
│                                                  │
│  Horário: [09:00] às [18:00]                    │
│  Fuso: [America/Sao_Paulo ▾]                    │
│                                                  │
│  Fora do horário:                                │
│  ☑ Responder com mensagem automática             │
│  Mensagem:                                       │
│  [Oi! No momento estamos fora do expediente...] │
│                                                  │
│  ☑ Transferir para humano fora do horário        │
└─────────────────────────────────────────────────┘
```

### Página: /agents/[id] (Dashboard do Agente)

```
┌─────────────────────────────────────────────────┐
│  🟢 Ana - Vendas              [Editar] [Pausar] │
├─────────────────────────────────────────────────┤
│                                                  │
│  Hoje          |  Este Mês      |  Total         │
│  47 mensagens  |  1.2k mensagens|  8.4k mensagens│
│  R$ 1,20       |  R$ 23,40      |  R$ 184,00     │
│  85k tokens    |  2.1M tokens    |  15M tokens    │
│                                                  │
│  ┌──────────────────────────────────────┐       │
│  │ 📊 Consumo Diário (últimos 30 dias)   │       │
│  │     ▁▂▅▇▆▃▁▂▄▆▇▅▂▁▂▅▇▆▃▁▂▄▆        │       │
│  │     Custo    Tokens    Conversas      │       │
│  └──────────────────────────────────────┘       │
│                                                  │
│  ┌──────────────────┐  ┌──────────────────┐     │
│  │ 🧪 Testar Agente  │  │ 📋 Últimas conv.  │     │
│  │                   │  │                   │     │
│  │ [Chat de teste]   │  │ Maria: "Quero..." │     │
│  │                   │  │ João: "Preço..."  │     │
│  │ Resposta aparece  │  │ Ana: "Agendar..." │     │
│  │ com tokens usados │  │                   │     │
│  └──────────────────┘  └──────────────────┘     │
│                                                  │
│  Configuração rápida:                            │
│  • Modelo: GLM-5.2     [Trocar]                  │
│  • Horário: 9h-18h     [Editar]                  │
│  • Base de conhecimento: 3 docs  [Gerenciar]    │
│  • Transferências: 12 no mês                      │
└─────────────────────────────────────────────────┘
```

---

## Motor de IA (engine.ts)

O core inspirado no OpenClaw, mas enxuto:

```typescript
// Pseudocódigo do engine

interface AgentRunInput {
  agentId: string;
  conversationId: string;
  userMessage: string;
  conversationHistory: Message[];
}

interface AgentRunOutput {
  reply: string;
  toolCalls: ToolCall[];
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    costCents: number;
  };
  shouldTransfer: boolean;
  transferReason?: string;
}

async function runAgent(input: AgentRunInput): Promise<AgentRunOutput> {
  // 1. Carregar config do agente (system_prompt, tools, modelo, limites)
  const agent = await getAgent(input.agentId);
  
  // 2. Construir contexto
  //    - System prompt + persona
  //    - Histórico (com compaction se > N mensagens)
  //    - RAG: buscar documentos relevantes
  //    - Dados do contato (do CRM)
  const context = await buildContext(agent, input);
  
  // 3. Verificar limites
  //    - Horário ativo
  //    - Teto diário/mensal de tokens e custo
  //    - Se excedido: retornar mensagem padrão + shouldTransfer
  if (!checkLimits(agent)) {
    return outOfHoursOrLimit(agent);
  }
  
  // 4. Chamar LLM (com tools)
  //    - Modelo principal → se falhar (rate limit/erro) → fallback
  //    - Stream: não (MVP), aguardar resposta completa
  const response = await callLLM({
    model: agent.model,
    fallback: agent.fallback_model,
    messages: context.messages,
    tools: getEnabledTools(agent.enabled_tools),
    temperature: agent.temperature,
    maxTokens: agent.max_tokens,
  });
  
  // 5. Executar tool calls (se houver)
  //    - search_contact, create_deal, etc
  //    - Se tool retornar "transfer": shouldTransfer = true
  const toolResults = await executeTools(response.toolCalls, input);
  
  // 6. Se houve tool call, fazer segunda chamada pro LLM com os resultados
  let finalReply = response.content;
  if (response.toolCalls?.length > 0) {
    const followUp = await callLLM({
      model: agent.model,
      messages: [...context.messages, response, ...toolResults],
      temperature: agent.temperature,
    });
    finalReply = followUp.content;
  }
  
  // 7. Detectar escalação (keywords ou decisão da IA)
  const shouldTransfer = detectTransfer(finalReply, agent.auto_transfer_keywords);
  
  // 8. Registrar usage (tokens, custo)
  await recordUsage({
    agentId: agent.id,
    accountId: agent.account_id,
    conversationId: input.conversationId,
    model: response.model,
    inputTokens: response.usage.input,
    outputTokens: response.usage.output,
    costCents: calculateCost(response.usage, agent.model),
  });
  
  return {
    reply: finalReply,
    toolCalls: response.toolCalls,
    usage: { ... },
    shouldTransfer,
  };
}
```

### Compaction de Contexto

Quando a conversa excede 20 mensagens, as 10 mais antigas são resumidas:

```typescript
async function compactHistory(messages: Message[]): Promise<Message[]> {
  if (messages.length <= 20) return messages;
  
  const oldMessages = messages.slice(0, messages.length - 10);
  const recentMessages = messages.slice(-10);
  
  // LLM barato pra resumir (GLM-4.7-Flash = grátis)
  const summary = await callLLM({
    model: 'glm-4.7-flash',
    messages: [{
      role: 'user',
      content: `Resuma esta conversa em pontos-chave:\n${formatMessages(oldMessages)}`
    }],
  });
  
  return [
    { role: 'system', content: `Resumo da conversa anterior: ${summary}` },
    ...recentMessages,
  ];
}
```

---

## Ferramentas (Tools)

Cada tool é uma função que o agente pode chamar via function calling:

### `search_contact`
Busca contato no CRM por nome, telefone ou email.
```json
{
  "name": "search_contact",
  "description": "Buscar um contato no CRM pelo nome, telefone ou email",
  "parameters": {
    "query": { "type": "string", "description": "Nome, telefone ou email" }
  }
}
```

### `create_deal`
Cria um negócio no pipeline.
```json
{
  "name": "create_deal",
  "description": "Criar um novo negócio no pipeline de vendas",
  "parameters": {
    "contact_phone": { "type": "string" },
    "title": { "type": "string" },
    "value": { "type": "number", "description": "Valor em reais" },
    "pipeline_stage": { "type": "string" }
  }
}
```

### `move_deal_stage`
Move um deal para outra etapa do pipeline.

### `add_tag`
Adiciona tag a um contato (ex: "quente", "follow-up").

### `add_note`
Adiciona uma anotação ao contato.

### `search_knowledge`
Busca na base de conhecimento do agente (RAG via pgvector).

### `transfer_to_human`
Transfere a conversa para um atendente humano. Encerra a atuação do agente.

### `schedule_message`
Agenda uma mensagem de follow-up (ex: "enviar lembrete amanhã às 10h").

---

## Modelos Suportados

| Provider | Modelo | Input $/M | Output $/M | Uso |
|----------|--------|-----------|------------|-----|
| Z.AI | glm-5.1 | Grátis (rate limited) | Grátis | Econômico |
| Z.AI | glm-5.2 | $0.60 | $2.20 | Recomendado |
| Z.AI | glm-4.7-flash | Grátis | Grátis | Compaction |
| OpenRouter | minimax-m3 | $0.15 | $0.60 | Fallback |
| OpenRouter | deepseek-chat | $0.14 | $0.28 | Fallback barato |
| OpenRouter | kimi-k2 | $0.60 | $2.50 | Alternativa |
| Anthropic | claude-sonnet-4 | $3.00 | $15.00 | Premium |
| Ollama | (local) | Grátis | Grátis | Self-hosted |

O admin do wacrm configura as API keys globalmente. O usuário só escolhe "Econômico / Recomendado / Premium".

---

## Fluxo de Integração com WhatsApp

```
Mensagem chega no WhatsApp
  ↓
Meta Webhook → wacrm /api/whatsapp/webhook (JÁ EXISTE)
  ↓
Salva mensagem no banco (JÁ EXISTE)
  ↓
Verifica se a conversa tem agente ativo (NOVO)
  ↓
Se sim → POST /api/agent (NOVO)
  ↓
engine.ts processa
  ↓
Resposta enviada via WhatsApp API (JÁ EXISTE)
  ↓
Stats registradas (NOVO)
```

O webhook existente do wacrm já recebe mensagens. Só precisamos adicionar um **hook** depois de salvar a mensagem inbound: se a conversa tem um agente ativo atribuído, chamar o engine.

---

## Considerações de Custo (Por Tenant)

Cada tenant tem limites configuráveis:

| Limite | Default | Quem configura |
|--------|---------|----------------|
| Tokens por dia | 50.000 (~R$ 5/dia) | Usuário na UI |
| Custo mensal | R$ 100 | Usuário na UI |
| Mensagens por dia | 500 | Plano (futuro) |
| Modelo disponível | Econômico + Recomendado | Plano (futuro) |

Quando o agente atinge um limite:
1. Para de responder automaticamente
2. Envia mensagem: "Vou transferir você para nosso time humano"
3. Marca a conversa como `needs_human = true`
4. Notifica o dashboard

---

## Roadmap de Implementação

> O onboarding do WhatsApp é uma feature separada (ver `SPEC-WhatsApp-Onboarding.md`) e não bloqueia estes sprints — o chat de teste permite validar agentes sem WhatsApp.

### Sprint 1 — Fundação IA (1-2 semanas)
- [ ] Criar tabelas (agents, agent_documents, agent_conversation_stats, agent_usage_daily)
- [ ] Habilitar pgvector no Supabase
- [ ] `/lib/agent/models.ts` — config de modelos e preços
- [ ] `/lib/agent/engine.ts` — core do motor (sem tools ainda, só chat)
- [ ] `/lib/agent/context.ts` — histórico + compaction
- [ ] Hook no webhook: chamar engine quando agente ativo

### Sprint 2 — UI (1-2 semanas)
- [ ] `/agents` — lista com cards e stats
- [ ] `/agents/new` — wizard de criação (6 steps)
- [ ] `/agents/[id]` — dashboard com gráficos
- [ ] Templates pré-configurados (4)
- [ ] Chat de teste (testar sem WhatsApp)

### Sprint 3 — Tools e RAG (1-2 semanas)
- [ ] Implementar tools (search_contact, create_deal, add_tag, etc)
- [ ] Upload de documentos (PDF, TXT, CSV)
- [ ] Indexação com pgvector (embeddings)
- [ ] search_knowledge tool funcional
- [ ] Detecção de transferência (keywords + IA)

### Sprint 4 — Polish e Limites (1 semana)
- [ ] Dashboard de consumo com gráficos (Tremor)
- [ ] Alertas de limite (email + UI)
- [ ] Horário de atendimento (fora do horário → mensagem automática)
- [ ] Logs de conversa (para admin audutar respostas do agente)
- [ ] Testes E2E

**Total estimado: 4-6 semanas** (4 sprints de IA).

---

## Notas Técnicas

- **Sem processo separado**: o engine roda dentro do Next.js (serverless-friendly)
- **Sem WebSocket**: MVP usa polling/webhook, não precisa de realtime
- **pgvector**: já suportado pelo Supabase Cloud, só habilitar a extensão
- **Rate limit handling**: engine faz retry com backoff exponencial antes de cair pro fallback
- **Observabilidade**: cada chamada registra model, tokens, custo e latência — transparente pra tenants e admin
- **Multi-tenant**: todas as tabelas têm `account_id` + RLS
