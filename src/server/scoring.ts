// The score job. It reads the records, runs the engine and stores a snapshot
// with the full breakdown. It connects as pms_scoring, the only database role
// allowed to write scores; there is no other way to set one.
import type pg from "pg";
import { computeScore } from "../scoring/engine";
import type { BlockerInput, CollaborationInput, EffortPoints, ScoreInput, ScoreResult, SubtaskInput } from "../scoring/types";
import { many, one, withActor, type Db } from "./db";
import { forbid, invalid, notFound } from "./errors";
import { notify } from "./notify";
import { has, loadActor } from "./policy";
import { rulesFor } from "./rules";

/**
 * Splits credit along the assignee history. Each reassignment after work
 * started records the share of the whole task done so far, which stays with
 * the person who had it.
 */
export function creditShares(originalAssignee: string, revisions: { assignee: string; creditToPrevious: number | null }[]) {
  const credit = new Map<string, number>();
  let holder = originalAssignee;
  let allocated = 0;
  for (const r of revisions) {
    const share = Math.max(0, (r.creditToPrevious ?? allocated) - allocated);
    credit.set(holder, (credit.get(holder) ?? 0) + share);
    allocated += share;
    holder = r.assignee;
  }
  credit.set(holder, (credit.get(holder) ?? 0) + Math.max(0, 1 - allocated));
  return { credit, finalHolder: holder };
}

const iso = (d: Date | null | undefined) => (d ? d.toISOString() : undefined);

export async function gatherInputs(db: Db, employeeId: string, periodId: string, asOf: Date): Promise<ScoreInput> {
  const period = await one(db, "SELECT * FROM periods WHERE id = $1", [periodId]);
  if (!period) notFound("Period not found");

  // Subtasks this employee ever held whose due date or completion falls in the period.
  const rows = await many(
    db,
    `SELECT sc.*, s.split_from,
       (SELECT e.at FROM status_events e WHERE e.subtask_id = sc.id AND e.to_status = 'done' ORDER BY e.id DESC LIMIT 1) AS done_at
     FROM subtask_current sc JOIN subtasks s ON s.id = sc.id
     WHERE (sc.original_assignee = $1
            OR EXISTS (SELECT 1 FROM subtask_revisions r WHERE r.subtask_id = sc.id AND r.field = 'assignee' AND r.new_value #>> '{}' = $1::text))
       AND (sc.due BETWEEN $2 AND $3
            OR EXISTS (SELECT 1 FROM status_events e WHERE e.subtask_id = sc.id AND e.to_status = 'done' AND e.at::date BETWEEN $2 AND $3))
     ORDER BY sc.assigned_at, sc.id`,
    [employeeId, period!.starts_on, period!.ends_on],
  );

  const subtasks: SubtaskInput[] = [];
  for (const r of rows) {
    const revs = await many(db, "SELECT new_value #>> '{}' AS assignee, credit_to_previous FROM subtask_revisions WHERE subtask_id = $1 AND field = 'assignee' ORDER BY id", [r.id]);
    const { credit, finalHolder } = creditShares(r.original_assignee, revs.map((x) => ({ assignee: x.assignee, creditToPrevious: x.credit_to_previous === null ? null : Number(x.credit_to_previous) })));
    const share = credit.get(employeeId) ?? 0;
    if (share === 0 && finalHolder !== employeeId) continue;

    const blockers = await many(db, "SELECT id, type, raised_at, resolved_at, outcome FROM blocker_current WHERE subtask_id = $1 ORDER BY raised_at", [r.id]);
    const rating = await one(db, "SELECT id, score FROM quality_rating_latest WHERE subtask_id = $1 AND employee_id = $2", [r.id, employeeId]);
    const reopens = await one<{ n: number }>(db, "SELECT count(*)::int AS n FROM quality_ratings WHERE subtask_id = $1 AND employee_id = $2 AND is_reopen", [r.id, employeeId]);
    const isDone = r.status === "done";

    subtasks.push({
      id: r.id,
      title: r.title,
      points: r.points as EffortPoints,
      originalPoints: r.original_points as EffortPoints,
      inScope: r.in_scope,
      status: r.status,
      doneAt: isDone ? iso(r.done_at) : undefined,
      assignedAt: r.assigned_at.toISOString(),
      originalDue: r.original_due,
      revisedDue: r.due,
      creditShare: Math.round(share * 100) / 100,
      deliveredBy: finalHolder === employeeId,
      blockers: blockers.map((b): BlockerInput => ({
        id: b.id, type: b.type, raisedAt: b.raised_at.toISOString(), resolvedAt: iso(b.resolved_at), outcome: b.outcome,
      })),
      reopenCount: reopens!.n,
      qualityRating: rating ? { score: rating.score, ratingId: rating.id } : undefined,
    });
  }

  const collaboration: CollaborationInput[] = (
    await many(db, "SELECT rater_kind, rater_id, score FROM collaboration_ratings WHERE period_id = $1 AND subject_id = $2 ORDER BY id", [periodId, employeeId])
  ).map((c) => ({ raterKind: c.rater_kind, raterId: c.rater_id, score: c.score }));

  return { employeeId, periodId, periodEnd: period!.ends_on, asOf: asOf.toISOString(), subtasks, collaboration };
}

async function storeSnapshot(db: Db, result: ScoreResult, ruleVersionId: string | null, status: "draft" | "locked", extra: { supersedesId?: string; disputeId?: string } = {}) {
  // The breakdown never names peer raters (the engine reports counts only).
  const r = await one<{ id: string }>(
    db,
    `INSERT INTO score_snapshots (period_id, employee_id, rule_version_id, rule_version_label, inputs_hash, breakdown, total, status, supersedes_id, dispute_id)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
    [result.periodId, result.employeeId, ruleVersionId, result.ruleVersion, result.inputsHash, JSON.stringify(result.signals), result.total, status,
      extra.supersedesId ?? null, extra.disputeId ?? null],
  );
  return r!.id;
}

async function employeesToScore(db: Db): Promise<string[]> {
  return (await many<{ user_id: string }>(db, "SELECT DISTINCT user_id FROM user_roles WHERE role = 'employee' AND valid_to IS NULL ORDER BY user_id")).map((r) => r.user_id);
}

/** Nightly: draft scores for everyone in an open period. */
export async function computeDrafts(scoringPool: pg.Pool, systemUserId: string, periodId: string, asOf = new Date()) {
  return withActor(scoringPool, systemUserId, "nightly draft scores", async (db) => {
    const period = await one(db, "SELECT locked_at FROM periods WHERE id = $1", [periodId]);
    if (!period) notFound("Period not found");
    if (period!.locked_at) forbid("This period is locked; scores change only through a dispute");
    const { id: ruleVersionId, rules } = await rulesFor(db, periodId);
    const out: { employeeId: string; total: number | null }[] = [];
    for (const employeeId of await employeesToScore(db)) {
      const result = computeScore(await gatherInputs(db, employeeId, periodId, asOf), rules);
      await storeSnapshot(db, result, ruleVersionId, "draft");
      out.push({ employeeId, total: result.total });
    }
    return out;
  });
}

/**
 * Quarter end: final scores are computed and locked, then the period is
 * locked. After this only a dispute decision can change a score.
 */
export async function lockPeriod(scoringPool: pg.Pool, systemUserId: string, periodId: string, now = new Date()) {
  return withActor(scoringPool, systemUserId, "quarter end lock", async (db) => {
    const period = await one(db, "SELECT * FROM periods WHERE id = $1", [periodId]);
    if (!period) notFound("Period not found");
    if (period!.locked_at) invalid("This period is already locked");
    if (now.toISOString().slice(0, 10) <= period!.ends_on) invalid("A period can be locked only after it ends");
    const { id: ruleVersionId, rules } = await rulesFor(db, periodId);
    const asOf = new Date(`${period!.ends_on}T23:59:59.999Z`);
    let count = 0;
    for (const employeeId of await employeesToScore(db)) {
      const result = computeScore(await gatherInputs(db, employeeId, periodId, asOf), rules);
      const id = await storeSnapshot(db, result, ruleVersionId, "locked");
      await notify(db, [employeeId], "score_published", "score_snapshot", id, `Your ${periodId} score is published`);
      count += 1;
    }
    await db.query("UPDATE periods SET locked_at = now() WHERE id = $1", [periodId]);
    return { locked: count };
  });
}

/** HR opens a quarter. */
export async function openPeriod(pool: pg.Pool, actorId: string, input: { id: string; startsOn: string; endsOn: string }) {
  if (!/^\d{4}-Q[1-4]$/.test(input.id)) invalid("Period ids look like 2026-Q4");
  if (input.endsOn <= input.startsOn) invalid("A period must end after it starts");
  return withActor(pool, actorId, "open period", async (db) => {
    const actor = await loadActor(db, actorId);
    if (!has(actor, "hr", "head_of_hr", "admin")) forbid("Only HR or an admin opens a period");
    await db.query("INSERT INTO periods (id, starts_on, ends_on) VALUES ($1, $2, $3)", [input.id, input.startsOn, input.endsOn]);
    return { ok: true };
  });
}

/**
 * The score with its breakdown, for the employee themself, their lead and
 * manager, HR, admins and the owner.
 */
export async function scoreBreakdown(db: Db, viewerId: string, employeeId: string, periodId: string) {
  const viewer = await loadActor(db, viewerId);
  const related = await one(db,
    `SELECT 1 FROM teams t JOIN team_members m ON m.team_id = t.id
     WHERE m.user_id = $2 AND (t.lead_id = $1 OR t.manager_id = $1)`, [viewerId, employeeId]);
  if (viewerId !== employeeId && !related && !has(viewer, "hr", "head_of_hr", "admin", "owner")) forbid("You cannot see this score");
  const snap = await one(db, "SELECT * FROM score_current WHERE period_id = $1 AND employee_id = $2", [periodId, employeeId]);
  if (!snap) notFound("No score calculated yet for this period");
  return {
    snapshotId: snap!.id,
    status: snap!.status,
    total: snap!.total === null ? null : Number(snap!.total),
    ruleVersion: snap!.rule_version_label,
    computedAt: snap!.computed_at,
    signals: snap!.breakdown,
    inputsHash: snap!.inputs_hash,
  };
}
