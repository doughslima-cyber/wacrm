-- 000_supabase_compat.sql
--
-- Recreates, on a plain Postgres (Cloud SQL), the objects a Supabase
-- project ships with and that supabase/migrations/* assume exist.
-- Applied once, before the upstream migrations, which stay untouched.
--
-- What each block stands in for:
--   roles      anon / authenticated / service_role / authenticator, the
--              PostgREST role-switching model Supabase uses.
--   auth       auth.users (a real table here; rows are written by the
--              app when a Firebase user first signs in) and the
--              auth.uid() / auth.role() / auth.jwt() helpers every RLS
--              policy calls. They read the claims PostgREST sets from
--              the short-lived JWT our /api/rest proxy mints, exactly as
--              on Supabase, so the 155 policies apply unchanged.
--   storage    stub tables so the bucket migrations (008/016/023/039)
--              and their storage.objects policies apply. Files live in
--              Cloud Storage; these rows document the per-bucket limits
--              the Storage rules mirror.
--   realtime   the supabase_realtime publication the migrations add
--              tables to. Unused here (realtime goes through pg_notify),
--              kept so the DO blocks that reference it apply.
--
-- Idempotent: safe to re-run.

-- ------------------------------------------------------------
-- Roles
-- ------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    CREATE ROLE anon NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    CREATE ROLE authenticated NOLOGIN NOINHERIT;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
    CREATE ROLE service_role NOLOGIN NOINHERIT BYPASSRLS;
  END IF;
  -- authenticator is the login PostgREST connects as; it can only
  -- SET ROLE into the three roles above. Its password is set out of
  -- band (infra/db/migrate.mjs, from Secret Manager).
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticator') THEN
    CREATE ROLE authenticator LOGIN NOINHERIT;
  END IF;
END
$$;

GRANT anon, authenticated, service_role TO authenticator;

-- ------------------------------------------------------------
-- Schemas and search_path (Supabase: "$user", public, extensions)
-- ------------------------------------------------------------
CREATE SCHEMA IF NOT EXISTS auth;
CREATE SCHEMA IF NOT EXISTS storage;
CREATE SCHEMA IF NOT EXISTS extensions;

GRANT USAGE ON SCHEMA public, auth, storage, extensions
  TO anon, authenticated, service_role;

DO $$
BEGIN
  EXECUTE format(
    'ALTER DATABASE %I SET search_path = "$user", public, extensions',
    current_database()
  );
END
$$;

-- Supabase's per-role statement timeouts, so a runaway query from the
-- API can't pin a connection on the small Cloud SQL instance.
ALTER ROLE anon SET statement_timeout = '3s';
ALTER ROLE authenticated SET statement_timeout = '8s';

-- Supabase grants the API roles full table/sequence/function access in
-- public by default and lets RLS do the gating. The migrations rely on
-- that (they only ever REVOKE). Reproduce it for objects postgres
-- creates from here on.
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT ALL ON TABLES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT ALL ON SEQUENCES TO anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public
  GRANT EXECUTE ON FUNCTIONS TO anon, authenticated, service_role;

-- ------------------------------------------------------------
-- auth helpers — same signatures and claim lookups as Supabase
-- ------------------------------------------------------------
CREATE OR REPLACE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE AS $$
  SELECT coalesce(
    nullif(current_setting('request.jwt.claim.sub', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
  )::uuid
$$;

CREATE OR REPLACE FUNCTION auth.role() RETURNS text
LANGUAGE sql STABLE AS $$
  SELECT coalesce(
    nullif(current_setting('request.jwt.claim.role', true), ''),
    (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'role')
  )::text
$$;

CREATE OR REPLACE FUNCTION auth.jwt() RETURNS jsonb
LANGUAGE sql STABLE AS $$
  SELECT coalesce(
    nullif(current_setting('request.jwt.claim', true), ''),
    nullif(current_setting('request.jwt.claims', true), '')
  )::jsonb
$$;

GRANT EXECUTE ON FUNCTION auth.uid(), auth.role(), auth.jwt()
  TO anon, authenticated, service_role;

-- ------------------------------------------------------------
-- auth.users — the columns the migrations read (id, email,
-- raw_user_meta_data) plus the Firebase link.
-- Not granted to anon/authenticated, same as Supabase: only
-- SECURITY DEFINER functions and service_role touch it.
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS auth.users (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  firebase_uid        text UNIQUE NOT NULL,
  email               text,
  email_confirmed_at  timestamptz,
  raw_user_meta_data  jsonb NOT NULL DEFAULT '{}'::jsonb,
  raw_app_meta_data   jsonb NOT NULL DEFAULT '{}'::jsonb,
  last_sign_in_at     timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_idx
  ON auth.users (lower(email));

GRANT SELECT, INSERT, UPDATE, DELETE ON auth.users TO service_role;

-- ------------------------------------------------------------
-- storage stubs
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS storage.buckets (
  id                  text PRIMARY KEY,
  name                text NOT NULL,
  public              boolean DEFAULT false,
  file_size_limit     bigint,
  allowed_mime_types  text[],
  owner               uuid,
  created_at          timestamptz DEFAULT now(),
  updated_at          timestamptz DEFAULT now()
);

CREATE TABLE IF NOT EXISTS storage.objects (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  bucket_id   text REFERENCES storage.buckets (id),
  name        text,
  owner       uuid,
  metadata    jsonb,
  created_at  timestamptz DEFAULT now(),
  updated_at  timestamptz DEFAULT now()
);

ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;

GRANT SELECT ON storage.buckets TO anon, authenticated, service_role;
GRANT ALL ON storage.objects TO authenticated, service_role;

-- Supabase's helper: every path segment except the file name.
CREATE OR REPLACE FUNCTION storage.foldername(name text) RETURNS text[]
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  _parts text[];
BEGIN
  SELECT string_to_array(name, '/') INTO _parts;
  RETURN _parts[1 : array_length(_parts, 1) - 1];
END
$$;

GRANT EXECUTE ON FUNCTION storage.foldername(text)
  TO anon, authenticated, service_role;

-- ------------------------------------------------------------
-- realtime publication (inert; see header)
-- ------------------------------------------------------------
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_publication WHERE pubname = 'supabase_realtime') THEN
    CREATE PUBLICATION supabase_realtime;
  END IF;
END
$$;
