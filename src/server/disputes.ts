// Disputes: an employee can challenge anything that feeds their score. The
// original value stays in force while the dispute is open, a reviewer who did
// not make the decision handles it, and a decision that changes a locked
// score writes a new snapshot that keeps the old one.
import type pg from "pg";
import { computeScore } from "../scoring/engine";
import { many, one, withActor, type Db } from "./db";
import { forbid, invalid, notFound, requireReason } from "./errors";
import { notify } from "./notify";
import { checkEvidence, type QualityRatingInput } from "./ratings";
import { periodOf, rulesFor } from "./rules";
import { gatherInputs } from "./scoring";

export type DisputeTarget = "estimate" | "deadline" | "quality_rating" | "blocker_decision" | "review_comment" | "score";

interface ResolvedTarget {
  challengedUserId: string;
  decisionMadeAt: Date;
  periodDay: string; // a date inside the period the target affects
  periodId?: string;
}

/** Adds working days (Monday to Friday). */
export function addWorkingDays(from: Date, days: number): Date {
  const d = new Date(from);
  let left = days;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) left -= 1;
  }
  return d;
}

const day = (d: Date) => d.toISOString().slice(0, 10);

async function heldBy(db: Db, subtaskId: string, employeeId: string) {
  const r = await one(db,
    `SELECT 1 FROM subtask_current sc WHERE sc.id = $1 AND (sc.original_assignee = $2 OR sc.assignee = $2
       OR EXISTS (SELECT 1 FROM subtask_revisions r WHERE r.subtask_id = sc.id AND r.field = 'assignee' AND r.new_value #>> '{}' = $2::text))`,
    [subtaskId, employeeId]);
  if (!r) forbid("You can only dispute decisions about your own work");
}

/** Finds who made the challenged decision and when, from the records. */
async function resolveTarget(db: Db, employeeId: string, type: DisputeTarget, targetId: string): Promise<ResolvedTarget> {
  switch (type) {
    case "estimate":
    case "deadline": {
      await heldBy(db, targetId, employeeId);
      const field = type === "estimate" ? "points" : "due";
      const s = await one(db, "SELECT created_by, assigned_at FROM subtasks WHERE id = $1", [targetId]);
      const due = await one(db, "SELECT due FROM subtask_current WHERE id = $1", [targetId]);
      const rev = await one(db, "SELECT changed_by, changed_at FROM subtask_revisions WHERE subtask_id = $1 AND field = $2 ORDER BY id DESC LIMIT 1", [targetId, field]);
      return { challengedUserId: rev?.changed_by ?? s!.created_by, decisionMadeAt: rev?.changed_at ?? s!.assigned_at, periodDay: due!.due };
    }
    case "quality_rating": {
      const r = await one(db, "SELECT * FROM quality_ratings WHERE id = $1", [targetId]);
      if (!r) notFound("Rating not found");
      if (r!.employee_id !== employeeId) forbid("You can only dispute your own ratings");
      const done = await one(db, "SELECT at FROM status_events WHERE subtask_id = $1 AND to_status = 'done' ORDER BY id DESC LIMIT 1", [r!.subtask_id]);
      return { challengedUserId: r!.rater_id, decisionMadeAt: r!.created_at, periodDay: day(done?.at ?? r!.created_at) };
    }
    case "blocker_decision": {
      const b = await one(db, "SELECT * FROM blocker_current WHERE id = $1", [targetId]);
      if (!b) notFound("Blocker not found");
      if (b!.raised_by !== employeeId) forbid("You can only dispute decisions on blockers you raised");
      const e = await one(db, "SELECT actor_id, at FROM blocker_events WHERE blocker_id = $1 AND kind IN ('disputed', 'rejected') ORDER BY id DESC LIMIT 1", [targetId]);
      if (!e) invalid("Nobody has disputed or rejected this blocker");
      const due = await one(db, "SELECT due FROM subtask_current WHERE id = $1", [b!.subtask_id]);
      return { challengedUserId: e!.actor_id, decisionMadeAt: e!.at, periodDay: due!.due };
    }
    case "score": {
      const snap = await one(db, "SELECT * FROM score_current WHERE id = $1", [targetId]);
      if (!snap) notFound("Score not found, or it has been revised since");
      if (snap!.employee_id !== employeeId) forbid("You can only dispute your own score");
      if (snap!.status === "draft") invalid("Draft scores change nightly; dispute the published score");
      const writer = await one(db, "SELECT actor_id FROM audit_log WHERE entity_type = 'score_snapshots' AND entity_id = $1 ORDER BY seq LIMIT 1", [targetId]);
      return { challengedUserId: writer!.actor_id, decisionMadeAt: snap!.computed_at, periodDay: "", periodId: snap!.period_id };
    }
    case "review_comment":
      return invalid("Quarterly review comments are not part of version one yet");
  }
}

async function hrReviewer(db: Db, exclude: string[]): Promise<string | undefined> {
  const r = await one<{ user_id: string }>(db,
    `SELECT user_id FROM user_roles WHERE role IN ('hr', 'head_of_hr') AND valid_to IS NULL AND NOT (user_id = ANY($1::uuid[]))
     ORDER BY CASE role WHEN 'hr' THEN 0 ELSE 1 END, valid_from LIMIT 1`, [exclude]);
  return r?.user_id;
}

/** The next-level manager of whoever made the decision, else HR. Never the challenged person or the filer. */
async function pickReviewer(db: Db, challenged: string, filer: string): Promise<string> {
  const exclude = [challenged, filer];
  const viaTeam = await one<{ manager_id: string }>(db, "SELECT manager_id FROM teams WHERE lead_id = $1 ORDER BY created_at LIMIT 1", [challenged]);
  const viaUser = await one<{ manager_id: string }>(db, "SELECT manager_id FROM users WHERE id = $1", [challenged]);
  for (const candidate of [viaTeam?.manager_id, viaUser?.manager_id]) {
    if (candidate && !exclude.includes(candidate)) return candidate;
  }
  const hr = await hrReviewer(db, exclude);
  if (!hr) invalid("No eligible reviewer: add an HR user");
  return hr!;
}

export async function fileDispute(pool: pg.Pool, actorId: string, input: { targetType: DisputeTarget; targetId: string; evidence: string }, now = new Date()) {
  const evidence = requireReason(input.evidence, "A dispute needs evidence and");
  return withActor(pool, actorId, `dispute: ${input.targetType}`, async (db) => {
    const t = await resolveTarget(db, actorId, input.targetType, input.targetId);
    const { rules } = await rulesFor(db, periodOf(now));
    const deadline = new Date(t.decisionMadeAt.getTime() + rules.disputes.fileWithinDays * 86_400_000);
    if (now > deadline) invalid(`Disputes must be filed within ${rules.disputes.fileWithinDays} days of the decision or of the score being published`);
    const open = await one(db, "SELECT 1 FROM dispute_current WHERE filed_by = $1 AND target_type = $2 AND target_id = $3 AND state <> 'decided'",
      [actorId, input.targetType, input.targetId]);
    if (open) invalid("You already have an open dispute on this");

    const periodId = t.periodId ?? (await one(db, "SELECT id FROM periods WHERE $1::date BETWEEN starts_on AND ends_on", [t.periodDay]))?.id ?? null;
    const reviewer = await pickReviewer(db, t.challengedUserId, actorId);
    const due = addWorkingDays(now, rules.disputes.decideWithinWorkingDays);
    const d = await one<{ id: string }>(db,
      `INSERT INTO disputes (filed_by, employee_id, target_type, target_id, challenged_user_id, evidence, decision_made_at, reviewer_id, due_at, period_id)
       VALUES ($1, $1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [actorId, input.targetType, input.targetId, t.challengedUserId, evidence, t.decisionMadeAt, reviewer, due, periodId]);
    await notify(db, [reviewer], "dispute_assigned", "dispute", d!.id, `A ${input.targetType.replace("_", " ")} dispute needs your decision by ${day(due)}`);
    await notify(db, [t.challengedUserId], "dispute_filed", "dispute", d!.id, `One of your decisions was disputed (${input.targetType.replace("_", " ")})`);
    return { disputeId: d!.id, reviewerId: reviewer, dueAt: due };
  });
}

export type Correction =
  | { kind: "quality_rating"; rating: QualityRatingInput }
  | { kind: "estimate"; points: number }
  | { kind: "deadline"; due: string }
  | { kind: "blocker_decision" }
  | { kind: "score" };

export async function decideDispute(pool: pg.Pool, actorId: string, input: {
  disputeId: string; outcome: "upheld" | "partly_upheld" | "rejected"; reason: string; correction?: Correction;
}) {
  const reason = requireReason(input.reason, "A dispute decision");
  if (input.outcome !== "rejected" && input.correction && input.correction.kind === "quality_rating") checkEvidence(input.correction.rating);
  return withActor(pool, actorId, reason, async (db) => {
    const d = await one(db, "SELECT * FROM dispute_current WHERE id = $1", [input.disputeId]);
    if (!d) notFound("Dispute not found");
    if (d!.state === "decided") invalid("This dispute is already decided");
    if (actorId === d!.challenged_user_id) forbid("The person whose decision is challenged cannot decide the dispute");
    if (actorId === d!.filed_by) forbid("You cannot decide your own dispute");
    if (actorId !== d!.reviewer_id && actorId !== d!.escalated_to) forbid("This dispute is assigned to someone else");
    const c = input.outcome === "rejected" ? undefined : input.correction;
    if (c && c.kind !== d!.target_type) invalid(`The correction must be for the disputed ${d!.target_type.replace("_", " ")}`);

    await db.query("INSERT INTO dispute_decisions (dispute_id, outcome, reason, decided_by, correction) VALUES ($1, $2, $3, $4, $5)",
      [d!.id, input.outcome, reason, actorId, c ? JSON.stringify(c) : null]);
    const why = `dispute decision: ${reason}`;

    if (c?.kind === "quality_rating") {
      const old = await one(db, "SELECT * FROM quality_ratings WHERE id = $1", [d!.target_id]);
      const latest = await one(db, "SELECT * FROM quality_rating_latest WHERE subtask_id = $1 AND employee_id = $2", [old!.subtask_id, old!.employee_id]);
      // The rater stays the lead who rated; the change is recorded as made by the dispute.
      await db.query(
        `INSERT INTO quality_ratings (subtask_id, employee_id, rater_id, score, rubric_answers, reason, example, evidence_urls, supersedes_id, change_reason)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [old!.subtask_id, old!.employee_id, (latest ?? old)!.rater_id, c.rating.score, c.rating.rubricAnswers ?? {}, c.rating.reason ?? null,
          c.rating.example ?? null, c.rating.evidenceUrls ?? [], (latest ?? old)!.id, why]);
    } else if (c?.kind === "estimate" || c?.kind === "deadline") {
      const field = c.kind === "estimate" ? "points" : "due";
      const cur = await one(db, "SELECT points, due FROM subtask_current WHERE id = $1", [d!.target_id]);
      const value = c.kind === "estimate" ? c.points : c.due;
      if (c.kind === "estimate" && ![1, 2, 3, 5, 8].includes(c.points)) invalid("Effort must be 1, 2, 3, 5 or 8 points");
      await db.query("INSERT INTO subtask_revisions (subtask_id, field, old_value, new_value, reason, changed_by) VALUES ($1, $2, $3, $4, $5, $6)",
        [d!.target_id, field, JSON.stringify(field === "points" ? cur!.points : cur!.due), JSON.stringify(value), why, actorId]);
    } else if (c?.kind === "blocker_decision") {
      await db.query("INSERT INTO blocker_events (blocker_id, kind, actor_id, reason) VALUES ($1, 'upheld', $2, $3)", [d!.target_id, actorId, why]);
    }

    await notify(db, [d!.filed_by, d!.challenged_user_id], "dispute_decided", "dispute", d!.id, `Dispute ${input.outcome.replace("_", " ")}: ${reason}`);
    const locked = d!.period_id ? (await one(db, "SELECT locked_at FROM periods WHERE id = $1", [d!.period_id]))?.locked_at : null;
    return { outcome: input.outcome, rescoreNeeded: input.outcome !== "rejected" && !!locked };
  });
}

/**
 * Job: rewrites a locked score after a dispute was upheld. The new snapshot
 * supersedes the old one; both are kept. Runs as pms_scoring.
 */
export async function rescoreAfterDisputes(scoringPool: pg.Pool, systemUserId: string) {
  return withActor(scoringPool, systemUserId, "rescore after dispute", async (db) => {
    const pending = await many(db,
      `SELECT d.* FROM dispute_current d JOIN periods p ON p.id = d.period_id
       WHERE d.outcome IN ('upheld', 'partly_upheld') AND p.locked_at IS NOT NULL
         -- decisions made before the lock are already in the locked score
         AND d.decided_at > p.locked_at
         AND NOT EXISTS (SELECT 1 FROM score_snapshots s WHERE s.dispute_id = d.id)
       ORDER BY d.decided_at`);
    const out = [];
    for (const d of pending) {
      const period = await one(db, "SELECT * FROM periods WHERE id = $1", [d.period_id]);
      const current = await one(db, "SELECT id, total FROM score_current WHERE period_id = $1 AND employee_id = $2", [d.period_id, d.employee_id]);
      if (!current) continue;
      const { id: ruleVersionId, rules } = await rulesFor(db, d.period_id);
      const result = computeScore(await gatherInputs(db, d.employee_id, d.period_id, new Date(`${period!.ends_on}T23:59:59.999Z`)), rules);
      const snap = await one<{ id: string }>(db,
        `INSERT INTO score_snapshots (period_id, employee_id, rule_version_id, rule_version_label, inputs_hash, breakdown, total, status, supersedes_id, dispute_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, 'revised_by_dispute', $8, $9) RETURNING id`,
        [d.period_id, d.employee_id, ruleVersionId, result.ruleVersion, result.inputsHash, JSON.stringify(result.signals), result.total, current.id, d.id]);
      await notify(db, [d.employee_id], "score_revised", "score_snapshot", snap!.id,
        `Your ${d.period_id} score was revised after a dispute: ${current.total ?? "n/a"} to ${result.total ?? "n/a"}`);
      out.push({ disputeId: d.id, before: current.total === null ? null : Number(current.total), after: result.total });
    }
    return out;
  });
}

/** Job: disputes not decided in time escalate to the head of HR. */
export async function escalateOverdueDisputes(pool: pg.Pool, systemUserId: string, now = new Date()) {
  return withActor(pool, systemUserId, "dispute overdue", async (db) => {
    const overdue = await many(db, "SELECT * FROM dispute_current WHERE state = 'open' AND due_at < $1", [now.toISOString()]);
    let count = 0;
    for (const d of overdue) {
      const head = await one<{ user_id: string }>(db,
        "SELECT user_id FROM user_roles WHERE role = 'head_of_hr' AND valid_to IS NULL AND NOT (user_id = ANY($1::uuid[])) LIMIT 1",
        [[d.challenged_user_id, d.filed_by]]);
      if (!head) continue;
      await db.query("INSERT INTO dispute_escalations (dispute_id, escalated_to, reason) VALUES ($1, $2, 'not decided in time')", [d.id, head.user_id]);
      await notify(db, [head.user_id], "dispute_escalated", "dispute", d.id, "An overdue dispute was escalated to you");
      count += 1;
    }
    return { escalated: count };
  });
}
