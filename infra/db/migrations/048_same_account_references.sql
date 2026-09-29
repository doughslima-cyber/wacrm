-- References stay inside one account (docs/firebase-migration.md,
-- phase 6).
--
-- The upstream policies (017_account_sharing.sql) check the account of
-- the row being written, not of the rows it points at, and a foreign
-- key accepts any existing id. The isolation test (infra/isolation)
-- showed a member of one account could, in their own account:
--
--   - create a deal on another account's contact or pipeline stage,
--     or a conversation with another account's contact;
--   - tag their contact with another account's tag;
--   - assign their conversation to a user of another account, which
--     made notify_conversation_assigned (027) file a notification, with
--     text they chose, for that user.
--
-- Nothing leaked through reads (RLS hides the embedded rows), but the
-- service-role code that later follows these references doesn't check
-- them. These triggers refuse such rows on every write path (browser,
-- routes, service role). They run only when a reference column
-- changes, so rows that already exist keep working, and they raise the
-- same error whether the referenced row is missing or belongs to
-- another account, so they don't reveal which ids exist.
--
-- The functions live in app_guard, a schema PostgREST doesn't expose,
-- and run as their owner so the lookups don't depend on the caller's
-- RLS.

CREATE SCHEMA IF NOT EXISTS app_guard;
REVOKE ALL ON SCHEMA app_guard FROM PUBLIC;

CREATE OR REPLACE FUNCTION app_guard.refuse(p_what text)
RETURNS void
LANGUAGE plpgsql
SET search_path = ''
AS $$
BEGIN
  RAISE EXCEPTION '% not found in this account', p_what
    USING ERRCODE = '23503';
END
$$;

-- Account of a parent row, NULL when it doesn't exist.
CREATE OR REPLACE FUNCTION app_guard.contact_account(p_id uuid)
RETURNS uuid LANGUAGE sql STABLE SET search_path = ''
AS $$ SELECT account_id FROM public.contacts WHERE id = p_id $$;

CREATE OR REPLACE FUNCTION app_guard.conversation_account(p_id uuid)
RETURNS uuid LANGUAGE sql STABLE SET search_path = ''
AS $$ SELECT account_id FROM public.conversations WHERE id = p_id $$;

CREATE OR REPLACE FUNCTION app_guard.pipeline_account(p_id uuid)
RETURNS uuid LANGUAGE sql STABLE SET search_path = ''
AS $$ SELECT account_id FROM public.pipelines WHERE id = p_id $$;

CREATE OR REPLACE FUNCTION app_guard.stage_account(p_id uuid)
RETURNS uuid LANGUAGE sql STABLE SET search_path = ''
AS $$
  SELECT p.account_id FROM public.pipeline_stages s
  JOIN public.pipelines p ON p.id = s.pipeline_id
  WHERE s.id = p_id
$$;

CREATE OR REPLACE FUNCTION app_guard.tag_account(p_id uuid)
RETURNS uuid LANGUAGE sql STABLE SET search_path = ''
AS $$ SELECT account_id FROM public.tags WHERE id = p_id $$;

CREATE OR REPLACE FUNCTION app_guard.custom_field_account(p_id uuid)
RETURNS uuid LANGUAGE sql STABLE SET search_path = ''
AS $$ SELECT account_id FROM public.custom_fields WHERE id = p_id $$;

CREATE OR REPLACE FUNCTION app_guard.broadcast_account(p_id uuid)
RETURNS uuid LANGUAGE sql STABLE SET search_path = ''
AS $$ SELECT account_id FROM public.broadcasts WHERE id = p_id $$;

-- Account of a user (auth.users id) and of a profile (profiles.id).
CREATE OR REPLACE FUNCTION app_guard.user_account(p_user_id uuid)
RETURNS uuid LANGUAGE sql STABLE SET search_path = ''
AS $$ SELECT account_id FROM public.profiles WHERE user_id = p_user_id $$;

CREATE OR REPLACE FUNCTION app_guard.profile_account(p_profile_id uuid)
RETURNS uuid LANGUAGE sql STABLE SET search_path = ''
AS $$ SELECT account_id FROM public.profiles WHERE id = p_profile_id $$;

CREATE OR REPLACE FUNCTION app_guard.message_conversation(p_id uuid)
RETURNS uuid LANGUAGE sql STABLE SET search_path = ''
AS $$ SELECT conversation_id FROM public.messages WHERE id = p_id $$;

-- ------------------------------------------------------------------
-- One trigger function per table. `moved(new, old)` is spelled out as
-- `TG_OP = 'INSERT' OR NEW.x IS DISTINCT FROM OLD.x` in each check.
-- ------------------------------------------------------------------

CREATE OR REPLACE FUNCTION app_guard.conversations_refs()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF NEW.contact_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.contact_id IS DISTINCT FROM OLD.contact_id
          OR NEW.account_id IS DISTINCT FROM OLD.account_id)
     AND app_guard.contact_account(NEW.contact_id) IS DISTINCT FROM NEW.account_id THEN
    PERFORM app_guard.refuse('contact');
  END IF;
  IF NEW.assigned_agent_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.assigned_agent_id IS DISTINCT FROM OLD.assigned_agent_id
          OR NEW.account_id IS DISTINCT FROM OLD.account_id)
     AND app_guard.user_account(NEW.assigned_agent_id) IS DISTINCT FROM NEW.account_id THEN
    PERFORM app_guard.refuse('assigned agent');
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION app_guard.deals_refs()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
DECLARE
  account_moved boolean := TG_OP = 'UPDATE' AND NEW.account_id IS DISTINCT FROM OLD.account_id;
BEGIN
  IF NEW.contact_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR account_moved OR NEW.contact_id IS DISTINCT FROM OLD.contact_id)
     AND app_guard.contact_account(NEW.contact_id) IS DISTINCT FROM NEW.account_id THEN
    PERFORM app_guard.refuse('contact');
  END IF;
  IF NEW.conversation_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR account_moved OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id)
     AND app_guard.conversation_account(NEW.conversation_id) IS DISTINCT FROM NEW.account_id THEN
    PERFORM app_guard.refuse('conversation');
  END IF;
  IF NEW.pipeline_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR account_moved OR NEW.pipeline_id IS DISTINCT FROM OLD.pipeline_id)
     AND app_guard.pipeline_account(NEW.pipeline_id) IS DISTINCT FROM NEW.account_id THEN
    PERFORM app_guard.refuse('pipeline');
  END IF;
  IF NEW.stage_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR account_moved OR NEW.stage_id IS DISTINCT FROM OLD.stage_id)
     AND app_guard.stage_account(NEW.stage_id) IS DISTINCT FROM NEW.account_id THEN
    PERFORM app_guard.refuse('pipeline stage');
  END IF;
  IF NEW.assigned_to IS NOT NULL
     AND (TG_OP = 'INSERT' OR account_moved OR NEW.assigned_to IS DISTINCT FROM OLD.assigned_to)
     AND app_guard.profile_account(NEW.assigned_to) IS DISTINCT FROM NEW.account_id THEN
    PERFORM app_guard.refuse('assignee');
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION app_guard.contact_notes_refs()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF (TG_OP = 'INSERT' OR NEW.contact_id IS DISTINCT FROM OLD.contact_id
      OR NEW.account_id IS DISTINCT FROM OLD.account_id)
     AND app_guard.contact_account(NEW.contact_id) IS DISTINCT FROM NEW.account_id THEN
    PERFORM app_guard.refuse('contact');
  END IF;
  RETURN NEW;
END
$$;

-- No account_id of their own: both parents must share one.
CREATE OR REPLACE FUNCTION app_guard.contact_tags_refs()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF (TG_OP = 'INSERT' OR NEW.contact_id IS DISTINCT FROM OLD.contact_id
      OR NEW.tag_id IS DISTINCT FROM OLD.tag_id)
     AND app_guard.tag_account(NEW.tag_id) IS DISTINCT FROM app_guard.contact_account(NEW.contact_id) THEN
    PERFORM app_guard.refuse('tag');
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION app_guard.contact_custom_values_refs()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF (TG_OP = 'INSERT' OR NEW.contact_id IS DISTINCT FROM OLD.contact_id
      OR NEW.custom_field_id IS DISTINCT FROM OLD.custom_field_id)
     AND app_guard.custom_field_account(NEW.custom_field_id)
         IS DISTINCT FROM app_guard.contact_account(NEW.contact_id) THEN
    PERFORM app_guard.refuse('custom field');
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION app_guard.broadcast_recipients_refs()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF NEW.contact_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.contact_id IS DISTINCT FROM OLD.contact_id
          OR NEW.broadcast_id IS DISTINCT FROM OLD.broadcast_id)
     AND app_guard.contact_account(NEW.contact_id)
         IS DISTINCT FROM app_guard.broadcast_account(NEW.broadcast_id) THEN
    PERFORM app_guard.refuse('contact');
  END IF;
  RETURN NEW;
END
$$;

-- The reaction's conversation is the one its message is in.
CREATE OR REPLACE FUNCTION app_guard.message_reactions_refs()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF (TG_OP = 'INSERT' OR NEW.message_id IS DISTINCT FROM OLD.message_id
      OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id)
     AND app_guard.message_conversation(NEW.message_id) IS DISTINCT FROM NEW.conversation_id THEN
    PERFORM app_guard.refuse('message');
  END IF;
  RETURN NEW;
END
$$;

-- A reply quotes a message of the same conversation.
CREATE OR REPLACE FUNCTION app_guard.messages_refs()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF NEW.reply_to_message_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.reply_to_message_id IS DISTINCT FROM OLD.reply_to_message_id
          OR NEW.conversation_id IS DISTINCT FROM OLD.conversation_id)
     AND app_guard.message_conversation(NEW.reply_to_message_id) IS DISTINCT FROM NEW.conversation_id THEN
    PERFORM app_guard.refuse('quoted message');
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION app_guard.ai_configs_refs()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF NEW.handoff_agent_id IS NOT NULL
     AND (TG_OP = 'INSERT' OR NEW.handoff_agent_id IS DISTINCT FROM OLD.handoff_agent_id
          OR NEW.account_id IS DISTINCT FROM OLD.account_id)
     AND app_guard.user_account(NEW.handoff_agent_id) IS DISTINCT FROM NEW.account_id THEN
    PERFORM app_guard.refuse('handoff agent');
  END IF;
  RETURN NEW;
END
$$;

-- Notifications go to members of the account they belong to. The only
-- writer is the 027 trigger, inside someone else's write, so a stray
-- one is dropped (RETURN NULL) instead of failing that write.
CREATE OR REPLACE FUNCTION app_guard.notifications_refs()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = ''
AS $$
BEGIN
  IF (TG_OP = 'INSERT' OR NEW.user_id IS DISTINCT FROM OLD.user_id
      OR NEW.account_id IS DISTINCT FROM OLD.account_id)
     AND app_guard.user_account(NEW.user_id) IS DISTINCT FROM NEW.account_id THEN
    RETURN NULL;
  END IF;
  RETURN NEW;
END
$$;

-- ------------------------------------------------------------------
-- Triggers. `UPDATE OF` keeps them off the hot paths (last_message_*,
-- unread counts, statuses), which never touch these columns.
-- ------------------------------------------------------------------

DROP TRIGGER IF EXISTS guard_refs ON public.conversations;
CREATE TRIGGER guard_refs BEFORE INSERT OR UPDATE OF contact_id, assigned_agent_id, account_id
  ON public.conversations FOR EACH ROW EXECUTE FUNCTION app_guard.conversations_refs();

DROP TRIGGER IF EXISTS guard_refs ON public.deals;
CREATE TRIGGER guard_refs BEFORE INSERT OR UPDATE OF contact_id, conversation_id, pipeline_id, stage_id, assigned_to, account_id
  ON public.deals FOR EACH ROW EXECUTE FUNCTION app_guard.deals_refs();

DROP TRIGGER IF EXISTS guard_refs ON public.contact_notes;
CREATE TRIGGER guard_refs BEFORE INSERT OR UPDATE OF contact_id, account_id
  ON public.contact_notes FOR EACH ROW EXECUTE FUNCTION app_guard.contact_notes_refs();

DROP TRIGGER IF EXISTS guard_refs ON public.contact_tags;
CREATE TRIGGER guard_refs BEFORE INSERT OR UPDATE OF contact_id, tag_id
  ON public.contact_tags FOR EACH ROW EXECUTE FUNCTION app_guard.contact_tags_refs();

DROP TRIGGER IF EXISTS guard_refs ON public.contact_custom_values;
CREATE TRIGGER guard_refs BEFORE INSERT OR UPDATE OF contact_id, custom_field_id
  ON public.contact_custom_values FOR EACH ROW EXECUTE FUNCTION app_guard.contact_custom_values_refs();

DROP TRIGGER IF EXISTS guard_refs ON public.broadcast_recipients;
CREATE TRIGGER guard_refs BEFORE INSERT OR UPDATE OF contact_id, broadcast_id
  ON public.broadcast_recipients FOR EACH ROW EXECUTE FUNCTION app_guard.broadcast_recipients_refs();

DROP TRIGGER IF EXISTS guard_refs ON public.message_reactions;
CREATE TRIGGER guard_refs BEFORE INSERT OR UPDATE OF message_id, conversation_id
  ON public.message_reactions FOR EACH ROW EXECUTE FUNCTION app_guard.message_reactions_refs();

DROP TRIGGER IF EXISTS guard_refs ON public.messages;
CREATE TRIGGER guard_refs BEFORE INSERT OR UPDATE OF reply_to_message_id, conversation_id
  ON public.messages FOR EACH ROW EXECUTE FUNCTION app_guard.messages_refs();

DROP TRIGGER IF EXISTS guard_refs ON public.ai_configs;
CREATE TRIGGER guard_refs BEFORE INSERT OR UPDATE OF handoff_agent_id, account_id
  ON public.ai_configs FOR EACH ROW EXECUTE FUNCTION app_guard.ai_configs_refs();

DROP TRIGGER IF EXISTS guard_refs ON public.notifications;
CREATE TRIGGER guard_refs BEFORE INSERT OR UPDATE OF user_id, account_id
  ON public.notifications FOR EACH ROW EXECUTE FUNCTION app_guard.notifications_refs();
