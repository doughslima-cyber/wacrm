-- Realtime without Supabase Realtime (docs/firebase-migration.md,
-- phase 4).
--
-- Supabase streamed `postgres_changes` off the WAL. Here a trigger on
-- each table the UI listens to appends a small row to
-- app_realtime.changes (which row, which op, which account — never
-- the row's content) and wakes the relay with pg_notify. The relay
-- (infra/relay-realtime) copies each change to Firestore at
-- signals/{account_id}/changes/{id}; the browser listens there and
-- fetches the row itself through /api/rest, so RLS still decides who
-- sees what.
--
-- The log, not the NOTIFY, is the source of truth: a NOTIFY sent
-- while the relay is disconnected is lost, a log row is not. The relay
-- publishes whatever is unpublished when it reconnects, and the
-- browser falls back to polling the log (realtime_changes_since) when
-- Firestore goes quiet.
--
-- Tables: the six the upstream added to the supabase_realtime
-- publication, minus flow_runs, which nothing in the app subscribes
-- to. Adding it back is one CREATE TRIGGER plus a CASE branch.

CREATE SCHEMA IF NOT EXISTS app_realtime;
REVOKE ALL ON SCHEMA app_realtime FROM PUBLIC;

CREATE TABLE IF NOT EXISTS app_realtime.changes (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  account_id   uuid        NOT NULL,
  table_name   text        NOT NULL,
  op           text        NOT NULL CHECK (op IN ('INSERT', 'UPDATE', 'DELETE')),
  -- Primary key of the changed row, as text (member_presence is keyed
  -- by user_id, the rest by id).
  row_id       text        NOT NULL,
  -- The primary key plus the columns listeners filter on
  -- (conversation_id, user_id, …). This is what a DELETE event
  -- carries as `old`, like Supabase's default replica identity.
  keys         jsonb       NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT clock_timestamp(),
  published_at timestamptz
);

-- The relay's queue: unpublished rows in order.
CREATE INDEX IF NOT EXISTS changes_unpublished_idx
  ON app_realtime.changes (id) WHERE published_at IS NULL;
-- The browser's polling fallback, per account.
CREATE INDEX IF NOT EXISTS changes_account_created_idx
  ON app_realtime.changes (account_id, created_at);
-- The relay's cleanup of published rows.
CREATE INDEX IF NOT EXISTS changes_created_idx
  ON app_realtime.changes (created_at);

-- ------------------------------------------------------------------
-- Capture trigger
-- ------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app_realtime.capture()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  r         record;
  v_account uuid;
  v_row_id  text;
  v_keys    jsonb;
BEGIN
  -- No-op UPDATE: nothing for a listener to see. `*=` compares the
  -- stored bytes, so it works for column types without an equality
  -- operator (json), where IS NOT DISTINCT FROM would raise.
  IF TG_OP = 'UPDATE' AND NEW *= OLD THEN
    RETURN NULL;
  END IF;

  IF TG_OP = 'DELETE' THEN
    r := OLD;
  ELSE
    r := NEW;
  END IF;

  CASE TG_TABLE_NAME
    WHEN 'conversations' THEN
      v_account := r.account_id;
      v_row_id  := r.id::text;
      v_keys    := jsonb_build_object('id', r.id);
    WHEN 'messages' THEN
      -- A message cascading out with its conversation finds no parent
      -- here and is skipped: the conversation's own DELETE covers it,
      -- instead of one signal per message.
      SELECT c.account_id INTO v_account
      FROM public.conversations c WHERE c.id = r.conversation_id;
      v_row_id := r.id::text;
      v_keys   := jsonb_build_object('id', r.id, 'conversation_id', r.conversation_id);
    WHEN 'message_reactions' THEN
      SELECT c.account_id INTO v_account
      FROM public.conversations c WHERE c.id = r.conversation_id;
      v_row_id := r.id::text;
      v_keys   := jsonb_build_object('id', r.id, 'conversation_id', r.conversation_id,
                                     'message_id', r.message_id);
    WHEN 'member_presence' THEN
      v_account := r.account_id;
      v_row_id  := r.user_id::text;
      v_keys    := jsonb_build_object('user_id', r.user_id, 'account_id', r.account_id);
    WHEN 'notifications' THEN
      v_account := r.account_id;
      v_row_id  := r.id::text;
      v_keys    := jsonb_build_object('id', r.id, 'user_id', r.user_id);
    ELSE
      RAISE EXCEPTION 'app_realtime.capture() is not set up for table %', TG_TABLE_NAME;
  END CASE;

  IF v_account IS NULL THEN
    RETURN NULL;
  END IF;

  INSERT INTO app_realtime.changes (account_id, table_name, op, row_id, keys)
  VALUES (v_account, TG_TABLE_NAME, TG_OP, v_row_id, v_keys);

  -- Same channel and payload for every row: Postgres folds identical
  -- notifications within a transaction, so a bulk write wakes the
  -- relay once, at commit.
  PERFORM pg_notify('app_realtime', '');
  RETURN NULL;
END
$$;

REVOKE ALL ON FUNCTION app_realtime.capture() FROM PUBLIC;

DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['conversations', 'messages', 'message_reactions',
                           'member_presence', 'notifications']
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS app_realtime_capture ON public.%I', t);
    EXECUTE format(
      'CREATE TRIGGER app_realtime_capture
         AFTER INSERT OR UPDATE OR DELETE ON public.%I
         FOR EACH ROW EXECUTE FUNCTION app_realtime.capture()', t);
  END LOOP;
END
$$;

-- ------------------------------------------------------------------
-- The relay's database role: reads the queue, marks rows published,
-- deletes old ones. LISTEN needs no grant. Its password is set out of
-- band (migrate.mjs, RELAY_PASSWORD), like authenticator's.
-- ------------------------------------------------------------------

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'realtime_relay') THEN
    CREATE ROLE realtime_relay LOGIN NOINHERIT;
  END IF;
END
$$;

GRANT USAGE ON SCHEMA app_realtime TO realtime_relay;
GRANT SELECT, UPDATE, DELETE ON app_realtime.changes TO realtime_relay;
ALTER ROLE realtime_relay SET statement_timeout = '30s';

-- ------------------------------------------------------------------
-- Polling fallback for the browser
-- ------------------------------------------------------------------

-- Changes on the caller's accounts after p_after (at most the last
-- 10 minutes, 500 rows), plus the server clock the browser uses as
-- its starting point. p_after NULL returns only the clock.
CREATE OR REPLACE FUNCTION public.realtime_changes_since(p_after timestamptz DEFAULT NULL)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $$
  SELECT jsonb_build_object(
    'now', now(),
    'changes', CASE WHEN p_after IS NULL THEN '[]'::jsonb ELSE coalesce((
      SELECT jsonb_agg(jsonb_build_object(
               'id', c.id, 'table', c.table_name, 'op', c.op,
               'row_id', c.row_id, 'keys', c.keys, 'at', c.created_at)
             ORDER BY c.created_at, c.id)
      FROM (
        SELECT *
        FROM app_realtime.changes c
        WHERE c.account_id IN (
                SELECT p.account_id FROM public.profiles p
                WHERE p.user_id = auth.uid() AND p.account_id IS NOT NULL)
          AND c.created_at > greatest(p_after, now() - interval '10 minutes')
        ORDER BY c.created_at, c.id
        LIMIT 500
      ) c
    ), '[]'::jsonb) END
  )
$$;

-- The compat default privileges hand EXECUTE on new public functions
-- to anon too.
REVOKE ALL ON FUNCTION public.realtime_changes_since(timestamptz) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.realtime_changes_since(timestamptz) TO authenticated;

NOTIFY pgrst, 'reload schema';
