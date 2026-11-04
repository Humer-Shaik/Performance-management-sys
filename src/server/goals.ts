// Goals: created by management, assigned to a team, transferred without
// losing history. A late goal moved to another team stays late for the team
// that had it (overdue_at_transfer is frozen on the closed assignment).
import type pg from "pg";
import { goalProgress } from "../domain/progress";
import { many, one, withActor, type Db } from "./db";
import { invalid, notFound, requireReason } from "./errors";
import { notify, ownerIds } from "./notify";
import { assertCanCreateGoal, assertLeadOf, assertManagerOf, loadActor } from "./policy";

export interface CreateGoalInput {
  title: string;
  description?: string;
  teamId: string;
  deadline: string; // YYYY-MM-DD
  priority?: "low" | "normal" | "high";
}

const today = () => new Date().toISOString().slice(0, 10);

export async function createGoal(pool: pg.Pool, actorId: string, input: CreateGoalInput) {
  return withActor(pool, actorId, "create goal", async (db) => {
    const actor = await loadActor(db, actorId);
    assertCanCreateGoal(actor);
    if (!input.title.trim()) invalid("A goal needs a title");
    if (input.deadline <= today()) invalid("The deadline must be in the future");
    const team = await one(db, "SELECT id, lead_id FROM teams WHERE id = $1", [input.teamId]);
    if (!team) notFound("Team not found");

    const goal = await one<{ id: string }>(
      db,
      `INSERT INTO goals (title, description, priority, created_by, original_team_id, original_deadline)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [input.title.trim(), input.description ?? "", input.priority ?? "normal", actorId, input.teamId, input.deadline],
    );
    await db.query(
      "INSERT INTO goal_assignments (goal_id, team_id, deadline, assigned_by, reason) VALUES ($1, $2, $3, $4, 'goal created')",
      [goal!.id, input.teamId, input.deadline, actorId],
    );
    await notify(db, [team!.lead_id], "goal_assigned", "goal", goal!.id, `New goal for your team: ${input.title}`);
    return { goalId: goal!.id };
  });
}

export async function goalState(db: Db, goalId: string) {
  const goal = await one(db, "SELECT * FROM goal_current WHERE id = $1", [goalId]);
  if (!goal) notFound("Goal not found");
  const tasks = await many(db, "SELECT points, status, in_scope FROM subtask_current WHERE goal_id = $1", [goalId]);
  const progress = goalProgress(tasks.map((t) => ({ points: t.points, status: t.status, inScope: t.in_scope })));
  const overdue = !progress.complete && Date.now() > Date.parse(`${goal!.current_deadline}T23:59:59.999Z`);
  return { goal: goal!, progress, overdue };
}

/** Manager moves a goal to another team. History is frozen on the old assignment. */
export async function transferGoal(pool: pg.Pool, actorId: string, input: { goalId: string; toTeamId: string; reason: string; newDeadline?: string }) {
  const reason = requireReason(input.reason, "Moving a goal");
  return withActor(pool, actorId, reason, async (db) => {
    const actor = await loadActor(db, actorId);
    const { goal, progress, overdue } = await goalState(db, input.goalId);
    assertManagerOf(actor, goal.current_team_id);
    if (goal.current_team_id === input.toTeamId) invalid("The goal is already with that team");
    const toTeam = await one(db, "SELECT id, lead_id, manager_id FROM teams WHERE id = $1", [input.toTeamId]);
    if (!toTeam) notFound("Team not found");

    await db.query(
      "UPDATE goal_assignments SET ended_at = now(), progress_at_transfer = $2, overdue_at_transfer = $3 WHERE id = $1",
      [goal.assignment_id, progress.barPct, overdue],
    );
    const deadline: string = input.newDeadline ?? goal.current_deadline;
    await db.query(
      "INSERT INTO goal_assignments (goal_id, team_id, deadline, assigned_by, reason) VALUES ($1, $2, $3, $4, $5)",
      [input.goalId, input.toTeamId, deadline, actorId, reason],
    );
    await notify(db, [...(await ownerIds(db)), toTeam!.lead_id, toTeam!.manager_id], "goal_transferred", "goal", input.goalId,
      `"${goal.title}" moved to another team${overdue ? " while overdue" : ""}: ${reason}`);
    return { progressAtTransfer: progress.barPct, overdueAtTransfer: overdue };
  });
}

/** Team lead asks the manager for a later team deadline. */
export async function requestTeamExtension(pool: pg.Pool, actorId: string, input: { goalId: string; newDeadline: string; reason: string }) {
  const reason = requireReason(input.reason, "A deadline extension");
  return withActor(pool, actorId, reason, async (db) => {
    const actor = await loadActor(db, actorId);
    const { goal } = await goalState(db, input.goalId);
    assertLeadOf(actor, goal.current_team_id);
    const current: string = goal.current_deadline;
    if (input.newDeadline <= current) invalid("The new deadline must be later than the current one");
    const team = await one(db, "SELECT manager_id FROM teams WHERE id = $1", [goal.current_team_id]);
    const req = await one<{ id: string }>(
      db,
      `INSERT INTO change_requests (target_type, target_id, field, old_value, new_value, reason, requested_by, approver_id)
       VALUES ('goal', $1, 'deadline', to_jsonb($2::date), to_jsonb($3::date), $4, $5, $6) RETURNING id`,
      [input.goalId, current, input.newDeadline, reason, actorId, team!.manager_id],
    );
    await notify(db, [team!.manager_id], "approval_needed", "change_request", req!.id, `Team deadline extension requested for "${goal.title}"`);
    return { requestId: req!.id };
  });
}
