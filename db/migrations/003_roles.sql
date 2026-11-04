-- Database roles. The app never connects as the table owner, so it cannot
-- disable triggers, alter tables or rewrite history.
--   pms_app      the web app: read everything, insert history, fill set-once columns
--   pms_scoring  the scoring engine: the only role that can write score snapshots
--   pms_readonly IT and reporting: read only
-- Login users (with passwords) are created per environment and granted one of these.

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pms_app')      THEN CREATE ROLE pms_app NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pms_scoring')  THEN CREATE ROLE pms_scoring NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'pms_readonly') THEN CREATE ROLE pms_readonly NOLOGIN; END IF;
END $$;

GRANT USAGE ON SCHEMA public TO pms_app, pms_scoring, pms_readonly;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO pms_app, pms_scoring, pms_readonly;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO pms_app, pms_scoring;

GRANT INSERT ON ALL TABLES IN SCHEMA public TO pms_app;
REVOKE INSERT ON audit_log, score_snapshots FROM pms_app;

-- Only these tables have columns the app may fill in later; the history guard
-- trigger still refuses any other change.
GRANT UPDATE ON users, teams, user_roles, team_members, scoring_rule_versions, periods,
                goal_assignments, change_requests TO pms_app;

GRANT INSERT ON score_snapshots TO pms_scoring;

-- Nobody but the owner role of the schema can write the audit log directly;
-- entries come only from the SECURITY DEFINER trigger functions.
REVOKE ALL ON audit_log FROM PUBLIC;
GRANT SELECT ON audit_log TO pms_app, pms_scoring, pms_readonly;
REVOKE EXECUTE ON FUNCTION append_audit(text, text, text, jsonb, jsonb) FROM PUBLIC;
