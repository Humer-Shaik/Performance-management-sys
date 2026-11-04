-- Append-only, hash-chained audit log, and triggers that stop history from
-- being edited or deleted.
--
-- The app tells the database who is acting and why with two transaction-local
-- settings, set before any write:
--   SELECT set_config('app.actor_id', '<user uuid>', true);
--   SELECT set_config('app.reason',   '<why>',       true);
-- Writes without an actor are refused.

CREATE TABLE audit_log (
  seq          bigint PRIMARY KEY,
  at           timestamptz NOT NULL,
  actor_id     uuid,
  db_user      text NOT NULL,
  action       text NOT NULL,           -- INSERT or UPDATE (DELETE is never allowed)
  entity_type  text NOT NULL,
  entity_id    text NOT NULL,
  old_value    jsonb,
  new_value    jsonb,
  reason       text,
  prev_hash    text NOT NULL,
  hash         text NOT NULL
);

-- The exact bytes that are hashed. Used by the writer and the verifier, so the
-- two can never disagree on format.
CREATE FUNCTION audit_payload(
  p_prev_hash text, p_seq bigint, p_at timestamptz, p_actor uuid, p_db_user text,
  p_action text, p_entity_type text, p_entity_id text,
  p_old jsonb, p_new jsonb, p_reason text
) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT concat_ws('|',
    p_prev_hash,
    p_seq::text,
    to_char(p_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    coalesce(p_actor::text, ''),
    p_db_user,
    p_action,
    p_entity_type,
    p_entity_id,
    coalesce(p_old::text, 'null'),
    coalesce(p_new::text, 'null'),
    coalesce(p_reason, '')
  )
$$;

CREATE FUNCTION audit_hash(p_payload text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT encode(digest(p_payload, 'sha256'), 'hex')
$$;

-- Single writer for the chain. The advisory lock serialises writers so every
-- entry links to exactly one predecessor.
CREATE FUNCTION append_audit(
  p_action text, p_entity_type text, p_entity_id text, p_old jsonb, p_new jsonb
) RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_prev  text;
  v_seq   bigint;
  v_at    timestamptz := clock_timestamp();
  v_actor uuid := nullif(current_setting('app.actor_id', true), '')::uuid;
  v_reason text := nullif(current_setting('app.reason', true), '');
BEGIN
  PERFORM pg_advisory_xact_lock(8675309);
  SELECT seq, hash INTO v_seq, v_prev FROM audit_log ORDER BY seq DESC LIMIT 1;
  v_seq  := coalesce(v_seq, 0) + 1;
  v_prev := coalesce(v_prev, repeat('0', 64));

  INSERT INTO audit_log (seq, at, actor_id, db_user, action, entity_type, entity_id,
                         old_value, new_value, reason, prev_hash, hash)
  VALUES (v_seq, v_at, v_actor, session_user, p_action, p_entity_type, p_entity_id,
          p_old, p_new, v_reason, v_prev,
          audit_hash(audit_payload(v_prev, v_seq, v_at, v_actor, session_user, p_action,
                                   p_entity_type, p_entity_id, p_old, p_new, v_reason)));
END;
$$;

-- Row trigger: every insert and update on a tracked table is logged in the
-- same transaction as the change.
CREATE FUNCTION audit_row() RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_new jsonb := CASE WHEN TG_OP IN ('INSERT', 'UPDATE') THEN to_jsonb(NEW) END;
  v_old jsonb := CASE WHEN TG_OP = 'UPDATE' THEN to_jsonb(OLD) END;
BEGIN
  IF nullif(current_setting('app.actor_id', true), '') IS NULL THEN
    RAISE EXCEPTION 'No actor set: call set_config(''app.actor_id'', ...) before writing to %', TG_TABLE_NAME
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  PERFORM append_audit(TG_OP, TG_TABLE_NAME, coalesce(v_new, v_old)->>'id', v_old, v_new);
  RETURN NULL;
END;
$$;

-- Refuse any update or delete on the audit log itself, for every role.
CREATE FUNCTION audit_log_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_log is append-only: % is not allowed', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$;

CREATE TRIGGER audit_log_no_update BEFORE UPDATE OR DELETE ON audit_log
  FOR EACH ROW EXECUTE FUNCTION audit_log_guard();
CREATE TRIGGER audit_log_no_truncate BEFORE TRUNCATE ON audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION audit_log_guard();

-- History guard: rows can never be deleted, and an update may only fill a
-- "set once" column (named in the trigger arguments) that is still null.
CREATE FUNCTION history_guard() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  v_old jsonb;
  v_new jsonb;
  v_col text;
BEGIN
  IF TG_OP IN ('DELETE', 'TRUNCATE') THEN
    RAISE EXCEPTION '% is append-only: % is not allowed', TG_TABLE_NAME, TG_OP
      USING ERRCODE = 'insufficient_privilege';
  END IF;

  v_old := to_jsonb(OLD);
  v_new := to_jsonb(NEW);
  FOREACH v_col IN ARRAY coalesce(TG_ARGV, ARRAY[]::text[]) LOOP
    IF v_old->v_col IS NOT NULL AND v_old->v_col <> 'null'::jsonb
       AND v_old->v_col IS DISTINCT FROM v_new->v_col THEN
      RAISE EXCEPTION '%.% is already set and cannot be changed', TG_TABLE_NAME, v_col
        USING ERRCODE = 'insufficient_privilege';
    END IF;
    v_old := v_old - v_col;
    v_new := v_new - v_col;
  END LOOP;

  IF v_old IS DISTINCT FROM v_new THEN
    RAISE EXCEPTION '% is append-only: only set-once columns (%) can be filled in',
      TG_TABLE_NAME, array_to_string(TG_ARGV, ', ')
      USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$;

-- Attach the guard and the audit trigger to a table.
CREATE FUNCTION protect_table(p_table regclass, p_set_once text[] DEFAULT '{}') RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  v_args text := (SELECT coalesce(string_agg(quote_literal(c), ', '), '') FROM unnest(p_set_once) c);
BEGIN
  EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON %s FOR EACH ROW EXECUTE FUNCTION history_guard(%s)',
                 'history_guard', p_table, v_args);
  EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %s FOR EACH STATEMENT EXECUTE FUNCTION history_guard()',
                 'history_no_truncate', p_table);
  EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION audit_row()',
                 'audit', p_table);
END;
$$;

-- Tables whose rows may be edited (names, team leads) but every change is logged.
CREATE FUNCTION audit_only(p_table regclass) RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  EXECUTE format('CREATE TRIGGER %I AFTER INSERT OR UPDATE ON %s FOR EACH ROW EXECUTE FUNCTION audit_row()',
                 'audit', p_table);
  EXECUTE format('CREATE TRIGGER %I BEFORE DELETE ON %s FOR EACH ROW EXECUTE FUNCTION history_guard()',
                 'history_guard', p_table);
  EXECUTE format('CREATE TRIGGER %I BEFORE TRUNCATE ON %s FOR EACH STATEMENT EXECUTE FUNCTION history_guard()',
                 'history_no_truncate', p_table);
END;
$$;

SELECT audit_only('users');
SELECT audit_only('teams');

SELECT protect_table('user_roles',               ARRAY['valid_to']);
SELECT protect_table('team_members',             ARRAY['valid_to']);
SELECT protect_table('scoring_rule_versions',    ARRAY['approved_by', 'approved_at', 'effective_from_period']);
SELECT protect_table('periods',                  ARRAY['locked_at']);
SELECT protect_table('goals');
SELECT protect_table('goal_assignments',         ARRAY['ended_at', 'progress_at_transfer', 'overdue_at_transfer']);
SELECT protect_table('change_requests',          ARRAY['approver_id']);
SELECT protect_table('change_request_decisions');
SELECT protect_table('subtasks');
SELECT protect_table('subtask_revisions');
SELECT protect_table('subtask_merges');
SELECT protect_table('status_events');
SELECT protect_table('progress_updates');
SELECT protect_table('blockers');
SELECT protect_table('blocker_events');
SELECT protect_table('quality_ratings');
SELECT protect_table('quality_rating_reviews');
SELECT protect_table('collaboration_ratings');
SELECT protect_table('disputes');
SELECT protect_table('dispute_decisions');
SELECT protect_table('dispute_escalations');
SELECT protect_table('score_snapshots');
SELECT protect_table('owner_notes');

-- Verifier: walks the chain and returns the first entry whose hash or link is
-- wrong, or no rows when the chain is intact.
CREATE FUNCTION verify_audit_chain(p_from bigint DEFAULT 1)
RETURNS TABLE (bad_seq bigint, problem text) LANGUAGE plpgsql STABLE AS $$
DECLARE
  r       audit_log%ROWTYPE;
  v_prev  text;
  v_expect_seq bigint := p_from;
BEGIN
  IF p_from > 1 THEN
    SELECT hash INTO v_prev FROM audit_log WHERE seq = p_from - 1;
  ELSE
    v_prev := repeat('0', 64);
  END IF;

  FOR r IN SELECT * FROM audit_log WHERE seq >= p_from ORDER BY seq LOOP
    IF r.seq <> v_expect_seq THEN
      bad_seq := v_expect_seq; problem := 'missing entry'; RETURN NEXT; RETURN;
    END IF;
    IF r.prev_hash <> v_prev THEN
      bad_seq := r.seq; problem := 'prev_hash does not match previous entry'; RETURN NEXT; RETURN;
    END IF;
    IF r.hash <> audit_hash(audit_payload(r.prev_hash, r.seq, r.at, r.actor_id, r.db_user, r.action,
                                          r.entity_type, r.entity_id, r.old_value, r.new_value, r.reason)) THEN
      bad_seq := r.seq; problem := 'hash does not match entry contents'; RETURN NEXT; RETURN;
    END IF;
    v_prev := r.hash;
    v_expect_seq := r.seq + 1;
  END LOOP;
END;
$$;

-- Daily anchors: the last hash of each day, copied by a job to write-once
-- external storage. A rewritten chain will not match the anchors.
CREATE VIEW audit_daily_anchors AS
SELECT DISTINCT ON ((at AT TIME ZONE 'UTC')::date)
  (at AT TIME ZONE 'UTC')::date AS day, seq, hash
FROM audit_log
ORDER BY (at AT TIME ZONE 'UTC')::date, seq DESC;
