-- Milestone 2: goal deadline revisions, notifications, and current-value views
-- that take them into account.

CREATE TABLE goal_revisions (
  id            bigserial PRIMARY KEY,
  goal_id       uuid NOT NULL REFERENCES goals(id),
  assignment_id bigint NOT NULL REFERENCES goal_assignments(id),
  field         text NOT NULL CHECK (field IN ('deadline')),
  old_value     jsonb NOT NULL,
  new_value     jsonb NOT NULL,
  reason        text NOT NULL CHECK (length(trim(reason)) > 0),
  changed_by    uuid NOT NULL REFERENCES users(id),
  changed_at    timestamptz NOT NULL DEFAULT now(),
  request_id    uuid REFERENCES change_requests(id)
);
SELECT protect_table('goal_revisions');

CREATE TABLE notifications (
  id           bigserial PRIMARY KEY,
  user_id      uuid NOT NULL REFERENCES users(id),
  kind         text NOT NULL,
  entity_type  text NOT NULL,
  entity_id    text NOT NULL,
  body         text NOT NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  read_at      timestamptz             -- set once
);
SELECT protect_table('notifications', ARRAY['read_at']);
CREATE INDEX notifications_user ON notifications (user_id, created_at DESC);

-- Escalations of long blockers, so each blocker escalates once.
CREATE TABLE blocker_escalations (
  id          bigserial PRIMARY KEY,
  blocker_id  uuid NOT NULL UNIQUE REFERENCES blockers(id),
  manager_id  uuid NOT NULL REFERENCES users(id),
  at          timestamptz NOT NULL DEFAULT now()
);
SELECT protect_table('blocker_escalations');

-- Reassignment after work started records how much credit stays with the
-- first employee (proposed by the lead, approved by the manager).
ALTER TABLE subtask_revisions ADD COLUMN credit_to_previous numeric(3,2)
  CHECK (credit_to_previous IS NULL OR (credit_to_previous BETWEEN 0 AND 1));

DROP VIEW goal_current;
CREATE VIEW goal_current AS
SELECT DISTINCT ON (g.id)
  g.id, g.title, g.priority, g.original_team_id, g.original_deadline,
  a.id AS assignment_id,
  a.team_id AS current_team_id,
  a.deadline AS assigned_deadline,
  coalesce((SELECT (r.new_value #>> '{}')::date FROM goal_revisions r
            WHERE r.assignment_id = a.id ORDER BY r.id DESC LIMIT 1), a.deadline) AS current_deadline,
  a.assigned_at AS team_assigned_at
FROM goals g
JOIN goal_assignments a ON a.goal_id = g.id AND a.ended_at IS NULL
ORDER BY g.id, a.id DESC;

-- Latest decision on each change request.
CREATE VIEW change_request_current AS
SELECT r.*,
  coalesce((SELECT d.status FROM change_request_decisions d WHERE d.request_id = r.id ORDER BY d.id DESC LIMIT 1),
           'pending'::request_status) AS status
FROM change_requests r;

-- Each blocker with its latest outcome and duration.
CREATE VIEW blocker_current AS
SELECT b.*,
  (SELECT e.at FROM blocker_events e WHERE e.blocker_id = b.id AND e.kind = 'resolved' ORDER BY e.id LIMIT 1) AS resolved_at,
  (SELECT e.at FROM blocker_events e WHERE e.blocker_id = b.id AND e.kind IN ('acknowledged', 'disputed') ORDER BY e.id LIMIT 1) AS answered_at,
  CASE
    WHEN EXISTS (SELECT 1 FROM blocker_events e WHERE e.blocker_id = b.id AND e.kind = 'rejected') THEN 'rejected'
    WHEN EXISTS (SELECT 1 FROM blocker_events e WHERE e.blocker_id = b.id AND e.kind = 'upheld') THEN 'upheld'
    WHEN EXISTS (SELECT 1 FROM blocker_events e WHERE e.blocker_id = b.id AND e.kind = 'disputed') THEN 'open_dispute'
    WHEN EXISTS (SELECT 1 FROM blocker_events e WHERE e.blocker_id = b.id AND e.kind = 'acknowledged') THEN 'acknowledged'
    ELSE 'unanswered'
  END AS outcome
FROM blockers b;

GRANT SELECT ON goal_revisions, notifications, blocker_escalations, goal_current, change_request_current, blocker_current
  TO pms_app, pms_scoring, pms_readonly;
GRANT INSERT ON goal_revisions, notifications, blocker_escalations TO pms_app;
GRANT UPDATE ON notifications TO pms_app;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO pms_app, pms_scoring;
