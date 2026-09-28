-- What POST /api/auth/session needs to turn a verified Firebase ID
-- token into an app session (docs/firebase-migration.md, phase 2).
--
--   auth_sync_user     the Supabase GoTrue part of signing in: creates
--                      the auth.users row on first sign-in (the
--                      upstream on_auth_user_created trigger then
--                      creates the profile and personal account) and
--                      keeps email / confirmation / last sign-in
--                      current afterwards.
--   auth_firebase_uid  uuid → Firebase UID, so the server can update
--                      the custom claims of a user other than the
--                      caller (e.g. a member an admin just removed).
--
-- Both take identities the server already verified, never browser
-- input, so only service_role may call them.

CREATE OR REPLACE FUNCTION public.auth_sync_user(
  p_firebase_uid   text,
  p_email          text,
  p_email_verified boolean,
  p_full_name      text
)
RETURNS TABLE (
  id                 uuid,
  email              text,
  raw_user_meta_data jsonb,
  raw_app_meta_data  jsonb,
  created_at         timestamptz
)
LANGUAGE plpgsql
SET search_path = ''
AS $$
DECLARE
  v_id        uuid;
  v_old_email text;
BEGIN
  -- ON CONFLICT covers two first sign-ins of the same user racing
  -- each other. A different user already holding this email raises
  -- 23505 on users_email_lower_idx; the route answers 409.
  INSERT INTO auth.users (firebase_uid, email, email_confirmed_at,
                          raw_user_meta_data, last_sign_in_at)
  VALUES (
    p_firebase_uid,
    p_email,
    CASE WHEN p_email_verified THEN now() END,
    jsonb_build_object('full_name', coalesce(p_full_name, '')),
    now()
  )
  ON CONFLICT (firebase_uid) DO NOTHING
  RETURNING auth.users.id INTO v_id;

  IF v_id IS NULL THEN
    SELECT u.id, u.email INTO v_id, v_old_email
    FROM auth.users u
    WHERE u.firebase_uid = p_firebase_uid
    FOR UPDATE;

    UPDATE auth.users u
    SET email              = p_email,
        email_confirmed_at = CASE WHEN p_email_verified
                               THEN coalesce(u.email_confirmed_at, now()) END,
        last_sign_in_at    = now(),
        updated_at         = now()
    WHERE u.id = v_id;

    -- An email change confirmed through Firebase reaches the app on
    -- the next sign-in. profiles.email is what the member list and
    -- the settings form show, so it follows auth.users.
    IF v_old_email IS DISTINCT FROM p_email THEN
      UPDATE public.profiles p SET email = p_email WHERE p.user_id = v_id;
    END IF;
  END IF;

  RETURN QUERY
  SELECT u.id, u.email, u.raw_user_meta_data, u.raw_app_meta_data, u.created_at
  FROM auth.users u
  WHERE u.id = v_id;
END
$$;

CREATE OR REPLACE FUNCTION public.auth_firebase_uid(p_user_id uuid)
RETURNS text
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT u.firebase_uid FROM auth.users u WHERE u.id = p_user_id
$$;

-- Same as 043: the compat default privileges hand EXECUTE on new
-- public functions to anon and authenticated.
REVOKE ALL ON FUNCTION public.auth_sync_user(text, text, boolean, text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auth_sync_user(text, text, boolean, text)
  TO service_role;

REVOKE ALL ON FUNCTION public.auth_firebase_uid(uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auth_firebase_uid(uuid)
  TO service_role;

NOTIFY pgrst, 'reload schema';
