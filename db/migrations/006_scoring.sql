-- Milestone 3: score snapshots written by the scoring role, quarter locks.

-- Until HR's first rule version is approved the engine uses the built-in
-- defaults; their version label is kept in the breakdown.
ALTER TABLE score_snapshots ALTER COLUMN rule_version_id DROP NOT NULL;
ALTER TABLE score_snapshots ADD COLUMN rule_version_label text NOT NULL DEFAULT 'defaults';

-- One locked snapshot per employee and period, unless a dispute revises it.
CREATE UNIQUE INDEX score_snapshots_one_locked ON score_snapshots (period_id, employee_id) WHERE status = 'locked';

-- The score in force: the newest snapshot nothing has superseded.
CREATE VIEW score_current AS
SELECT DISTINCT ON (s.period_id, s.employee_id) s.*
FROM score_snapshots s
WHERE NOT EXISTS (SELECT 1 FROM score_snapshots n WHERE n.supersedes_id = s.id)
ORDER BY s.period_id, s.employee_id,
  CASE s.status WHEN 'revised_by_dispute' THEN 0 WHEN 'locked' THEN 1 ELSE 2 END, s.computed_at DESC;

-- Latest rating by the lead per subtask (reopen penalties are separate rows).
CREATE VIEW quality_rating_latest AS
SELECT q.* FROM quality_ratings q
WHERE NOT q.is_reopen AND NOT EXISTS (SELECT 1 FROM quality_ratings n WHERE n.supersedes_id = q.id);

-- The period a date falls in, and whether it is locked.
CREATE FUNCTION period_locked_on(p_day date) RETURNS boolean LANGUAGE sql STABLE AS $$
  SELECT EXISTS (SELECT 1 FROM periods WHERE p_day BETWEEN starts_on AND ends_on AND locked_at IS NOT NULL)
$$;

GRANT SELECT ON score_current, quality_rating_latest TO pms_app, pms_scoring, pms_readonly;
GRANT UPDATE ON periods TO pms_scoring;
GRANT INSERT ON notifications TO pms_scoring;
GRANT USAGE ON ALL SEQUENCES IN SCHEMA public TO pms_scoring;
