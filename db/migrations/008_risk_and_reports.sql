-- Milestone 5a: risk checks and report helpers.

CREATE TABLE risk_checks (
  id             bigserial PRIMARY KEY,
  goal_id        uuid NOT NULL REFERENCES goals(id),
  assignment_id  bigint NOT NULL REFERENCES goal_assignments(id),
  level          text NOT NULL CHECK (level IN ('on_track', 'at_risk', 'critical', 'overdue', 'done')),
  time_pct       numeric(5,1) NOT NULL,
  work_pct       numeric(5,1) NOT NULL,
  changed        boolean NOT NULL,
  checked_at     timestamptz NOT NULL DEFAULT now()
);
SELECT protect_table('risk_checks');
CREATE INDEX risk_checks_goal ON risk_checks (goal_id, id DESC);

CREATE VIEW goal_risk_current AS
SELECT DISTINCT ON (goal_id) * FROM risk_checks ORDER BY goal_id, id DESC;

-- When each subtask was finally done (null if not done now).
CREATE VIEW subtask_done_at AS
SELECT sc.id, CASE WHEN sc.status = 'done'
  THEN (SELECT e.at FROM status_events e WHERE e.subtask_id = sc.id AND e.to_status = 'done' ORDER BY e.id DESC LIMIT 1) END AS done_at
FROM subtask_current sc;

GRANT SELECT ON risk_checks, goal_risk_current, subtask_done_at TO pms_app, pms_scoring, pms_readonly;
GRANT INSERT ON risk_checks TO pms_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO pms_app;
