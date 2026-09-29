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
`message_reactions`, `member_presence` e `notifications` (o upstream também
publica `flow_runs`, mas nada no app assina essa tabela).

- Um trigger `AFTER INSERT/UPDATE/DELETE` nessas 5 tabelas grava uma linha
  pequena em `app_realtime.changes` (tabela, op, chave primária, as colunas
  que os filtros usam e `account_id`, nunca o conteúdo) e chama
  `pg_notify('app_realtime', '')`. Isso cobre qualquer caminho de escrita
  (webhook, automações, UI) sem mexer neles.
- O log, e não o NOTIFY, é a fonte da verdade: um NOTIFY enviado com o relay
  desconectado se perde, a linha no log não.
- O `relay-realtime` (Node, Cloud Run, 1 instância com CPU sempre alocada)
  faz `LISTEN`, lê as linhas não publicadas em ordem (`FOR UPDATE SKIP
  LOCKED`), agrupa várias mudanças da mesma linha num lote e grava **um
  documento por mudança** em `signals/{account_id}/changes/{seq}`. Um
  documento único por tabela não serviria: o `onSnapshot` entrega só o
  estado mais recente de um documento, então duas mensagens seguidas
  virariam uma. Os documentos expiram por TTL (`expireAt`, 1h).
- O cliente assina `signals/{conta}/changes` com `onSnapshot` e busca a
  linha nova via `/api/rest`. O conteúdo das mensagens nunca sai do
  Postgres, e a RLS decide o que cada usuário recebe.
- As Security Rules do Firestore só permitem ler `signals/{accountId}` a quem
  tem `accountId` nas custom claims. O proxy de sessão grava essas claims.
- Se o Firestore ficar 60s calado, o browser lê o próprio
  log (RPC `realtime_changes_since`). Se achar mudança que o relay não
  entregou, passa a fazer polling a cada 5s até o relay voltar. O mesmo
  polling cobre quem está sem login no SDK do Firebase ou sem a claim.
- O `channel()` do cliente do browser mantém a API do supabase-js, e os
  7 pontos de uso não mudaram.

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

- [x] Rota `src/app/api/rest/[...path]/route.ts`: valida a sessão, emite o JWT
      curto e repassa método, headers `Prefer`/`Range` e corpo ao PostgREST.
- [x] Reescrever `src/lib/supabase/client.ts` e `server.ts` para montar um
      `PostgrestClient` apontando para `/api/rest` (browser) ou direto para o
      PostgREST interno (servidor), mantendo o shape `{ from, rpc, auth,
      storage, channel }`.
- [x] Juntar os três `admin-client.ts` (ai, automations, flows) e os usos
      diretos de `SUPABASE_SERVICE_ROLE_KEY` em um único cliente de service role.
- [x] Trocar os tipos importados de `@supabase/supabase-js` pelos equivalentes
      de `@supabase/postgrest-js`.

**Critério de saída:** `npm run typecheck` e `npm test` verdes; inbox, contatos
e pipelines carregam dados reais com um usuário criado à mão.

**Resultado (2026-09-28): aprovado.**

Validação com dados reais (`npm run dev` contra o Cloud SQL, usuário criado
por `npm run auth:dev-user`):

- Sem cookie: `/inbox` redireciona para `/login`, e `/api/rest` como `anon`
  responde `[]`.
- Com o cookie: `/api/auth/session` devolve o uuid de `auth.users`, e
  `/api/rest/accounts` só a conta do próprio usuário. Inbox, contatos,
  pipelines e o painel carregam, sem erro no console nem no servidor.
- Escrita pela UI: criar um contato (`POST contacts` 201, lista e contagem
  `count=exact` atualizam) e um pipeline (`pipelines` + insert em lote de
  `pipeline_stages`, 201). Um insert sem `account_id` é recusado pela RLS
  (`42501`, 403).
- Caminho do servidor: `GET /api/whatsapp/config` (usa o `createClient()`
  do servidor) responde `no_config`, como esperado para uma conta nova.

Achados no caminho:

- Os quatro secrets da Fase 0 tinham um `\r` no fim (gravados a partir de
  um CRLF). O bash o preservava e o PowerShell o descartava, então a senha
  "certa" dependia do shell. Todos foram regravados sem ele (senhas do
  `postgres` e do `authenticator` trocadas juntas, PostgREST na revisão
  `postgrest-00002`), e as versões antigas desativadas. Ao gravar um secret
  pelo PowerShell, use `--data-file` com um arquivo escrito sem quebra de
  linha, e nunca canalize uma string para o `gcloud`.
- O Cloud Run recusa o ID token de usuário do `gcloud` (401, o `aud` é o
  client OAuth do gcloud). Localmente, o app precisa de um token da
  `wacrm-web` via `--impersonate-service-account` com `--audiences` (ver
  `.env.local.example`).

- `src/lib/supabase/app-client.ts`: `AppClient` estende o `PostgrestClient`
  (`@supabase/postgrest-js` 2.108.2 fixado, a versão da Fase 0) e pendura
  `auth`, `storage` e `channel()`. O tipo `SupabaseClient` agora é esse
  `AppClient`, então os helpers tipados `(supabase: SupabaseClient, …)` só
  trocaram a linha do import (`@/lib/supabase/app-client`).
- `server.ts` fala direto com o PostgREST. `postgrest.ts` assina cada
  request com um JWT de 60s e o ID token do Google (metadata server no Cloud
  Run; localmente, `POSTGREST_ID_TOKEN_COMMAND`). O JWT é emitido a cada
  request, não uma vez por cliente, para tarefas longas (broadcast,
  automação) não enviarem um JWT vencido no meio do caminho.
- `src/lib/supabase/admin.ts` tem o único `supabaseAdmin()`. Os três
  `admin-client.ts` só reexportam esse cliente, e o webhook e
  `whatsapp/config` deixaram de ter cópias próprias. O nome `supabaseAdmin`
  continuou para não mexer nos chamadores nem nos mocks de teste.
- `/api/rest`: aceita só `/<tabela>` e `/rpc/<função>`, descarta o
  `Authorization` do browser e recusa escrita cross-site (`Sec-Fetch-Site` /
  `Origin`). Sem cookie, a request vai como `anon`, como a anon key fazia;
  com cookie inválido, responde 401, para uma sessão morta não aparecer como
  lista vazia.
- `storage` e `channel()` são placeholders com a mesma API: upload devolve
  erro e o canal nunca dispara. As telas carregam, só não atualizam ao vivo
  (ficam para as Fases 3 e 4).
- `@supabase/ssr` e `@supabase/supabase-js` saíram do `package.json`, e
  entrou o `firebase-admin` 14.
- `npm run typecheck` e `npm run lint` passam sem erro. `npm test`:
  1012/1017; as 5 falhas (`currency.test.ts`, `date-utils.test.ts`) já
  existiam, vêm do fuso e do ICU do Node 26 local e não tocam código
  alterado.

**Itens puxados da Fase 2**, porque sem eles nenhuma tela carrega:

- Verificação do session cookie (`src/lib/auth/session.ts`): cookie
  `__session`, o único nome que o Firebase Hosting repassa ao Cloud Run.
  O UID é mapeado para o uuid de `auth.users` pela RPC
  `auth_user_by_firebase_uid` (`infra/db/migrations/043_auth_user_lookup.sql`,
  só `service_role` executa), com cache de 60s em memória.
- `middleware.ts` → `proxy.ts` (Next 16, roda em Node), validando o cookie
  com as mesmas regras de redirecionamento e convite.
- `GET /api/auth/session` (quem sou eu, para o `auth.getUser()` do browser)
  e `DELETE` (logout deste navegador). `signOut({ scope: 'global' })`
  responde 501 até a Fase 2 revogar os refresh tokens.
- Os usos de `access_token` em `whatsapp/config`, `broadcast` e
  `verify-registration` são o token da Meta, não da sessão. Não há nada de
  auth para revisar ali.

**Para fechar o critério de saída** (precisa de acesso ao projeto GCP):

1. `cd infra && npm run db:migrate` para aplicar a `043_auth_user_lookup.sql`.
2. Ativar o provedor Email/Senha no Firebase Auth.
3. `npm run auth:dev-user` (em `infra/`) cria o usuário à mão, a linha em
   `auth.users` (o trigger cria perfil e conta) e imprime um session cookie.
4. `.env.local` com `POSTGREST_URL`, `POSTGREST_JWT_SECRET`,
   `POSTGREST_ID_TOKEN_COMMAND` e `NEXT_PUBLIC_FIREBASE_PROJECT_ID`,
   `npm run dev`, gravar o cookie `__session` em `localhost` e abrir inbox,
   contatos e pipelines.

### Fase 2 — Autenticação (G)

- [x] Firebase Auth com provedor email/senha e templates de email em pt-BR.
- [x] Páginas `/login`, `/signup`, `/forgot-password` e reset: `signInWithPassword`,
      `signUp`, `resetPasswordForEmail` e `updateUser` passam a usar o SDK do
      Firebase.
- [x] `POST /api/auth/session`: recebe o ID token, cria o session cookie
      (`__session`, httpOnly, SameSite=Lax), faz upsert em `auth.users` e
      grava as custom claims `accountIds`. (`GET` e `DELETE` já existem desde
      a Fase 1.)
- [x] ~~Middleware~~ → `proxy.ts` validando o cookie (feito na Fase 1).
- [x] Shim `auth.getUser()` / `auth.getSession()` / `onAuthStateChange`
      (feito na Fase 1), agora com `SIGNED_IN` depois do login.
- [x] `signOut({ scope: 'global' })`: `revokeRefreshTokens` e checagem de
      revogação em cada request, para o logout valer em todos os dispositivos.
- [x] Convites: revisar `redeem_invitation` e `peek_invitation` e atualizar
      as custom claims ao entrar numa conta.

**Critério de saída:** cadastro → confirmação → login → convite → entrar na
conta → trocar senha → logout, tudo funcionando de ponta a ponta.

**Resultado (2026-09-28): aprovado.**

Roteiro feito no navegador contra o Cloud SQL e o Firebase Auth reais, com
dois usuários novos (A e B). Os links dos emails foram gerados pelo Admin API
(`accounts:sendOobCode` com `returnOobLink`) e abertos na página
`/auth/action`, o mesmo caminho do link que chega por email.

- Cadastro de A → tela "verifique seu e-mail". Login antes de confirmar:
  recusado ("Confirme seu e-mail antes de entrar") e um link novo é enviado.
- Confirmação → login → `/dashboard`. O trigger `on_auth_user_created` criou
  perfil e conta pessoal (owner), o nome veio do cadastro e a claim
  `accountIds` foi gravada com a conta de A.
- Convite de A (agente) → B se cadastra pelo link, confirma o email (o link
  volta para `/join/<token>`), entra e aceita. B aparece como agente na conta
  de A, e a claim de B passa a ter a conta de A.
- Trocar senha (B): a senha antiga passa a ser recusada, a nova é aceita e
  este navegador continua logado depois do TTL do cache.
- "Sair de todos os dispositivos" (B): o navegador vai para `/login`, e uma
  segunda sessão de B (aberta por curl) passa a receber 401 em `/api/rest` e
  `user: null` em `/api/auth/session`.
- Esqueci a senha (A) → `/auth/action` → nova senha → login. A senha antiga
  mostra "E-mail ou senha inválidos."
- Remover membro (A remove B): a claim de B vai para a nova conta pessoal dele.
- Trocar email (A): o link confirma a troca, o Firebase derruba a sessão, e o
  login com o email novo mantém o mesmo uuid e atualiza `auth.users.email` e
  `profiles.email`.
- `POST /api/auth/session` com `Origin` de outro site: 403.
- `npm run typecheck` e `npm run lint` sem erro. `npm test`: as mesmas 5
  falhas de fuso/ICU da Fase 1; os testes novos (`session.test.ts`,
  `api/auth/session/route.test.ts`) passam.

Como ficou:

- `src/lib/firebase/client.ts` inicializa o app e o Auth do Firebase no
  browser (`initializeAuth` sem resolver de popup: sem iframe nem gapi) e
  define `languageCode` a partir de `NEXT_PUBLIC_APP_LOCALE`, para os emails
  saírem no idioma da interface.
- `src/lib/firebase/auth-flows.ts` tem os fluxos. É carregado sob demanda pelo
  `auth` do cliente do browser (`src/lib/supabase/client.ts`), então as
  páginas continuam chamando `supabase.auth.*`. As regras do Supabase com
  confirmação ligada continuam valendo: email não confirmado não entra, e o
  cadastro só cria o usuário no Firebase. A linha em `auth.users` nasce no
  primeiro login. Se o email de verificação falhar, o usuário recém-criado é
  apagado, para um novo cadastro não esbarrar em "email já existe".
- `POST /api/auth/session` (`createSession` em `src/lib/auth/session.ts`)
  exige ID token válido e não revogado, `email_verified`, e login de até 5 min
  **ou** um cookie vivo do mesmo usuário (renovação). Depois chama a RPC
  `auth_sync_user` (`infra/db/migrations/044_auth_session.sql`, só
  `service_role`), sincroniza a claim `accountIds` e emite o cookie de 14
  dias. O browser renova o cookie quando faltam menos de 3 dias, usando o
  login que o SDK mantém. Recusa escrita cross-site e tem rate limit por IP.
- Revogação: o cookie é validado localmente e o registro do usuário no
  Firebase (`disabled`, `tokensValidAfterTime`) fica em cache por 60s
  (`src/lib/auth/firebase-admin.ts`). `/api/rest`, as rotas e os server
  components recusam na hora uma sessão revogada no mesmo processo. O
  `proxy.ts` roda em outro realm (a doc do Next pede para não depender de
  globais ali), então o redirecionamento dele pode atrasar até 60s. Nesse
  intervalo a tela abre, mas sem dados.
- Trocar senha: o Firebase revoga as outras sessões. Este navegador entra de
  novo com a senha nova e recebe um cookie novo.
- Trocar email: `verifyBeforeUpdateEmail`. O email só muda no clique e
  derruba as sessões. O primeiro login depois disso atualiza `auth.users` e
  `profiles.email`.
- Custom claims (`src/lib/auth/claims.ts`): `accountIds` é copiado de
  `profiles.account_id` no login, depois de `redeem_invitation` e depois de
  `remove_account_member`. O browser força a atualização do ID token quando o
  login avisa `claimsChanged`. Para quem foi removido por outra pessoa, a claim
  nova chega no próximo refresh do token (≤ 1h).
- Convites: `redeem_invitation` e `peek_invitation` trabalham só com o hash do
  token e com `auth.uid()`, sem cruzar email com `auth.users`. Não precisaram
  de mudança.
- `/auth/action` é a página dos links de email (`verifyEmail`,
  `resetPassword`, `verifyAndChangeEmail`, `recoverEmail`). Só segue
  `continueUrl` da mesma origem. O `/auth/callback?next=/reset-password` que o
  upstream usava nunca existiu no app.
- Erros de auth têm `code` e são traduzidos por `AuthErrors` em
  `messages/*.json` (en, pt, es, ko). `AuthActionPage` tem as telas novas.
- CSP: `connect-src` inclui `identitytoolkit.googleapis.com` e
  `securetoken.googleapis.com`.
- `infra/auth/configure.mjs` (`npm run auth:configure`) aplica a
  configuração do Auth: email/senha, locale padrão, URL de ação
  `<site>/auth/action` e domínio autorizado. Hoje só o locale `pt-BR` foi
  aplicado. Enquanto não houver URL pública, os emails usam o handler
  hospedado do Firebase, que também confirma e volta para o `continueUrl`.
- `infra/auth/dev-user.mjs` marca o email como verificado, porque o app agora
  recusa login não verificado.
- Localmente, o firebase-admin precisa de credencial Google para criar
  cookies, checar revogação e gravar claims:
  `FIREBASE_ADMIN_ACCESS_TOKEN_COMMAND=gcloud auth print-access-token` e
  `GOOGLE_CLOUD_QUOTA_PROJECT` (ver `.env.local.example`).

Ficam para a Fase 5: `roles/firebaseauth.admin` para a service account do
Cloud Run; `npm run auth:configure` com `SITE_URL` da URL pública (URL de
ação + domínio autorizado); `NEXT_PUBLIC_FIREBASE_API_KEY` e
`NEXT_PUBLIC_FIREBASE_APP_ID` como build args; e o domínio próprio no envio
de email (risco de spam, §6).

### Fase 3 — Storage (P)

- [x] Três prefixos no bucket padrão: `avatars/`, `flow-media/`, `chat-media/`.
- [x] `storage.rules`: leitura pública nos três (como hoje); escrita só em
      `{prefixo}/{accountId}/...` com `accountId` nas claims, respeitando os
      limites de tamanho e MIME que as migrations 008, 016 e 023 definem.
- [x] Adaptar `upload-media.ts` (upload, URL pública, remoção),
      `mirror-inbound-media.ts` (upload no servidor com Admin SDK) e
      `profile-form.tsx`.
- [x] CSP em `next.config.ts`: trocar `*.supabase.co` em `media-src` e
      `connect-src` pelos hosts do Firebase Storage e do Firestore.
- [x] Publicar as regras (`firebase deploy --only storage`), aplicar o CORS
      (`cd infra && npm run storage:cors`) e dar
      `roles/storage.objectAdmin` no bucket à service account `wacrm-web`.
- [x] Validar contra o bucket real: avatar e mídia de flow pela UI,
      regras com o ID token de um usuário real e o espelho de mídia
      recebida (código do servidor).

**Critério de saída:** uploads funcionando contra o bucket real, URLs que
abrem sem login, e um usuário de outra conta sem conseguir gravar nem apagar
na pasta da conta alheia.

**Resultado (2026-09-28): aprovado.**

Validação contra o projeto real (`npm run dev`, Cloud SQL, Firebase Auth e o
bucket `crm-zap-cbd5d.firebasestorage.app`), com um usuário novo criado já
verificado pela Admin API e login pela tela `/login`:

- O ruleset publicado é idêntico ao `storage.rules` do repositório. O CORS
  e o `roles/storage.objectAdmin` da `wacrm-web` estão no bucket.
- Login: a claim do usuário passou a ter `accountIds` (a conta pessoal) e
  `userId` (o uuid de `auth.users`).
- Avatar (`profile-form.tsx`, sem mudança): um PNG foi gravado em
  `avatars/<uuid>/avatar-<epoch>.png` e o perfil salvo com a URL, que
  renderiza na tela. Anônimo: `GET` 200 (`image/png`,
  `public, max-age=3600`). Listar `avatars/` dá 403.
- Mídia de flow (`uploadAccountMedia`, sem mudança): no editor, nó
  "Enviar mídia" → "Arquivo enviado.", objeto em
  `flow-media/account-<uuid>/<epoch>-Banner_Fase_3.png`. O `fetch` da URL
  pelo navegador (o caminho do download na inbox) responde 200, então o
  CORS está certo. Nenhuma violação de CSP no console.
- Regras no bucket real, com o ID token do usuário (REST do Firebase
  Storage): gravar na própria conta em `chat-media` e `flow-media` 200;
  em outra conta 403; `text/html` 403; 16 MB + 1 byte 403; anônimo 403;
  avatar de outro usuário 403; fora dos três prefixos 403; `GET` anônimo
  200; apagar o próprio 204 e o `GET` seguinte 404.
- Espelho de mídia recebida (`mirrorInboundMedia` + `adminStorage`, com
  só o download da Meta simulado): grava
  `chat-media/account-<uuid>/inbound/<media id>-audio-<ts>.ogg` (o
  `audio/ogg; codecs=opus` foi normalizado), a URL abre sem login, a
  reentrega regrava o mesmo objeto, um `.exe` é recusado e o webhook fica
  com a URL do proxy. `upsert: false` num objeto existente dá "The
  resource already exists", e `remove` apaga (o `GET` seguinte dá 404).

Não passaram pela UI: anexo e áudio no composer, mídia de template e a
remoção de um anexo cancelado. Todos precisam de uma conversa ou de um
número de WhatsApp conectado, e usam o mesmo `uploadAccountMedia` /
`deleteAccountMedia` validado acima. Entram no roteiro da Fase 6
("responder com áudio").

Ficaram no projeto: o usuário de teste `p3-a-…@example.com`, um fluxo
rascunho "Teste Fase 3 storage", o avatar dele e o PNG em `flow-media`.

Como ficou:

- Bucket: o padrão do projeto, `crm-zap-cbd5d.firebasestorage.app`, que já
  existia em **US-EAST1** (a região de um bucket não muda depois de criado).
  Cada antigo bucket do Supabase virou um prefixo:
  `avatars/<uuid do usuário>/…`, `flow-media/account-<uuid>/…` e
  `chat-media/account-<uuid>/…`, os mesmos caminhos que o app já montava.
  Ter a mídia fora de São Paulo tem pouco custo: quem mais lê é a Meta, e
  US-EAST1 entra na cota gratuita do Storage.
- `src/lib/storage/buckets.ts` é a fonte única dos limites (2 MB para
  avatares, 16 MB para as mídias; listas de MIME das migrations 008, 016,
  023 e 039) e monta a URL pública
  (`firebasestorage.googleapis.com/v0/b/<bucket>/o/<objeto>?alt=media`,
  sem token: as regras liberam `get` para todos, como os buckets públicos
  do Supabase). `buckets.test.ts` falha se o `storage.rules` divergir.
- `storage.rules`: `get` público nos três prefixos, sem `list` (o Supabase
  permitia listar, e nada no app usa isso). Para gravar em
  `flow-media`/`chat-media`, a pasta precisa ser `account-<uuid>` de uma
  conta presente na claim `accountIds`. Em `avatars`, a pasta precisa ser o
  uuid da claim **`userId`**, que é nova. O UID do Firebase não é o uuid de
  `auth.users`, e a migration 008 põe o avatar em `<auth.uid()>/`.
  `src/lib/auth/claims.ts` grava `userId` junto com `accountIds`, e o
  primeiro login depois do deploy completa a claim de quem já existe. O
  resto do bucket fica fechado. O caminho legado de `flow-media` por
  `auth.uid()` (migration 020) ficou de fora, porque não há arquivos
  antigos.
- Browser (`src/lib/firebase/storage.ts`, carregado sob demanda pelo
  `storage` do cliente em `src/lib/supabase/client.ts`): o upload vai
  direto ao Storage pelo SDK, autorizado pelo ID token. Antes, confere
  tamanho e MIME para dar a mesma mensagem do Supabase em vez de um
  "unauthorized" seco. Se as regras recusarem, força a renovação do token
  (claim recém-mudada) e tenta uma vez mais. `upsert: false` não é
  garantido; os caminhos que o usam têm timestamp.
- Servidor (`src/lib/storage/admin-storage.ts`, o `storage` do
  `supabaseAdmin()`): API JSON do Cloud Storage com a credencial do
  firebase-admin (`googleAccessToken()` em
  `src/lib/auth/firebase-admin.ts`). O wrapper de Storage do firebase-admin
  não aceita o token do gcloud usado em dev. As regras não valem para ele,
  então os limites do bucket são checados no código, como o Supabase fazia
  com o service role. `upsert: false` vira `ifGenerationMatch=0`.
- `upload-media.ts`, `mirror-inbound-media.ts` e `profile-form.tsx` **não
  mudaram**: continuam chamando `supabase.storage.from(bucket)`, e o shim
  mantém a API (`upload`, `getPublicUrl`, `remove`). Isso é menos diff
  contra o upstream.
- `basenameFromUrl` (`src/lib/media/filename.ts`) lê o nome do arquivo de
  dentro do objeto codificado (`chat-media%2F…%2F<epoch>-nota.pdf`). Sem
  isso, o download sairia com o prefixo de timestamp no nome.
- CSP: `media-src` e `connect-src` trocam `*.supabase.co` por
  `firebasestorage.googleapis.com`, e `connect-src` ganha
  `firestore.googleapis.com` para a Fase 4. `wss://*.supabase.co` saiu.
- CORS do bucket (`infra/storage/cors.json`): `GET`/`HEAD` de qualquer
  origem. O download no inbox (`src/lib/media/blob-cache.ts`) busca a
  mídia com `fetch`, e o conteúdo já é público.
- `NEXT_PUBLIC_FIREBASE_STORAGE_BUCKET` é obrigatória (o `storageBucket`
  da config web do Firebase). Não é deduzida do projeto porque projetos
  antigos usam `<projeto>.appspot.com`.
- Testes: `infra/storage/rules.test.mjs` roda as regras no emulador do
  Storage (`cd infra && npm run storage:test-rules`, precisa de Java):
  **18/18**. Cobre escrita, leitura e remoção por membro, bloqueio de outra
  conta, de um colega da mesma conta no avatar alheio, de sem claim e de
  anônimo, pasta fora do formato, limites de tamanho e MIME, `list`
  negado e o resto do bucket fechado. No app, `npm run typecheck` passa,
  o lint não dá erro e `npm test` tem 1058/1063: as mesmas 5 falhas de
  fuso/ICU das fases anteriores. Os testes novos são `buckets.test.ts`,
  `admin-storage.test.ts`, o caso da claim `userId` em `session.test.ts`
  e o da URL do Firebase em `filename.test.ts`.

### Fase 4 — Realtime (G)

- [x] Migration nova `infra/db/migrations/045_realtime_notify.sql`: log
      `app_realtime.changes`, trigger nas 5 tabelas, `pg_notify`, papel
      `realtime_relay` e a RPC `realtime_changes_since` do polling.
- [x] Serviço `infra/relay-realtime/` (Node, Cloud Run, 1 instância):
      `LISTEN`, reconexão com backoff e escrita dos sinais no Firestore.
- [x] `firestore.rules`: leitura de `signals/{accountId}/changes/*` por
      membros, escrita bloqueada para clientes.
- [x] Wrapper `channel()`. `use-realtime.ts`, `use-total-unread.ts`,
      `use-unread-notifications.ts`, `use-browser-notifications.ts`,
      `use-presence.ts`, `components/inbox/message-thread.tsx` e
      `notifications/page.tsx` não precisaram de mudança.
- [x] Fallback: se o sinal ficar 60s parado, fazer polling. Vale também
      para aba oculta, onde as notificações do navegador são disparadas.

**Critério de saída:** mensagem enviada pelo webhook aparece na inbox aberta em
menos de 2s, e a presença de outro membro atualiza.

**Resultado (2026-09-28): aprovado.**

Aplicado no projeto: secret `pg-relay-password`, migration 045 (com a senha
do `realtime_relay`), `firestore.rules`, service account `relay-realtime`
(`cloudsql.client`, `datastore.user`, acesso ao secret), TTL de `expireAt`
e o Cloud Run `relay-realtime`. O deploy pelo código criou o repositório
`cloud-run-source-deploy` no Artifact Registry.

A `046_realtime_notification_read_at.sql`, que veio da revisão do PR, também
foi aplicada. Conferido com duas notificações de B, uma lida e outra não:
apagar o contato leva as duas embora em cascata, e os sinais de DELETE
trazem `read_at` com a data e com `null`. O mesmo teste mostra a conversa
apagada virando um único sinal, sem um por mensagem.

Roteiro com `npm run dev` contra o Cloud SQL, o Firebase e o relay no Cloud
Run, com dois usuários novos (A e B) verificados pela Admin API. A entrou
pela tela `/login` em `a.localhost:3000` (subdomínio de `localhost`: outra
origem, cookies próprios, e o dev server do Next aceita sem
`allowedDevOrigins`). B entrou por script e aceitou um convite de A como
agente.

- Na aba de A, o hub abre o `Listen` do Firestore e não cai no polling: as
  regras aceitaram a claim `accountIds`.
- Presença: B manda `touch_presence('online')`. Na tela de membros de A,
  "0 online" vira "1 online" em **0,41 s**, sem recarregar, pela busca
  `member_presence?user_id=in.(…)` do hub.
- Webhook: uma mensagem de cliente assinada com o `META_APP_SECRET`, num
  `whatsapp_config` de teste (token falso), aparece na inbox aberta de A em
  **1,41 s** após o envio (0,67 s após o ack), já contando a criação do
  contato e da conversa.
- Relay parado (`DB_NAME` inexistente numa revisão nova): ele registra o
  erro e tenta reconectar com backoff. Com a aba oculta, uma mensagem nova
  chega pelo polling em 48 s, quando o Firestore completa 60 s calado.
  Esse teste mostrou que o watchdog não podia depender da aba visível.
- Relay de volta: ele publica o que ficou pendente, e a mensagem seguinte
  aparece em **0,67 s**. As 4 mensagens aparecem uma vez cada no histórico.
- Sem erro no console nem no servidor.

Ficaram no projeto: os usuários `p4-a-…@example.com` e `p4-b-…@example.com`
(B como agente na conta de A), o `whatsapp_config` de teste
(`phone_number_id` 990004000400040) e a conversa "Cliente Fase 4" com as
4 mensagens.

Como ficou:

- `src/lib/supabase/app-client.ts`: o `RealtimeChannel` recebe um
  transporte (`RealtimeTransport`). Só o cliente do browser tem um
  (`src/lib/supabase/client.ts`), que carrega `src/lib/firebase/realtime.ts`
  no primeiro `subscribe`. No servidor, o canal continua sem disparar.
- `src/lib/realtime/hub.ts`: um hub por aba, compartilhado por todos os
  canais. Ele junta as duas fontes (Firestore e polling), descarta
  mudanças repetidas pelo id, busca as linhas por tabela em lote
  (`?id=in.(…)`, 100 por vez) e entrega na ordem das mudanças. Uma linha
  que a RLS não devolve é descartada, como acontecia no Supabase com
  notificações de outro membro. Se a busca falha, o sinal volta para a
  fila (1s, 2s, 4s); esgotadas as tentativas, o id fica livre para o
  polling do log e os canais recebem `CHANNEL_ERROR` → `SUBSCRIBED`. O hub
  para 10s depois que o último canal sai.
- Status igual ao supabase-js: `SUBSCRIBED` quando há uma fonte ativa e
  `CHANNEL_ERROR` quando não há. Uma busca de linha que falha gera
  `CHANNEL_ERROR` → `SUBSCRIBED`, a transição que faz a inbox recarregar.
- `src/lib/realtime/changes.ts`: filtros `eq`, `neq` e `in` (o app só usa
  `eq`). Filtro em coluna-chave (`conversation_id`, `account_id`) é
  decidido antes da busca, então reações de outra conversa nem são
  buscadas. `DELETE` traz só as chaves em `old`, como a replica identity
  padrão do Supabase. Para notificações, as chaves do `DELETE` incluem
  `read_at` (`046_realtime_notification_read_at.sql`), que o
  `useUnreadNotifications` usa para decidir se o contador cai.
- O relay publica as mudanças e marca as linhas na mesma transação. Se cair
  entre as duas coisas, repete a escrita (mesmo id de documento), mas não
  pula nenhuma. Linhas com mais de 10 min quando o relay volta são marcadas
  sem sinal (as abas já as leram pelo polling), e as publicadas somem do
  log depois de 1h.
- Testes: `changes.test.ts` e `hub.test.ts` (26), `coalesce.test.mjs`
  (`cd infra && npm run relay:test`, 10) e `infra/firestore/rules.test.mjs`
  no emulador (`npm run firestore:test-rules`, 6/6). As regras de Storage
  continuam 18/18 com o `firebase.json` novo. No app, `npm run typecheck`
  passa, o lint não dá erro e `npm test` tem 1082/1087: as mesmas 5 falhas
  de fuso/ICU.

### Fase 5 — Deploy (M)

**Mudança de rota (2026-09-29): enquanto o projeto está em testes, o
deploy vai para a VPS da Oracle, e não para o Cloud Run.** O plano original
(Next no Cloud Run atrás do Firebase Hosting, Cloud Build, Cloud Scheduler)
custaria ~US$ 62/mês só com o `wacrm-web`: o webhook e o broadcast rodam em
`after()`, o que obriga a CPU sempre alocada, e o cron de automações a cada
minuto não deixa a instância desligar. Somando o relay (~US$ 59/mês com
1 vCPU sempre ligada) e o Cloud SQL (~US$ 15/mês), seriam mais de US$ 130 por
mês para um ambiente de testes. A VPS (`VM.Standard.A1.Flex`, 4 OCPU ARM,
24 GB, `sa-saopaulo-1`) já está paga.

Fica no Google o que é gratuito no volume de testes: Firebase Auth,
Storage e Firestore (sinais). Postgres, PostgREST, relay, Next e os crons
rodam na VPS. Quando o projeto sair dos testes, o banco vai para um
Postgres gerenciado com `pg_dump`/`pg_restore` e troca de variáveis: é
Postgres padrão com a camada de compat, e o app não muda.

- [x] `Dockerfile` em Node 22, com os `NEXT_PUBLIC_FIREBASE_*` como build
      args. Os `NEXT_PUBLIC_SUPABASE_*` saíram do `Dockerfile`, do
      `docker-compose.yml` e da CI.
- [x] `engines.node` = `22.x`.
- [x] `.github/workflows/migrations.yml` reaplica compat + migrations num
      Postgres 17 + pgvector limpo, com o mesmo `migrate.mjs` do deploy.
- [x] `infra/vps/compose.yml` e `infra/vps/deploy.sh`.
- [x] Relay do Cloud Run com `min-instances=0` (o realtime da UI publicada
      no Cloud Run, se houver, cai no polling).
- [x] Service account `wacrm-vps` e a chave dela na VPS (passo manual,
      abaixo).
- [x] Primeiro deploy: os 5 serviços no ar (~190 MB de RAM no total), 47
      migrations aplicadas, `verify-schema.sql` passando, relay em `LISTEN`.
- [x] `crm.dhscode.com.br` no túnel Cloudflare `meu-servidor` (regra antes
      do catch-all, CNAME criado pelo `cloudflared tunnel route dns`; backup
      do `config.yml` ao lado dele). `/login` responde 200 pelo domínio,
      o Cloudflare não guarda HTML (`cf-cache-status: DYNAMIC`) e os outros
      subdomínios do túnel continuam no ar.
- [ ] Domínio `crm.dhscode.com.br` nos domínios autorizados do Firebase
      Auth: `cd infra && SITE_URL=https://crm.dhscode.com.br npm run auth:configure`.
      Sem isso, o email de verificação do cadastro falha (continue URL não
      autorizada).
- [ ] URL de ação dos emails → `https://crm.dhscode.com.br/auth/action`,
      pelo console (Authentication → Templates → editar → "Personalizar URL
      de ação"). A API recusa essa mudança (`EMAIL_TEMPLATE_UPDATE_NOT_ALLOWED`)
      enquanto o projeto envia pelo domínio padrão do Firebase. Até lá, os
      links abrem o handler hospedado do Firebase, que também confirma e volta
      para o `continueUrl`.
- [ ] App Secret real no `META_APP_SECRET` e webhook do Meta →
      `https://crm.dhscode.com.br/api/whatsapp/webhook`.
- [x] Cadastro → confirmação por email → login em `crm.dhscode.com.br`:
      `auth.users`, perfil e conta criados, sem erro no app.
- [x] Dev local sem instalar nada: `infra/vps/dev.sh` (abaixo).
- [ ] Apagar o Cloud SQL `wacrm-pg`, os Cloud Run `postgrest` e
      `relay-realtime`, os secrets `pg-*`/`pgrst-*`, as service accounts
      `postgrest`, `relay-realtime` e `wacrm-web` e o repositório
      `cloud-run-source-deploy` (aprovado, sem backup; comandos abaixo).

Como ficou:

- `infra/vps/compose.yml`: `db` (pgvector/pgvector:pg17, sem porta
  publicada), `migrate` (perfil à parte, roda o `migrate.mjs` com
  `DATABASE_URL`), `postgrest` (v16.3, as mesmas variáveis do Cloud Run),
  `relay` (o mesmo `relay.mjs`, que ganhou `DB_HOST` para falar direto com
  o Postgres), `app` (o `Dockerfile` da raiz, em `127.0.0.1:3100`) e `cron`
  (um loop de `curl`: `/api/automations/cron` a cada minuto e
  `/api/flows/cron` a cada 5). Todas as imagens têm build ARM64.
- Sem IAM na frente do PostgREST: só a rede do compose chega nele. O
  `postgrest.ts` já tratava esse caso (sem `K_SERVICE` e sem
  `POSTGREST_ID_TOKEN_COMMAND`, não manda token do Google). O JWT de 60s e
  a RLS continuam iguais.
- `infra/vps/deploy.sh` roda da estação de trabalho: clona ou atualiza o
  repositório em `~/wacrm` no branch já publicado, cria
  `infra/vps/.env` (chmod 600) na primeira vez, com os secrets **gerados na
  própria VPS**, faz o build, aplica as migrations e sobe os serviços. O
  `META_APP_SECRET` nasce como placeholder, e todo webhook é recusado até
  entrar o App Secret real.
- `.dockerignore` passou a excluir `**/.env*` e `infra/`: o `.env` da VPS
  não entra no contexto de build do app.
- HTTPS: o túnel Cloudflare que a VPS já usa para os outros subdomínios
  (`meu-servidor`). Ele cria o DNS e termina o TLS, sem porta nova aberta.
- Os arquivos do caminho Cloud Run (Cloud Build, Hosting, deploy por
  GitHub Actions com Workload Identity) foram escritos e depois removidos
  neste mesmo branch. O que se aprendeu com eles está acima: `after()`
  exige CPU sempre alocada, e o CDN do Hosting põe o `__session` na chave
  do cache, então o `s-maxage=300` do `next.config.ts` não vazaria HTML
  entre usuários.

**Dev local.** Não há Docker nem Postgres na estação de trabalho, então o
`npm run dev` usa uma segunda pilha na VPS (`infra/vps/compose.dev.yml`,
projeto `wacrm-dev`): Postgres, PostgREST e relay próprios, com um banco
separado do de testes, publicados só no loopback da VPS (3201 e 3202).

1. `bash infra/vps/dev.sh up`: sobe a pilha, gera `infra/vps/.env.dev` na
   VPS na primeira vez, aplica as migrations **desta cópia local** por um
   túnel e grava `POSTGREST_URL`/`POSTGREST_JWT_SECRET` no `.env.local`.
2. `bash infra/vps/dev.sh tunnel`, aberto enquanto o `npm run dev` roda.

O `auth:dev-user` aceita `DATABASE_URL`
(`postgres://postgres:…@localhost:3202/wacrm`) para criar um usuário
verificado no banco de dev. O projeto Firebase é o mesmo nos dois
ambientes, e as custom claims seguem o banco do último login. Use usuários
diferentes para dev e para `crm.dhscode.com.br`.

Validado: login pela tela em `localhost:3000` com um usuário criado assim,
`/api/auth/session` com o uuid do banco de dev e `/api/rest/accounts` só
com a conta dele, sem erro no console nem no servidor.

**Passo manual: service account da VPS.** A criação de service account,
de papéis IAM e de chave precisa ser feita por você (PowerShell):

```powershell
$P="crm-zap-cbd5d"; $SA="wacrm-vps@$P.iam.gserviceaccount.com"
gcloud iam service-accounts create wacrm-vps --project $P --display-name "WACRM on the Oracle VPS"
gcloud projects add-iam-policy-binding $P --member "serviceAccount:$SA" --role roles/firebaseauth.admin --condition None
gcloud projects add-iam-policy-binding $P --member "serviceAccount:$SA" --role roles/datastore.user --condition None
gcloud storage buckets add-iam-policy-binding gs://crm-zap-cbd5d.firebasestorage.app --member "serviceAccount:$SA" --role roles/storage.objectAdmin
gcloud iam service-accounts keys create "$env:TEMP\gcp-key.json" --iam-account $SA
ssh servidor "mkdir -p -m 700 ~/.wacrm-secrets"
scp "$env:TEMP\gcp-key.json" servidor:.wacrm-secrets/gcp-key.json
ssh servidor "chmod 644 ~/.wacrm-secrets/gcp-key.json"
Remove-Item "$env:TEMP\gcp-key.json"
```

`firebaseauth.admin` cria session cookies, checa revogação e grava custom
claims; `datastore.user` é para o relay gravar os sinais; `objectAdmin`
no bucket é para o espelho de mídia recebida. A pasta `0700` impede outros
usuários do host de ler a chave. O arquivo fica `0644` porque os
containers rodam com usuários próprios (`nextjs`, `node`).

### Fase 6 — Validação (M)

- [x] Teste de isolamento: dois usuários em contas diferentes tentam ler e
      escrever dados um do outro por `/api/rest`, `/api/*`, Storage e
      Firestore. Tudo deve falhar. **328/328 no banco de dev**, depois da
      migration 047 (abaixo). Ficaram 9 avisos, todos de código do upstream.
- [ ] Migration 047 aplicada em `crm.dhscode.com.br` (vai no próximo
      `infra/vps/deploy.sh`).
- [ ] Roteiro manual: conectar WhatsApp → receber mensagem → responder com
      áudio → criar contato → mover no pipeline → broadcast → automação com
      Wait → flow → resposta de IA com base de conhecimento → API pública com
      API key → MCP server. Depende do App Secret real e do webhook do Meta
      (pendências da Fase 5).
- [x] Rodar `npm test`, `npm run typecheck` e `npm run build`. `typecheck` e
      `build` passam. `npm test`: 1084/1089 nesta estação e verde no CI. As 5
      falhas são de ambiente, em arquivos do upstream que a migração não
      tocou: `date-utils.test.ts` assume fuso UTC (passa com `TZ=UTC`) e
      `currency.test.ts` assume o locale `en-US` (o Node no Windows usa o
      pt-BR do sistema e ignora `LANG`).
- [ ] Revisar os custos no Billing depois de 48h de uso.

**Teste de isolamento** (`cd infra && npm run isolation:test`, com o
`npm run dev` no ar sobre a pilha de dev):

- Três usuários fixos, `isolation-{a,b,c}@example.com`, criados na primeira
  execução pela Identity Toolkit e pelo `/api/auth/session` do próprio app
  (que cria `auth.users`, perfil e conta). A senha é trocada a cada rodada,
  então nada secreto fica guardado. Use só contra o banco de dev.
- A semeia a conta dele como o app faz: `/api/rest` para contato, tag,
  pipeline, etapa, deal, conversa, mensagem, reação, nota, campo
  customizado, template e broadcast; as rotas do servidor para quick reply,
  automação, flow, documento de conhecimento, API key, convite e webhook
  (`/api/v1`).
- B ataca por todas as portas: `GET`/`PATCH`/`DELETE` por id e `INSERT` com
  o `account_id` de A em cada tabela; varredura de todas as 36 tabelas como
  B e como anônimo; o proxy (header `Authorization` forjado com
  `service_role`, cookie inválido, path traversal, escrita cross-origin); 28
  chamadas a rotas `/api/*` com ids de A; a API pública com a API key de B;
  as RPCs `SECURITY DEFINER`; Storage (gravar, sobrescrever, apagar e listar
  a pasta de A nos três prefixos); Firestore (ler os sinais de A, gravar
  sinais).
- Cada "B não vê nada" tem um controle: a mesma consulta feita por A
  encontra a linha. No fim, as linhas de A são comparadas com um snapshot
  tirado antes dos ataques. Esse é o veredito para as rotas que respondem
  200 a um id alheio sem fazer nada (knowledge `DELETE`, quick replies,
  automações `DELETE`, engine).
- Por último, B sai de todas as sessões (`?scope=global`), e o cookie
  antigo passa a dar 401 em `/api/rest` e nas rotas.

**Achado corrigido: RPCs sem checagem de quem chama.** Seis funções
`SECURITY DEFINER` do upstream não verificam o chamador e estavam abertas
em `/api/rest/rpc/*` até para anônimo, porque o compat reproduz o grant
padrão do Supabase (`EXECUTE` para `anon` e `authenticated`) e as
migrations do upstream só revogam de `PUBLIC`. O teste mostrou, sem
sessão, que dava para desativar o webhook de outra conta
(`record_webhook_failure`), consumir a cota de respostas de IA de uma
conversa alheia (`claim_ai_reply_slot`) e alterar os contadores de um
broadcast alheio (`_bcast_bump`, `recompute_broadcast_counts`), além de
rodar as deduplicações de todas as contas. O mesmo buraco existe no
upstream sobre o Supabase.

- `infra/db/migrations/047_revoke_service_only_rpcs.sql` revoga `EXECUTE`
  de `PUBLIC`, `anon` e `authenticated` nessas funções (e em
  `_bcast_cols_for_status`). Quem as chama de verdade é código com service
  role (`deliver.ts`, `auto-reply.ts`) ou um trigger `SECURITY DEFINER`,
  então nada no app muda.
- `infra/db/verify-rpc-grants.sql` roda no fim do `migrate.mjs` (local, CI
  e VPS). Ele falha se alguma função `SECURITY DEFINER` de `public`, fora
  de uma lista revisada (as que checam `auth.uid()` ou um token), ficar
  chamável por `anon` ou `authenticated`. Um merge do upstream não abre
  outra em silêncio. Antes da 047, ela acusou exatamente as seis.

**Avisos: bugs do upstream, não corrigidos.** Não são regressão da
migração (a RLS e as rotas são as mesmas do Supabase). Corrigir exige
mexer em arquivos do upstream, o que fica para decidir:

1. **Ex-membro mantém acesso às automações que criou.** As rotas
   `/api/automations/[id]` (e `/duplicate`) filtram por `user_id`, não por
   `account_id`. C entrou na conta de A, criou uma automação, foi removido
   e continuou lendo (com a configuração dos passos), editando, duplicando
   para dentro da conta de A e **apagando** a automação.
2. **Motor de automações confia em `context.conversation_id`**
   (`engine.ts`, `resolveConversationId`). Com um WhatsApp conectado, B
   grava a mensagem enviada e atualiza `last_message_*` numa conversa de A.
   O teste só confirma que nada chega enquanto B não tem número.
3. **Atribuir uma conversa a um usuário de outra conta.** A RLS de
   `conversations` não confere o `assigned_agent_id`, e o trigger
   `notify_conversation_assigned` cria uma notificação para o usuário de
   A, que ele enxerga.
4. **Referências a linhas de outra conta.** As políticas só checam o
   `account_id` da linha nova, então B cria na própria conta um deal com o
   contato e a etapa de A, uma conversa com o contato de A ou marca um
   contato seu com a tag de A. Não vaza leitura (o embed volta vazio), mas
   o código com service role que seguir essas FKs pode.

Os casos 2 a 4 exigem conhecer o uuid do registro de A, que não aparece
para B em lugar nenhum. O caso 1 não: o ex-membro já tinha os ids.

## 5. Decisões para aprovar

São decisões difíceis de reverter depois que a Fase 1 começar.

1. **Cloud SQL + PostgREST** em vez de Data Connect ou reescrita das queries.
2. **Tabela `auth.users` com uuid própria**, com o UID do Firebase numa coluna
   à parte.
3. **Realtime por sinais no Firestore** (só IDs, sem conteúdo) alimentados por
   um log no Postgres + `pg_notify`.
4. **Tudo em `southamerica-east1`**: Cloud SQL, PostgREST, relay e o Next no
   Cloud Run. O App Hosting ficou de fora porque não existe nessa região
   (decidido em 2026-09-28).
   **Revisto em 2026-09-29:** durante os testes, Postgres, PostgREST, relay
   e Next rodam na VPS da Oracle em São Paulo (Fase 5). O Cloud Run volta a
   ser opção quando houver volume que justifique o custo fixo.
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
