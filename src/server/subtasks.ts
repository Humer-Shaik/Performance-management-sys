// Subtasks: the lead manages the work, the system keeps every original value.
// Changes are revision rows; changes that need approval go through
// change_requests and are applied only when approved (see requests.ts).
import type pg from "pg";
import { EFFORT_SCALE, type EffortPoints, type SubtaskStatus } from "../scoring/types";
import { many, one, withActor, type Db } from "./db";
import { forbid, invalid, notFound, requireReason } from "./errors";
import { notify } from "./notify";
import { assertLeadOf, loadActor } from "./policy";
import { periodOf, rulesFor } from "./rules";

const LEVELS: EffortPoints[] = Object.values(EFFORT_SCALE);
const levelGap = (a: EffortPoints, b: EffortPoints) => Math.abs(LEVELS.indexOf(a) - LEVELS.indexOf(b));
const isPoints = (n: number): n is EffortPoints => (LEVELS as number[]).includes(n);
const todayStr = () => new Date().toISOString().slice(0, 10);
const daysBetween = (from: string, to: string) => Math.round((Date.parse(to) - Date.parse(from)) / 86_400_000);

export interface SubtaskContext {
  id: string;
  goal_id: string;
  title: string;
  points: EffortPoints;
  original_points: EffortPoints;
  due: string;
  original_due: string;
  assignee: string;
  status: SubtaskStatus;
  in_scope: boolean;
  review_required: boolean;
  team_id: string;
  team_deadline: string;
  manager_id: string;
  lead_id: string;
  started: boolean;
}

export async function subtaskContext(db: Db, subtaskId: string): Promise<SubtaskContext> {
  const row = await one<SubtaskContext>(
    db,
    `SELECT sc.id, sc.goal_id, sc.title, sc.points, sc.original_points, sc.due, sc.original_due, sc.assignee,
            sc.status, sc.in_scope, sc.review_required,
            g.current_team_id AS team_id, g.current_deadline AS team_deadline, t.manager_id, t.lead_id,
            EXISTS (SELECT 1 FROM status_events e WHERE e.subtask_id = sc.id AND e.to_status = 'in_progress') AS started
     FROM subtask_current sc
     JOIN goal_current g ON g.id = sc.goal_id
     JOIN teams t ON t.id = g.current_team_id
     WHERE sc.id = $1`,
    [subtaskId],
  );
  if (!row) notFound("Subtask not found");
  return row!;
}

async function assertTeamMember(db: Db, teamId: string, userId: string) {
  const m = await one(db, "SELECT 1 FROM team_members WHERE team_id = $1 AND user_id = $2 AND valid_to IS NULL", [teamId, userId]);
  if (!m) invalid("The employee is not on this team");
}

async function revise(db: Db, subtaskId: string, field: "points" | "due" | "assignee" | "scope", oldValue: unknown, newValue: unknown,
  reason: string, actorId: string, extra: { requestId?: string; creditToPrevious?: number } = {}) {
  await db.query(
    `INSERT INTO subtask_revisions (subtask_id, field, old_value, new_value, reason, changed_by, request_id, credit_to_previous)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [subtaskId, field, JSON.stringify(oldValue), JSON.stringify(newValue), reason, actorId, extra.requestId ?? null, extra.creditToPrevious ?? null],
  );
}

async function requestChange(db: Db, input: { subtaskId: string; field: "points" | "deadline" | "assignee"; oldValue: unknown; newValue: unknown;
  reason: string; requestedBy: string; approverId: string; body: string }) {
  const req = await one<{ id: string }>(
    db,
    `INSERT INTO change_requests (target_type, target_id, field, old_value, new_value, reason, requested_by, approver_id)
     VALUES ('subtask', $1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [input.subtaskId, input.field, JSON.stringify(input.oldValue), JSON.stringify(input.newValue), input.reason, input.requestedBy, input.approverId],
  );
  await notify(db, [input.approverId], "approval_needed", "change_request", req!.id, input.body);
  return req!.id;
}

/** Warnings shown to the lead after planning; they do not block the action. */
async function planningWarnings(db: Db, goalId: string, teamDeadline: string): Promise<string[]> {
  const warnings: string[] = [];
  const tasks = await many<{ due: string }>(db, "SELECT due FROM subtask_current WHERE goal_id = $1 AND in_scope", [goalId]);
  if (tasks.length >= 2 && tasks.every((t) => t.due === teamDeadline)) {
    warnings.push("Every subtask is due on the team's last day");
  }
  return warnings;
}

export interface CreateSubtaskInput {
  goalId: string;
  title: string;
  acceptanceCriteria: string;
  points: number;
  /** The reference level for this kind of work; defaults to points. */
  referencePoints?: number;
  overrideReason?: string;
  due: string;
  assigneeId: string;
  reviewRequired?: boolean;
  shortLeadReason?: string;
  splitFrom?: string;
}

async function insertSubtask(db: Db, actorId: string, teamId: string, teamDeadline: string, input: CreateSubtaskInput) {
  if (!input.title.trim()) invalid("A subtask needs a title");
  if (!input.acceptanceCriteria.trim()) invalid("A subtask needs acceptance criteria");
  if (!isPoints(input.points)) invalid("Effort must be 1, 2, 3, 5 or 8 points");
  const reference = input.referencePoints ?? input.points;
  if (!isPoints(reference)) invalid("Reference effort must be 1, 2, 3, 5 or 8 points");
  if (reference !== input.points && !input.overrideReason?.trim()) invalid("Overriding the reference effort needs a reason");
  if (input.due > teamDeadline) invalid(`The due date must be on or before the team deadline (${teamDeadline})`);
  if (input.due < todayStr()) invalid("The due date cannot be in the past");
  await assertTeamMember(db, teamId, input.assigneeId);

  const { rules } = await rulesFor(db, periodOf(new Date()));
  const minDays = rules.leadTimeDays[input.points as EffortPoints];
  const leadDays = daysBetween(todayStr(), input.due);
  const shortLead = leadDays < minDays;
  if (shortLead && !input.shortLeadReason?.trim()) {
    invalid(`A ${input.points}-point task needs at least ${minDays} days; give a reason for a shorter deadline`);
  }

  const row = await one<{ id: string }>(
    db,
    `INSERT INTO subtasks (goal_id, title, acceptance_criteria, review_required, original_points, reference_points, override_reason,
                           original_due, original_assignee, short_lead_reason, created_by, split_from)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12) RETURNING id`,
    [input.goalId, input.title.trim(), input.acceptanceCriteria.trim(), input.reviewRequired ?? true, input.points, reference,
      input.overrideReason?.trim() || null, input.due, input.assigneeId, shortLead ? input.shortLeadReason!.trim() : null, actorId,
      input.splitFrom ?? null],
  );
  await db.query("INSERT INTO status_events (subtask_id, from_status, to_status, actor_id) VALUES ($1, NULL, 'not_started', $2)", [row!.id, actorId]);
  await notify(db, [input.assigneeId], "subtask_assigned", "subtask", row!.id, `New subtask: ${input.title}`);
  return { subtaskId: row!.id, shortLeadFlagged: shortLead };
}

export async function createSubtask(pool: pg.Pool, actorId: string, input: CreateSubtaskInput) {
  return withActor(pool, actorId, "create subtask", async (db) => {
    const actor = await loadActor(db, actorId);
    const goal = await one(db, "SELECT current_team_id, current_deadline FROM goal_current WHERE id = $1", [input.goalId]);
    if (!goal) notFound("Goal not found");
    assertLeadOf(actor, goal!.current_team_id);
    const out = await insertSubtask(db, actorId, goal!.current_team_id, goal!.current_deadline, input);
    return { ...out, warnings: await planningWarnings(db, input.goalId, goal!.current_deadline) };
  });
}

/** Changing effort by more than one level after work starts needs manager approval. */
export async function changeEstimate(pool: pg.Pool, actorId: string, input: { subtaskId: string; points: number; reason: string }) {
  const reason = requireReason(input.reason, "Changing an estimate");
  return withActor(pool, actorId, reason, async (db) => {
    const actor = await loadActor(db, actorId);
    const s = await subtaskContext(db, input.subtaskId);
    assertLeadOf(actor, s.team_id);
    if (!isPoints(input.points)) invalid("Effort must be 1, 2, 3, 5 or 8 points");
    if (input.points === s.points) invalid("The estimate is unchanged");
    if (s.status === "done") invalid("A done subtask's estimate cannot change; the employee can dispute it instead");
    if (s.started && levelGap(s.points, input.points as EffortPoints) > 1) {
      const requestId = await requestChange(db, { subtaskId: s.id, field: "points", oldValue: s.points, newValue: input.points, reason,
        requestedBy: actorId, approverId: s.manager_id, body: `Estimate change for "${s.title}" needs your approval` });
      return { applied: false, requestId };
    }
    await revise(db, s.id, "points", s.points, input.points, reason, actorId);
    await notify(db, [s.assignee], "estimate_changed", "subtask", s.id, `Estimate for "${s.title}" changed from ${s.points} to ${input.points}: ${reason}`);
    return { applied: true };
  });
}

/** The lead can extend a subtask deadline directly, within the team deadline. */
export async function extendDeadline(pool: pg.Pool, actorId: string, input: { subtaskId: string; due: string; reason: string }) {
  const reason = requireReason(input.reason, "Extending a deadline");
  return withActor(pool, actorId, reason, async (db) => {
    const actor = await loadActor(db, actorId);
    const s = await subtaskContext(db, input.subtaskId);
    assertLeadOf(actor, s.team_id);
    if (input.due <= s.due) invalid("An extension must move the due date later; earlier dates need a new subtask");
    if (input.due > s.team_deadline) invalid(`The due date must be on or before the team deadline (${s.team_deadline})`);
    await revise(db, s.id, "due", s.due, input.due, reason, actorId);
    await notify(db, [s.assignee], "deadline_extended", "subtask", s.id, `"${s.title}" is now due ${input.due}`);
    return { applied: true };
  });
}

/** The employee asks the lead for more time; if refused they can escalate to the manager. */
export async function requestMoreTime(pool: pg.Pool, actorId: string, input: { subtaskId: string; due: string; reason: string }) {
  const reason = requireReason(input.reason, "A request for more time");
  return withActor(pool, actorId, reason, async (db) => {
    const s = await subtaskContext(db, input.subtaskId);
    if (s.assignee !== actorId) forbid("Only the assigned employee can ask for more time");
    if (input.due <= s.due) invalid("The new date must be later than the current due date");
    const requestId = await requestChange(db, { subtaskId: s.id, field: "deadline", oldValue: s.due, newValue: input.due, reason,
      requestedBy: actorId, approverId: s.lead_id, body: `More time requested for "${s.title}"` });
    return { requestId };
  });
}

/** Before work starts the lead reassigns directly; after, the manager approves and the first employee keeps credit. */
export async function reassign(pool: pg.Pool, actorId: string, input: { subtaskId: string; assigneeId: string; reason: string; creditToPrevious?: number }) {
  const reason = requireReason(input.reason, "Reassigning a subtask");
  return withActor(pool, actorId, reason, async (db) => {
    const actor = await loadActor(db, actorId);
    const s = await subtaskContext(db, input.subtaskId);
    assertLeadOf(actor, s.team_id);
    if (input.assigneeId === s.assignee) invalid("That employee already has this subtask");
    if (s.status === "done") invalid("A done subtask cannot be reassigned");
    await assertTeamMember(db, s.team_id, input.assigneeId);
    if (s.started) {
      const credit = input.creditToPrevious;
      if (credit === undefined || credit < 0 || credit > 1) invalid("Give the share of work already done (0 to 1) so it stays credited to the first employee");
      const requestId = await requestChange(db, { subtaskId: s.id, field: "assignee", oldValue: s.assignee,
        newValue: { assignee: input.assigneeId, creditToPrevious: credit }, reason, requestedBy: actorId, approverId: s.manager_id,
        body: `Reassignment of "${s.title}" after work started needs your approval` });
      return { applied: false, requestId };
    }
    await revise(db, s.id, "assignee", s.assignee, input.assigneeId, reason, actorId);
    await notify(db, [s.assignee, input.assigneeId], "reassigned", "subtask", s.id, `"${s.title}" was reassigned: ${reason}`);
    return { applied: true };
  });
}

/** Split keeps the original as out-of-scope history and links the parts to it. */
export async function splitSubtask(pool: pg.Pool, actorId: string, input: { subtaskId: string; reason: string; parts: Omit<CreateSubtaskInput, "goalId" | "splitFrom">[] }) {
  const reason = requireReason(input.reason, "Splitting a subtask");
  return withActor(pool, actorId, reason, async (db) => {
    const actor = await loadActor(db, actorId);
    const s = await subtaskContext(db, input.subtaskId);
    assertLeadOf(actor, s.team_id);
    if (s.status === "done") invalid("A done subtask cannot be split");
    if (input.parts.length < 2) invalid("A split needs at least two parts");
    await revise(db, s.id, "scope", true, false, `split: ${reason}`, actorId);
    const parts = [];
    for (const p of input.parts) parts.push(await insertSubtask(db, actorId, s.team_id, s.team_deadline, { ...p, goalId: s.goal_id, splitFrom: s.id }));
    return { parts: parts.map((p) => p.subtaskId) };
  });
}

/** Merge marks the other subtasks as merged into one; their history stays. */
export async function mergeSubtasks(pool: pg.Pool, actorId: string, input: { intoId: string; fromIds: string[]; reason: string }) {
  const reason = requireReason(input.reason, "Merging subtasks");
  return withActor(pool, actorId, reason, async (db) => {
    const actor = await loadActor(db, actorId);
    const into = await subtaskContext(db, input.intoId);
    assertLeadOf(actor, into.team_id);
    if (input.fromIds.length === 0) invalid("Name at least one subtask to merge");
    for (const id of input.fromIds) {
      const from = await subtaskContext(db, id);
      if (from.goal_id !== into.goal_id) invalid("Only subtasks of the same goal can be merged");
      if (from.id === into.id) invalid("A subtask cannot be merged into itself");
      if (from.status === "done") invalid("A done subtask cannot be merged");
      await db.query("INSERT INTO subtask_merges (merged_into, merged_from, merged_by, reason) VALUES ($1, $2, $3, $4)", [into.id, from.id, actorId, reason]);
    }
    return { merged: input.fromIds.length };
  });
}

/**
 * Status moves. Blocked is entered and left only through blockers (blockers.ts).
 * A reopen after Done counts against the quality of whoever delivered it.
 */
export async function setStatus(pool: pg.Pool, actorId: string, input: { subtaskId: string; to: SubtaskStatus; note?: string }) {
  return withActor(pool, actorId, input.note?.trim() || `status: ${input.to}`, async (db) => {
    const s = await subtaskContext(db, input.subtaskId);
    const isAssignee = s.assignee === actorId;
    const isLead = s.lead_id === actorId;
    const from = s.status;
    const to = input.to;

    const allowed =
      (isAssignee && from === "not_started" && to === "in_progress") ||
      (isAssignee && from === "in_progress" && to === "in_review" && s.review_required) ||
      (isAssignee && from === "in_progress" && to === "done" && !s.review_required) ||
      (isLead && from === "in_review" && (to === "done" || to === "in_progress")) ||
      (isLead && from === "done" && to === "in_progress");
    if (to === "blocked" || from === "blocked") invalid("Use raise or resolve blocker to enter or leave Blocked");
    if (!allowed) forbid(`You cannot move this subtask from ${from} to ${to}`);

    if (from === "done" && to === "in_progress") {
      const note = requireReason(input.note, "Reopening a done subtask");
      await db.query(
        `INSERT INTO quality_ratings (subtask_id, employee_id, rater_id, score, reason, is_reopen)
         VALUES ($1, $2, $3, 1, $4, true)`,
        [s.id, s.assignee, actorId, `reopened after Done: ${note}`],
      );
      await notify(db, [s.assignee], "reopened", "subtask", s.id, `"${s.title}" was reopened: ${note}`);
    }
    await db.query("INSERT INTO status_events (subtask_id, from_status, to_status, actor_id, note) VALUES ($1, $2, $3, $4, $5)",
      [s.id, from, to, actorId, input.note?.trim() || null]);
    if (to === "in_review") await notify(db, [s.lead_id], "review_needed", "subtask", s.id, `"${s.title}" is ready for review`);
    return { from, to };
  });
}

export async function updateProgress(pool: pg.Pool, actorId: string, input: { subtaskId: string; body: string }) {
  if (!input.body.trim()) invalid("A progress update needs some text");
  return withActor(pool, actorId, "progress update", async (db) => {
    const s = await subtaskContext(db, input.subtaskId);
    if (s.assignee !== actorId) forbid("Only the assigned employee can post progress");
    await db.query("INSERT INTO progress_updates (subtask_id, author_id, body) VALUES ($1, $2, $3)", [s.id, actorId, input.body.trim()]);
    return { ok: true };
  });
}
