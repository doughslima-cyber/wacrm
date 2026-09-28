-- Lets the app server turn a verified Firebase session into the
-- auth.users row (uuid, email, metadata) that every RLS policy keys on.
--
-- PostgREST only exposes the `public` schema, so the server has no
-- direct read on auth.users. This function is that one door, and only
-- service_role may open it: the Firebase UID comes from a session
-- cookie the server already verified, never from a browser.

CREATE OR REPLACE FUNCTION public.auth_user_by_firebase_uid(p_firebase_uid text)
RETURNS TABLE (
  id                 uuid,
  email              text,
  raw_user_meta_data jsonb,
  raw_app_meta_data  jsonb,
  created_at         timestamptz
)
LANGUAGE sql
STABLE
SET search_path = ''
AS $$
  SELECT u.id, u.email, u.raw_user_meta_data, u.raw_app_meta_data, u.created_at
  FROM auth.users u
  WHERE u.firebase_uid = p_firebase_uid
$$;

-- The compat layer's default privileges grant EXECUTE on every new
-- public function to anon and authenticated; take that back here.
REVOKE ALL ON FUNCTION public.auth_user_by_firebase_uid(text)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.auth_user_by_firebase_uid(text)
  TO service_role;

-- New function → PostgREST must rebuild its schema cache.
NOTIFY pgrst, 'reload schema';
