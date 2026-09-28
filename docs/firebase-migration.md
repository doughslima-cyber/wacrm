# Migração Supabase → Firebase / Google Cloud

Status: **proposta — aguardando aprovação**
Projeto Firebase de destino: `crm-zap-cbd5d`
Data: 2026-09-28

## 1. Objetivo e premissas

Tirar o WACRM do Supabase e rodar tudo dentro do projeto `crm-zap-cbd5d`
(Firebase + Google Cloud, uma fatura, um console), **mantendo o Postgres**.

Premissas que moldam o plano:

- **Não há dados para migrar.** Ainda não existe projeto Supabase em uso, então
  é instalação limpa: sem importação de usuários, arquivos ou linhas. Isso
  corta a parte mais arriscada de qualquer migração.
- **O schema continua o mesmo.** As 42 migrations em `supabase/migrations`
  (36 tabelas, 155 políticas RLS, 35 funções, 18 triggers, full-text e
  `pgvector`) rodam no Cloud SQL, com uma camada de compatibilidade aplicada
  antes delas.
- **O diff contra o upstream (`ArnasDon/wacrm`) deve ficar concentrado em
  poucos arquivos**, para as correções do projeto original continuarem
  entrando com merge normal.

## 2. Mapa de substituição

| Hoje (Supabase) | Depois (Firebase / GCP) | Onde muda no código |
|---|---|---|
| Postgres gerenciado | **Cloud SQL for PostgreSQL** (`southamerica-east1`) | nada: migrations iguais |
| PostgREST embutido (`.from()`, `.rpc()`) | **PostgREST no Cloud Run**, privado, atrás de um proxy no Next | `src/lib/supabase/*` |
| RLS com `auth.uid()` | **RLS mantida**: `auth.uid()` recriada lendo o JWT emitido pelo nosso proxy | 1 migration de compat |
| Supabase Auth (email + senha) | **Firebase Authentication** + session cookie | páginas de auth, middleware |
| Storage (`avatars`, `flow-media`, `chat-media`) | **Cloud Storage for Firebase** | `src/lib/storage/upload-media.ts`, `src/lib/whatsapp/mirror-inbound-media.ts`, `src/components/settings/profile-form.tsx` |
| Realtime (`postgres_changes` em 6 tabelas) | **Firestore como canal de sinais**, alimentado por `pg_notify` → relay | 7 hooks e componentes |
| Hospedagem (Docker / Hostinger) | **Cloud Run** (`southamerica-east1`, com o `Dockerfile` existente) atrás do **Firebase Hosting** | `firebase.json`, `infra/` |
| Cron externo (`/api/automations/cron`, `/api/flows/cron`) | **Cloud Scheduler** | nenhum |

Não mudam: a integração WhatsApp/Meta, o assistente de IA, a API pública
`/api/v1` e o `mcp-server/` (que só fala com a API pública por HTTP).

## 3. Arquitetura alvo

```
Navegador
  │  Firebase Auth SDK (login)          Firestore onSnapshot (sinais realtime)
  │  cookie de sessão                          ▲
  ▼                                            │
Firebase Hosting → Cloud Run — Next.js 16     │
  ├─ middleware: valida o session cookie       │
  ├─ /api/rest/*  ──(JWT curto, HS256)──► PostgREST (Cloud Run, privado)
  ├─ rotas /api/* existentes                        │
  └─ server components                              ▼
                                        Cloud SQL Postgres (RLS ativa)
                                                    │ pg_notify
                                                    ▼
                                 relay-realtime (Cloud Run, 1 instância)
                                                    │
                                                    └──► Firestore /signals
Cloud Storage for Firebase ◄── uploads (regras por conta)
Cloud Scheduler ──► /api/automations/cron, /api/flows/cron
```

### 3.1 Por que PostgREST, e não Firebase Data Connect nem reescrever as queries

As 419 chamadas `.from()` / `.rpc()` usam o query builder do supabase-js, que
é um cliente PostgREST. Se um PostgREST rodar na frente do Cloud SQL, essas
chamadas continuam funcionando **sem mudar nenhuma delas**: joins embutidos,
`count: 'exact'`, `.or()`, `.ilike()` e RPCs incluídos.

- **Data Connect** exige redefinir o schema em GraphQL, controla as próprias
  migrations e não roda as funções PL/pgSQL nem a RLS existentes. Seria
  reescrever as 419 queries de novo.
- **Reescrever com Drizzle/Kysely** dá um código mais "nativo", mas são
  semanas mexendo em 172 arquivos, e a RLS deixaria de proteger o que os
  componentes cliente leem direto.

### 3.2 Como a RLS continua valendo

1. O navegador nunca fala com o PostgREST. Ele chama `/api/rest/*` no próprio
   Next (mesma origem, então a CSP `connect-src 'self'` já cobre).
2. O proxy valida o session cookie do Firebase, busca o `id` (uuid) do usuário
   em `auth.users` pelo `firebase_uid` e emite um JWT de ~60s
   (`{ sub: <uuid>, role: "authenticated" }`), assinado com um segredo que só
   o proxy e o PostgREST conhecem.
3. O PostgREST troca para o papel `authenticated` e expõe os claims em
   `request.jwt.claims`. Recriamos `auth.uid()`, `auth.role()` e `auth.jwt()`
   com a mesma assinatura do Supabase, lendo esses claims. As 155 políticas e
   as 95 referências a `auth.uid()` ficam como estão.
4. O código com service role (`src/lib/*/admin-client.ts` e as rotas de
   webhook/config) recebe um JWT com `role: "service_role"`, papel com
   `BYPASSRLS`, igual ao Supabase.

### 3.3 Identidade: UID do Firebase × uuid do schema

O schema usa `uuid` em todas as FKs para `auth.users` (39 referências), e o
UID do Firebase não é uuid. A migration de compat cria uma tabela real
`auth.users (id uuid pk, firebase_uid text unique, email, raw_user_meta_data
jsonb, created_at)`. No primeiro login, o servidor insere a linha, e o
trigger existente `on_auth_user_created` cria o perfil como hoje. Nenhuma
coluna do schema muda de tipo.

### 3.4 Realtime

Os hooks assinam `postgres_changes` em `messages`, `conversations`,
`message_reactions`, `flow_runs`, `member_presence` e `notifications`.

- Um trigger `AFTER INSERT/UPDATE/DELETE` nessas 6 tabelas chama
  `pg_notify('changes', {table, op, id, account_id})`. Isso cobre qualquer
  caminho de escrita (webhook, automações, UI) sem mexer neles.
- O `relay-realtime` (Node, Cloud Run, `min-instances=1`) faz `LISTEN` e grava
  um **sinal**, não a linha inteira, em
  `signals/{account_id}/tables/{table}`.
- O cliente assina esse doc com `onSnapshot` e busca a linha nova via
  `/api/rest`. O conteúdo das mensagens nunca sai do Postgres.
- As Security Rules do Firestore só permitem ler `signals/{accountId}` a quem
  tem `accountId` nas custom claims. O proxy de sessão grava essas claims.
- Um wrapper `channel()` imita a API do supabase-js, para os 7 pontos de uso
  mudarem o mínimo possível.

## 4. Fases

Toda a infraestrutura nova fica em `infra/`, com `package.json` próprio, para
não misturar com as dependências do app nem com a pasta `supabase/` do upstream.

Tamanho: **P** ≈ até 1 dia, **M** ≈ 2–3 dias, **G** ≈ 4–5 dias.
Estimativa total: **3 a 4 semanas** de trabalho focado.

### Fase 0 — Spike de infraestrutura (M) · *gate de go/no-go*

Objetivo: provar as três apostas técnicas antes de tocar no app.

- [x] Ativar o plano Blaze em `crm-zap-cbd5d` e as APIs: Cloud SQL, Cloud Run,
      Secret Manager, Cloud Scheduler, Firestore, Storage, App Hosting.
- [x] Criar o Cloud SQL `wacrm-pg`, Postgres 17 (mesma major do Supabase), em
      `southamerica-east1`, tier `db-f1-micro` para o spike (redimensionável).
      Acesso só pelo Cloud SQL connector (IAM + TLS), sem redes autorizadas.
- [x] Escrever `infra/db/compat/000_supabase_compat.sql`: papéis `anon`,
      `authenticated`, `service_role` e `authenticator`; schema `auth` com
      `users`, `uid()`, `role()` e `jwt()`; schema `extensions`; stubs
      `storage.buckets` e `storage.objects`; publicação `supabase_realtime`
      (sem efeito, só para as migrations rodarem).
- [x] Aplicar compat + 42 migrations **sem alterar nenhuma delas** e rodar
      `supabase/ci/verify-schema.sql`.
- [x] Subir o PostgREST no Cloud Run com `postgrest/postgrest:v16.3`, a versão
      que o Supabase CLI fixa hoje. O acesso exige IAM: o chamador manda o
      token do Google em `X-Serverless-Authorization` e o JWT do app em
      `Authorization`.
- [x] Teste de RLS: com JWT do usuário A, `select` em `contacts` devolve só as
      linhas da conta de A, e um insert na conta de B falha.
- [x] Teste de paridade: rodar 5 queries reais do app (uma com join embutido,
      uma com `count: 'exact'`, uma RPC `SECURITY DEFINER`, uma com `.or()`,
      a `match_ai_knowledge_semantic`) e comparar com o esperado.
- [x] Confirmar se o App Hosting roda em `southamerica-east1`. **Não roda**
      (só `us-central1`, `us-east4`, `us-east5`, `europe-west4`, `asia-east1`,
      `asia-southeast1`). Decisão: Next.js no Cloud Run em São Paulo, com o
      Firebase Hosting na frente.
- [x] Ler `node_modules/next/dist/docs` (ver `AGENTS.md`) para ver como o
      Next 16 trata `middleware.ts` × `proxy.ts`. **Resultado:** o
      `middleware.ts` está deprecado e roda no Edge; o `proxy.ts` roda sempre
      em Node.js (`02-guides/upgrading/version-16.md`). Na Fase 2, renomear
      para `proxy.ts` e validar o cookie com `firebase-admin`.

**Critério de saída:** migrations aplicadas limpas, teste de RLS passando e
paridade das 5 queries. Se alguma aposta falhar, o plano volta para revisão
antes da Fase 1.

**Resultado (2026-09-28): aprovado.**

- `infra/db/migrate.mjs` aplicou o compat e as 42 migrations do upstream sem
  editar nenhuma, e o `verify-schema.sql` passou. O Cloud SQL aceitou
  `service_role` com `BYPASSRLS`.
- Smoke test do PostgREST: sem token do Google dá 403; com token e sem JWT
  entra como `anon` e a RLS devolve `[]`; JWT forjado dá 401 (`PGRST301`).
- `infra/db/spike/phase0.mjs` (`@supabase/postgrest-js` 2.108.2, a mesma
  versão do app): **14/14 passaram**. Foram 7 testes de RLS (leitura,
  insert, update, anon, service_role, JWT forjado e RPC de outra conta) e
  7 de paridade: join com hint de FK, `count: 'exact'` + `.or()`/`ilike`,
  `head: true`, `!inner` filtrado, `filter_contacts_by_tags`,
  `match_ai_knowledge_fts` e `match_ai_knowledge_semantic`.
- Latência de uma query simples vista da máquina local: p50 69 ms, p90 81 ms.
  De dentro do Cloud Run, na mesma região, deve ser menor.

Recursos criados: Cloud SQL `wacrm-pg` (database `wacrm`); Cloud Run
`postgrest`; service accounts `postgrest` e `wacrm-web` (`wacrm-web`
com `run.invoker` no PostgREST); secrets `pg-postgres-password`,
`pg-authenticator-password`, `pgrst-jwt-secret` e `pgrst-db-uri`.

### Fase 1 — Camada de dados (M)

- [ ] Rota `src/app/api/rest/[...path]/route.ts`: valida a sessão, emite o JWT
      curto e repassa método, headers `Prefer`/`Range` e corpo ao PostgREST.
- [ ] Reescrever `src/lib/supabase/client.ts` e `server.ts` para montar um
      `PostgrestClient` apontando para `/api/rest` (browser) ou direto para o
      PostgREST interno (servidor), mantendo o shape `{ from, rpc, auth,
      storage, channel }`.
- [ ] Juntar os três `admin-client.ts` (ai, automations, flows) e os usos
      diretos de `SUPABASE_SERVICE_ROLE_KEY` em um único `createAdminClient()`.
- [ ] Trocar os tipos importados de `@supabase/supabase-js` pelos equivalentes
      de `@supabase/postgrest-js`.

**Critério de saída:** `npm run typecheck` e `npm test` verdes; inbox, contatos
e pipelines carregam dados reais com um usuário criado à mão.

### Fase 2 — Autenticação (G)

- [ ] Firebase Auth com provedor email/senha e templates de email em pt-BR.
- [ ] Páginas `/login`, `/signup`, `/forgot-password` e reset: `signInWithPassword`,
      `signUp`, `resetPasswordForEmail` e `updateUser` passam a usar o SDK do
      Firebase.
- [ ] `POST /api/auth/session`: recebe o ID token, cria o session cookie,
      faz upsert em `auth.users` e grava as custom claims `accountIds`.
      `DELETE` faz o `signOut`.
- [ ] Middleware: trocar `supabase.auth.getUser()` pela validação do cookie,
      mantendo as regras de redirecionamento e o fluxo de convite
      (`?invite=` → `/join/<token>`).
- [ ] Shim `auth.getUser()` / `auth.getSession()` / `onAuthStateChange` no
      cliente novo, para as 46 chamadas continuarem funcionando. Revisar à mão
      os usos de `access_token` em `src/app/api/whatsapp/config/route.ts`,
      `broadcast/route.ts` e `verify-registration/route.ts`.
- [ ] Convites: revisar `redeem_invitation` e `peek_invitation`, que cruzam
      email com `auth.users`, e atualizar as custom claims ao entrar numa conta.

**Critério de saída:** cadastro → confirmação → login → convite → entrar na
conta → trocar senha → logout, tudo funcionando de ponta a ponta.

### Fase 3 — Storage (P)

- [ ] Três prefixos no bucket padrão: `avatars/`, `flow-media/`, `chat-media/`.
- [ ] `storage.rules`: leitura pública nos três (como hoje); escrita só em
      `{prefixo}/{accountId}/...` com `accountId` nas claims, respeitando os
      limites de tamanho e MIME que as migrations 008, 016 e 023 definem.
- [ ] Adaptar `upload-media.ts` (upload, URL pública, remoção),
      `mirror-inbound-media.ts` (upload no servidor com Admin SDK) e
      `profile-form.tsx`.
- [ ] CSP em `next.config.ts`: trocar `*.supabase.co` em `media-src` e
      `connect-src` pelos hosts do Firebase Storage e do Firestore.

### Fase 4 — Realtime (G)

- [ ] Migration nova `043_realtime_notify.sql` com o trigger `pg_notify` nas 6
      tabelas.
- [ ] Serviço `relay-realtime/` (Node, Cloud Run, `min-instances=1`): `LISTEN`,
      reconexão com backoff e escrita dos sinais no Firestore.
- [ ] `firestore.rules`: leitura de `signals/{accountId}/**` por membros,
      escrita bloqueada para clientes.
- [ ] Wrapper `channel()` e adaptação de `use-realtime.ts`,
      `use-total-unread.ts`, `use-unread-notifications.ts`,
      `use-browser-notifications.ts`, `use-presence.ts`,
      `components/inbox/message-thread.tsx` e `notifications/page.tsx`.
- [ ] Fallback: se o sinal ficar 60s parado com a aba ativa, fazer polling.

**Critério de saída:** mensagem enviada pelo webhook aparece na inbox aberta em
menos de 2s, e a presença de outro membro atualiza.

### Fase 5 — Deploy (M)

Segue a skill `firebase-ship`: pré-checagem antes de qualquer deploy.

- [ ] Build com Cloud Build a partir do `Dockerfile` (Node 22, `NEXT_PUBLIC_*`
      como build args) e deploy no Cloud Run `wacrm-web` em
      `southamerica-east1`, com secrets do Secret Manager no runtime
      (`ENCRYPTION_KEY`, `META_APP_SECRET`, segredo do JWT do PostgREST,
      `AUTOMATION_CRON_SECRET`).
- [ ] `firebase.json`: Hosting com rewrite de `**` para o Cloud Run
      `wacrm-web`. Conferir se o CDN do Hosting não guarda HTML por usuário,
      porque o `next.config.ts` manda `s-maxage=300` nas páginas.
- [ ] Trigger do Cloud Build no push para `main`.
- [ ] `engines.node` em `package.json` fixado em `22`.
- [ ] Remover `NEXT_PUBLIC_SUPABASE_*` e `SUPABASE_SERVICE_ROLE_KEY` de
      `.env.local.example` e documentar as variáveis novas.
- [ ] Cloud Scheduler chamando `/api/automations/cron` e `/api/flows/cron` com
      o secret.
- [ ] Apontar o webhook do Meta para a URL do App Hosting e configurar
      `NEXT_PUBLIC_SITE_URL`.
- [ ] Ajustar `.github/workflows/migrations.yml` para aplicar compat +
      migrations no Cloud SQL.
- [ ] Deploy na ordem: regras (Firestore/Storage) → migrations → PostgREST →
      relay → Cloud Run `wacrm-web` → Hosting.

### Fase 6 — Validação (M)

- [ ] Teste de isolamento: dois usuários em contas diferentes tentam ler e
      escrever dados um do outro por `/api/rest`, `/api/*`, Storage e
      Firestore. Tudo deve falhar.
- [ ] Roteiro manual: conectar WhatsApp → receber mensagem → responder com
      áudio → criar contato → mover no pipeline → broadcast → automação com
      Wait → flow → resposta de IA com base de conhecimento → API pública com
      API key → MCP server.
- [ ] Rodar `npm test`, `npm run typecheck` e `npm run build`.
- [ ] Revisar os custos no Billing depois de 48h de uso.

## 5. Decisões para aprovar

São decisões difíceis de reverter depois que a Fase 1 começar.

1. **Cloud SQL + PostgREST** em vez de Data Connect ou reescrita das queries.
2. **Tabela `auth.users` com uuid própria**, com o UID do Firebase numa coluna
   à parte.
3. **Realtime por sinais no Firestore** (só IDs, sem conteúdo) alimentados por
   `pg_notify`.
4. **Tudo em `southamerica-east1`**: Cloud SQL, PostgREST, relay e o Next no
   Cloud Run. O App Hosting ficou de fora porque não existe nessa região
   (decidido em 2026-09-28).
5. **As migrations do upstream nunca são editadas**: toda adaptação vai na
   camada `supabase/compat/` ou em migrations novas, numeradas depois das
   do upstream.

## 6. Riscos

| Risco | Impacto | Mitigação |
|---|---|---|
| PostgREST em versão diferente da do Supabase se comporta diferente | queries quebram sem aviso | fixar a versão; teste de paridade na Fase 0 |
| Um salto a mais (Next → PostgREST) aumenta a latência | telas mais lentas | tudo na mesma região; medir na Fase 0 |
| Relay de realtime cai | inbox para de atualizar sozinha | `min-instances=1`, reconexão e fallback para polling |
| Erro no proxy de JWT abre dados de outra conta | vazamento entre clientes | JWT de 60s, segredo no Secret Manager, teste de isolamento na Fase 6 |
| Custo fixo maior | a fatura sobe mesmo sem uso | Cloud SQL é o item fixo principal; a menor instância dedicada custa algumas dezenas de dólares por mês; o relay com 1 instância soma um pouco |
| Upstream muda `src/lib/supabase/*`, auth ou hooks de realtime | conflito de merge | diff concentrado nesses arquivos; revisar a cada merge do upstream |
| Emails de auth do Firebase caem em spam | usuário não confirma a conta | domínio próprio verificado no Firebase Auth |

## 7. Fora do escopo

- Migração de dados (não existe base em produção).
- Mudanças de funcionalidade no CRM.
- Troca do provedor de IA ou da integração com o Meta.
