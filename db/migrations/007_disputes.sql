-- Milestone 4: disputes record the period they affect and the correction a
-- decision applied, so a locked score can be revised with both versions kept.
ALTER TABLE disputes ADD COLUMN employee_id uuid REFERENCES users(id);
ALTER TABLE disputes ADD COLUMN period_id text REFERENCES periods(id);
ALTER TABLE dispute_decisions ADD COLUMN correction jsonb;

CREATE VIEW dispute_current AS
SELECT d.*,
  dd.outcome, dd.reason AS decision_reason, dd.decided_by, dd.decided_at, dd.correction,
  (SELECT x.escalated_to FROM dispute_escalations x WHERE x.dispute_id = d.id ORDER BY x.id DESC LIMIT 1) AS escalated_to,
  CASE WHEN dd.id IS NOT NULL THEN 'decided'
       WHEN EXISTS (SELECT 1 FROM dispute_escalations x WHERE x.dispute_id = d.id) THEN 'escalated'
       ELSE 'open' END AS state
FROM disputes d
LEFT JOIN dispute_decisions dd ON dd.dispute_id = d.id;

-- How often each person's decisions are overturned on dispute.
CREATE VIEW dispute_overturn_rates AS
SELECT challenged_user_id AS user_id,
  count(*) FILTER (WHERE state = 'decided') AS decided,
  count(*) FILTER (WHERE outcome IN ('upheld', 'partly_upheld')) AS overturned,
  round(100.0 * count(*) FILTER (WHERE outcome IN ('upheld', 'partly_upheld')) / nullif(count(*) FILTER (WHERE state = 'decided'), 0), 1) AS overturn_pct
FROM dispute_current
GROUP BY challenged_user_id;

GRANT SELECT ON dispute_current, dispute_overturn_rates TO pms_app, pms_scoring, pms_readonly;

-- A blocker's outcome is the latest manager decision, so a dispute decision
-- can overturn an earlier rejection.
CREATE OR REPLACE VIEW blocker_current AS
SELECT b.*,
  (SELECT e.at FROM blocker_events e WHERE e.blocker_id = b.id AND e.kind = 'resolved' ORDER BY e.id LIMIT 1) AS resolved_at,
  (SELECT e.at FROM blocker_events e WHERE e.blocker_id = b.id AND e.kind IN ('acknowledged', 'disputed') ORDER BY e.id LIMIT 1) AS answered_at,
  coalesce(
    (SELECT e.kind::text FROM blocker_events e WHERE e.blocker_id = b.id AND e.kind IN ('upheld', 'rejected') ORDER BY e.id DESC LIMIT 1),
    CASE
      WHEN EXISTS (SELECT 1 FROM blocker_events e WHERE e.blocker_id = b.id AND e.kind = 'disputed') THEN 'open_dispute'
      WHEN EXISTS (SELECT 1 FROM blocker_events e WHERE e.blocker_id = b.id AND e.kind = 'acknowledged') THEN 'acknowledged'
      ELSE 'unanswered'
    END) AS outcome
FROM blockers b;
