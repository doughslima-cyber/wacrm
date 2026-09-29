-- Service-only SECURITY DEFINER functions: no API role may call them
-- (docs/firebase-migration.md, phase 6).
--
-- These functions run as their owner and never check who is calling.
-- 000_supabase_compat.sql reproduces Supabase's default privileges
-- (EXECUTE on every new public function for anon and authenticated),
-- and the upstream migrations only ever REVOKE ... FROM PUBLIC, so
-- they were all reachable through /api/rest/rpc/<name>, even without a
-- session. The isolation test (infra/isolation) showed an anonymous
-- request could:
--
--   record_webhook_failure(endpoint, n)   disable any account's webhook
--   claim_ai_reply_slot(conversation, n)  use up any conversation's AI
--                                         reply cap, stopping its bot
--   _bcast_bump(broadcast, column, delta) change any integer column of
--                                         any broadcast
--   recompute_broadcast_counts(broadcast) recount any broadcast
--   merge_duplicate_contacts() and
--   merge_duplicate_conversations()       run cross-account dedup passes
--
-- Every legitimate caller is server code on the service-role client
-- (src/lib/webhooks/deliver.ts, src/lib/ai/auto-reply.ts) or a trigger
-- function that is itself SECURITY DEFINER (broadcast counts), so
-- nothing in the app loses access. The same hole exists upstream on
-- Supabase; the fix lives here so the upstream files stay untouched.
--
-- infra/db/verify-rpc-grants.sql fails the migration run if a new
-- SECURITY DEFINER function becomes callable by anon or authenticated
-- without being reviewed.

DO $$
DECLARE
  fn text;
BEGIN
  FOREACH fn IN ARRAY ARRAY[
    'public.record_webhook_failure(uuid, integer)',
    'public.claim_ai_reply_slot(uuid, integer)',
    'public._bcast_bump(uuid, text, integer)',
    'public._bcast_cols_for_status(text)',
    'public.recompute_broadcast_counts(uuid)',
    'public.merge_duplicate_contacts()',
    'public.merge_duplicate_conversations()'
  ] LOOP
    EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
    EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
  END LOOP;
END
$$;

NOTIFY pgrst, 'reload schema';
