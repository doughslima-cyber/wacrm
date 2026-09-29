-- Notification DELETE signals carry read_at (docs/firebase-migration.md,
-- phase 4).
--
-- A DELETE signal only carries the keys the trigger captured, and
-- useUnreadNotifications decrements the unread badge unless
-- `old.read_at` is set. Without read_at in the keys, deleting an
-- already-read notification (e.g. a contact deletion cascading to its
-- notifications) lowered the count anyway.
--
-- Only DELETE gets it: INSERT/UPDATE listeners receive the fetched row.
-- Same function as 045 otherwise; the triggers keep pointing at it.

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
      -- A DELETE carries only these keys, and useUnreadNotifications
      -- reads `old.read_at` to decide whether the unread count drops.
      IF TG_OP = 'DELETE' THEN
        v_keys := v_keys || jsonb_build_object('read_at', r.read_at);
      END IF;
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

