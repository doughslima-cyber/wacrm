-- Run by db/migrate.mjs after supabase/ci/verify-schema.sql.
--
-- A SECURITY DEFINER function in public runs with its owner's rights,
-- and the compat default privileges let anon and authenticated call any
-- new one through /api/rest/rpc. That is only safe when the function
-- checks the caller itself (auth.uid(), a token). The ones below were
-- reviewed and do; anything else callable by an API role fails the run,
-- so an upstream merge can't open a new one silently. Review the new
-- function, then either add it here or revoke it (see migration 047).
--
-- Trigger functions are skipped: they can't be called as an RPC.

DO $$
DECLARE
  reviewed constant text[] := ARRAY[
    'is_account_member(target_account_id uuid, min_role account_role_enum)', -- reads auth.uid()
    'peek_invitation(p_token_hash text)',                                    -- needs the invite token
    'redeem_invitation(p_token_hash text)',                                  -- token + auth.uid()
    'remove_account_member(p_user_id uuid)',                                 -- caller admin of the same account
    'set_member_role(p_user_id uuid, p_new_role account_role_enum)',         -- caller admin of the same account
    'transfer_account_ownership(p_new_owner_user_id uuid)',                  -- caller owner of the same account
    'touch_presence(p_status text)',                                         -- the caller's own row
    'realtime_changes_since(p_after timestamp with time zone)'               -- the caller's accounts only
  ];
  offenders text;
BEGIN
  SELECT string_agg(sig, ', ' ORDER BY sig) INTO offenders
  FROM (
    SELECT p.proname || '(' || pg_get_function_identity_arguments(p.oid) || ')' AS sig
    FROM pg_proc p
    JOIN pg_namespace n ON n.oid = p.pronamespace
    WHERE n.nspname = 'public'
      AND p.prosecdef
      AND p.prorettype <> 'trigger'::regtype
      AND (has_function_privilege('anon', p.oid, 'EXECUTE')
        OR has_function_privilege('authenticated', p.oid, 'EXECUTE'))
  ) f
  WHERE sig <> ALL (reviewed);

  IF offenders IS NOT NULL THEN
    RAISE EXCEPTION 'SECURITY DEFINER functions callable by anon/authenticated without review: %', offenders;
  END IF;
END
$$;
