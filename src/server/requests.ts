// Approvals. A request is decided by its approver (never the requester).
// An employee whose request for more time is refused can escalate it once
// to the manager. Approved changes are applied as revisions.
import type pg from "pg";
import { one, withActor } from "./db";
import { forbid, invalid, notFound, requireReason } from "./errors";
import { notify } from "./notify";
import { subtaskContext } from "./subtasks";

export async function decideChangeRequest(pool: pg.Pool, actorId: string, input: { requestId: string; approve: boolean; reason: string }) {
  const reason = requireReason(input.reason, "A decision");
  return withActor(pool, actorId, reason, async (db) => {
    const req = await one(db, "SELECT * FROM change_request_current WHERE id = $1", [input.requestId]);
    if (!req) notFound("Request not found");
    if (req!.status !== "pending" && req!.status !== "escalated") invalid("This request is already decided");
    if (req!.requested_by === actorId) forbid("You cannot decide your own request");

    let decider: string = req!.approver_id;
    let subtask;
    if (req!.target_type === "subtask") subtask = await subtaskContext(db, req!.target_id);
    if (req!.status === "escalated") {
      if (!subtask) invalid("Only subtask requests can be escalated");
      decider = subtask!.manager_id;
    }
    if (decider !== actorId) forbid("This request is waiting on someone else");

    await db.query("INSERT INTO change_request_decisions (request_id, status, decided_by, reason) VALUES ($1, $2, $3, $4)",
      [req!.id, input.approve ? "approved" : "refused", actorId, reason]);

    if (input.approve) {
      const newValue = req!.new_value;
      if (req!.target_type === "goal") {
        const goal = await one(db, "SELECT assignment_id, current_deadline FROM goal_current WHERE id = $1", [req!.target_id]);
        await db.query(
          `INSERT INTO goal_revisions (goal_id, assignment_id, field, old_value, new_value, reason, changed_by, request_id)
           VALUES ($1, $2, 'deadline', to_jsonb($3::date), $4, $5, $6, $7)`,
          [req!.target_id, goal!.assignment_id, goal!.current_deadline, JSON.stringify(newValue), req!.reason, actorId, req!.id],
        );
      } else {
        const s = subtask!;
        const field = req!.field === "deadline" ? "due" : req!.field;
        let value = newValue;
        let credit: number | null = null;
        let old: unknown = field === "points" ? s.points : field === "due" ? s.due : s.assignee;
        if (field === "due" && newValue > s.team_deadline) invalid(`The due date must be on or before the team deadline (${s.team_deadline})`);
        if (field === "assignee") { value = newValue.assignee; credit = newValue.creditToPrevious; }
        await db.query(
          `INSERT INTO subtask_revisions (subtask_id, field, old_value, new_value, reason, changed_by, request_id, credit_to_previous)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
          [s.id, field, JSON.stringify(old), JSON.stringify(value), req!.reason, actorId, req!.id, credit],
        );
      }
    }
    await notify(db, [req!.requested_by], input.approve ? "request_approved" : "request_refused", "change_request", req!.id,
      `Your request was ${input.approve ? "approved" : "refused"}: ${reason}`);
    return { status: input.approve ? "approved" : "refused" };
  });
}

/** The employee escalates a refused request for more time to the manager. */
export async function escalateRefusedRequest(pool: pg.Pool, actorId: string, input: { requestId: string; reason: string }) {
  const reason = requireReason(input.reason, "An escalation");
  return withActor(pool, actorId, reason, async (db) => {
    const req = await one(db, "SELECT * FROM change_request_current WHERE id = $1", [input.requestId]);
    if (!req) notFound("Request not found");
    if (req!.requested_by !== actorId) forbid("Only the person who asked can escalate");
    if (req!.status !== "refused") invalid("Only a refused request can be escalated");
    const already = await one(db, "SELECT 1 FROM change_request_decisions WHERE request_id = $1 AND status = 'escalated'", [req!.id]);
    if (already) invalid("This request was already escalated");
    const s = await subtaskContext(db, req!.target_id);
    await db.query("INSERT INTO change_request_decisions (request_id, status, decided_by, reason) VALUES ($1, 'escalated', $2, $3)", [req!.id, actorId, reason]);
    await notify(db, [s.manager_id], "approval_needed", "change_request", req!.id, `Escalated request for more time on "${s.title}"`);
    return { status: "escalated" };
  });
}
