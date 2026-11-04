// The owner's raw view: underlying records, unfiltered, read-only, with
// export. No lead, manager or admin setting can narrow what is returned here.
import type pg from "pg";
import { many, withActor, type Db } from "./db";
import { forbid, invalid } from "./errors";
import { has, loadActor } from "./policy";

export const RAW_VIEWS = {
  goals: `SELECT g.id, g.title, g.priority, g.created_at, cb.name AS created_by, ot.name AS original_team, g.original_deadline,
            ct.name AS current_team, gc.current_deadline, r.level AS risk, r.work_pct, r.time_pct, r.checked_at AS risk_checked_at
          FROM goals g JOIN goal_current gc ON gc.id = g.id JOIN users cb ON cb.id = g.created_by
          JOIN teams ot ON ot.id = g.original_team_id JOIN teams ct ON ct.id = gc.current_team_id
          LEFT JOIN goal_risk_current r ON r.goal_id = g.id ORDER BY g.created_at`,
  subtasks: `SELECT s.id, g.title AS goal, s.title, s.acceptance_criteria, s.reference_points, s.original_points, sc.points AS current_points,
            s.override_reason, s.original_due, sc.due AS current_due, s.short_lead_reason, oa.name AS original_assignee, ca.name AS current_assignee,
            s.assigned_at, sc.status, sc.in_scope, s.split_from, d.done_at
          FROM subtasks s JOIN goals g ON g.id = s.goal_id LEFT JOIN subtask_current sc ON sc.id = s.id
          JOIN users oa ON oa.id = s.original_assignee LEFT JOIN users ca ON ca.id = sc.assignee
          LEFT JOIN subtask_done_at d ON d.id = s.id ORDER BY s.assigned_at`,
  assignments: `SELECT a.id, g.title AS goal, t.name AS team, a.deadline, a.assigned_at, ab.name AS assigned_by, a.reason,
            a.ended_at, a.progress_at_transfer, a.overdue_at_transfer
          FROM goal_assignments a JOIN goals g ON g.id = a.goal_id JOIN teams t ON t.id = a.team_id JOIN users ab ON ab.id = a.assigned_by
          ORDER BY a.goal_id, a.id`,
  changes: `SELECT 'subtask' AS target, r.subtask_id::text AS target_id, r.field, r.old_value, r.new_value, r.reason, u.name AS changed_by,
            r.changed_at, r.request_id, r.credit_to_previous FROM subtask_revisions r JOIN users u ON u.id = r.changed_by
          UNION ALL
          SELECT 'goal', r.goal_id::text, r.field, r.old_value, r.new_value, r.reason, u.name, r.changed_at, r.request_id, NULL
            FROM goal_revisions r JOIN users u ON u.id = r.changed_by
          ORDER BY changed_at`,
  requests: `SELECT r.id, r.target_type, r.target_id, r.field, r.old_value, r.new_value, r.reason, rb.name AS requested_by, r.requested_at,
            ap.name AS approver, r.status FROM change_request_current r JOIN users rb ON rb.id = r.requested_by
            LEFT JOIN users ap ON ap.id = r.approver_id ORDER BY r.requested_at`,
  ratings: `SELECT q.id, s.title AS subtask, e.name AS employee, rt.name AS rater, q.score, q.rubric_answers, q.reason, q.example,
            q.evidence_urls, q.is_reopen, q.supersedes_id, q.change_reason, q.created_at,
            (SELECT json_agg(json_build_object('manager', m.name, 'outcome', v.outcome, 'note', v.note, 'at', v.at))
               FROM quality_rating_reviews v JOIN users m ON m.id = v.manager_id WHERE v.rating_id = q.id) AS manager_reviews
          FROM quality_ratings q JOIN subtasks s ON s.id = q.subtask_id JOIN users e ON e.id = q.employee_id JOIN users rt ON rt.id = q.rater_id
          ORDER BY q.created_at`,
  blockers: `SELECT b.id, s.title AS subtask, rb.name AS raised_by, b.type, b.reason, b.raised_at, b.answered_at, b.outcome, b.resolved_at,
            round(extract(epoch FROM (coalesce(b.resolved_at, now()) - b.raised_at)) / 3600, 1) AS hours_blocked,
            (SELECT json_agg(json_build_object('kind', e.kind, 'by', u.name, 'reason', e.reason, 'at', e.at) ORDER BY e.id)
               FROM blocker_events e JOIN users u ON u.id = e.actor_id WHERE e.blocker_id = b.id) AS events
          FROM blocker_current b JOIN subtasks s ON s.id = b.subtask_id JOIN users rb ON rb.id = b.raised_by ORDER BY b.raised_at`,
  disputes: `SELECT d.id, f.name AS filed_by, d.target_type, d.target_id, c.name AS challenged, rv.name AS reviewer, d.evidence, d.filed_at,
            d.due_at, d.state, d.outcome, d.decision_reason, db.name AS decided_by, d.decided_at, d.correction, esc.name AS escalated_to
          FROM dispute_current d JOIN users f ON f.id = d.filed_by JOIN users c ON c.id = d.challenged_user_id JOIN users rv ON rv.id = d.reviewer_id
          LEFT JOIN users db ON db.id = d.decided_by LEFT JOIN users esc ON esc.id = d.escalated_to ORDER BY d.filed_at`,
  scores: `SELECT s.id, s.period_id, e.name AS employee, s.status, s.total, s.rule_version_label, s.inputs_hash, s.supersedes_id, s.dispute_id,
            s.computed_at, s.breakdown FROM score_snapshots s JOIN users e ON e.id = s.employee_id ORDER BY s.computed_at`,
  audit: `SELECT seq, at, actor_id, db_user, action, entity_type, entity_id, old_value, new_value, reason, prev_hash, hash FROM audit_log ORDER BY seq`,
} as const;

export type RawView = keyof typeof RAW_VIEWS;

async function assertOwnerView(db: Db, viewerId: string) {
  const v = await loadActor(db, viewerId);
  if (!has(v, "owner", "admin")) forbid("Only the owner and admins see the raw view");
}

export async function rawView(db: Db, viewerId: string, view: RawView) {
  if (!(view in RAW_VIEWS)) invalid("Unknown view");
  await assertOwnerView(db, viewerId);
  return many(db, RAW_VIEWS[view]);
}

function cell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = v instanceof Date ? v.toISOString() : typeof v === "object" ? JSON.stringify(v) : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

/** CSV that opens in any spreadsheet app. */
export function toCsv(rows: Record<string, unknown>[]): string {
  if (rows.length === 0) return "";
  const cols = Object.keys(rows[0]!);
  return [cols.join(","), ...rows.map((r) => cols.map((c) => cell(r[c])).join(","))].join("\r\n") + "\r\n";
}

export async function exportView(db: Db, viewerId: string, view: RawView) {
  return toCsv(await rawView(db, viewerId, view));
}

/** The owner can comment or request a review, but never edit records. */
export async function addOwnerNote(pool: pg.Pool, actorId: string, input: { entityType: string; entityId: string; kind: "comment" | "review_request"; body: string }) {
  if (!input.body.trim()) invalid("A note needs some text");
  return withActor(pool, actorId, `owner ${input.kind}`, async (db) => {
    await assertOwnerView(db, actorId);
    await db.query("INSERT INTO owner_notes (author_id, entity_type, entity_id, kind, body) VALUES ($1, $2, $3, $4, $5)",
      [actorId, input.entityType, input.entityId, input.kind, input.body.trim()]);
    return { ok: true };
  });
}
