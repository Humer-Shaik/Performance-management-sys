-- Current values derived from originals plus revisions. Nothing stores a
-- "current" value that could be overwritten.

CREATE VIEW subtask_current AS
SELECT
  s.id,
  s.goal_id,
  s.title,
  s.original_points,
  coalesce((SELECT (r.new_value #>> '{}')::smallint FROM subtask_revisions r
            WHERE r.subtask_id = s.id AND r.field = 'points' ORDER BY r.id DESC LIMIT 1),
           s.original_points) AS points,
  s.original_due,
  coalesce((SELECT (r.new_value #>> '{}')::date FROM subtask_revisions r
            WHERE r.subtask_id = s.id AND r.field = 'due' ORDER BY r.id DESC LIMIT 1),
           s.original_due) AS due,
  s.original_assignee,
  coalesce((SELECT (r.new_value #>> '{}')::uuid FROM subtask_revisions r
            WHERE r.subtask_id = s.id AND r.field = 'assignee' ORDER BY r.id DESC LIMIT 1),
           s.original_assignee) AS assignee,
  coalesce((SELECT (r.new_value #>> '{}')::boolean FROM subtask_revisions r
            WHERE r.subtask_id = s.id AND r.field = 'scope' ORDER BY r.id DESC LIMIT 1),
           true) AS in_scope,
  coalesce((SELECT e.to_status FROM status_events e
            WHERE e.subtask_id = s.id ORDER BY e.id DESC LIMIT 1),
           'not_started') AS status,
  s.assigned_at,
  s.review_required
FROM subtasks s
WHERE NOT EXISTS (SELECT 1 FROM subtask_merges m WHERE m.merged_from = s.id);

CREATE VIEW goal_current AS
SELECT DISTINCT ON (g.id)
  g.id, g.title, g.priority, g.original_team_id, g.original_deadline,
  a.team_id AS current_team_id, a.deadline AS current_deadline, a.assigned_at AS team_assigned_at
FROM goals g
JOIN goal_assignments a ON a.goal_id = g.id AND a.ended_at IS NULL
ORDER BY g.id, a.id DESC;

-- Latest version of each quality rating (older versions stay in the table).
CREATE VIEW quality_rating_current AS
SELECT q.* FROM quality_ratings q
WHERE NOT EXISTS (SELECT 1 FROM quality_ratings n WHERE n.supersedes_id = q.id);

GRANT SELECT ON subtask_current, goal_current, quality_rating_current, audit_daily_anchors
  TO pms_app, pms_scoring, pms_readonly;
