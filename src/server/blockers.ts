// Blockers belong to the employee: raised without approval, never deleted.
// The lead can acknowledge or dispute; a disputed blocker goes to the manager.
import type pg from "pg";
import { many, one, withActor, type Db } from "./db";
import { forbid, invalid, notFound, requireReason } from "./errors";
import { notify } from "./notify";
import { subtaskContext } from "./subtasks";

type BlockerType = "internal" | "external" | "employee_caused";

async function blockerContext(db: Db, blockerId: string) {
  const b = await one(db, "SELECT * FROM blocker_current WHERE id = $1", [blockerId]);
  if (!b) notFound("Blocker not found");
  return { blocker: b!, subtask: await subtaskContext(db, b!.subtask_id) };
}

export async function raiseBlocker(pool: pg.Pool, actorId: string, input: { subtaskId: string; type: BlockerType; reason: string }) {
  const reason = requireReason(input.reason, "A blocker");
  return withActor(pool, actorId, reason, async (db) => {
    const s = await subtaskContext(db, input.subtaskId);
    if (s.assignee !== actorId) forbid("Only the assigned employee can raise a blocker");
    if (s.status === "done" || s.status === "not_started") invalid("Only work in progress or in review can be blocked");
    const b = await one<{ id: string }>(db, "INSERT INTO blockers (subtask_id, raised_by, type, reason) VALUES ($1, $2, $3, $4) RETURNING id",
      [s.id, actorId, input.type, reason]);
    if (s.status !== "blocked") {
      await db.query("INSERT INTO status_events (subtask_id, from_status, to_status, actor_id, note) VALUES ($1, $2, 'blocked', $3, $4)",
        [s.id, s.status, actorId, `blocker raised: ${reason}`]);
    }
    await notify(db, [s.lead_id], "blocker_raised", "blocker", b!.id, `"${s.title}" is blocked (${input.type}): ${reason}`);
    return { blockerId: b!.id };
  });
}

export async function acknowledgeBlocker(pool: pg.Pool, actorId: string, input: { blockerId: string; note?: string }) {
  return withActor(pool, actorId, input.note?.trim() || "acknowledge blocker", async (db) => {
    const { blocker, subtask } = await blockerContext(db, input.blockerId);
    if (subtask.lead_id !== actorId) forbid("Only the team lead can acknowledge a blocker");
    if (blocker.answered_at) invalid("This blocker was already answered");
    await db.query("INSERT INTO blocker_events (blocker_id, kind, actor_id, reason) VALUES ($1, 'acknowledged', $2, $3)", [blocker.id, actorId, input.note ?? null]);
    return { outcome: "acknowledged" };
  });
}

export async function disputeBlocker(pool: pg.Pool, actorId: string, input: { blockerId: string; reason: string }) {
  const reason = requireReason(input.reason, "Disputing a blocker");
  return withActor(pool, actorId, reason, async (db) => {
    const { blocker, subtask } = await blockerContext(db, input.blockerId);
    if (subtask.lead_id !== actorId) forbid("Only the team lead can dispute a blocker");
    if (blocker.answered_at) invalid("This blocker was already answered");
    await db.query("INSERT INTO blocker_events (blocker_id, kind, actor_id, reason) VALUES ($1, 'disputed', $2, $3)", [blocker.id, actorId, reason]);
    await notify(db, [subtask.manager_id, subtask.assignee], "blocker_disputed", "blocker", blocker.id, `Lead disputed a blocker on "${subtask.title}": ${reason}`);
    return { outcome: "open_dispute" };
  });
}

/** The manager decides a disputed blocker. Never the lead who disputed it. */
export async function decideBlocker(pool: pg.Pool, actorId: string, input: { blockerId: string; uphold: boolean; reason: string }) {
  const reason = requireReason(input.reason, "A blocker decision");
  return withActor(pool, actorId, reason, async (db) => {
    const { blocker, subtask } = await blockerContext(db, input.blockerId);
    if (blocker.outcome !== "open_dispute") invalid("Only a disputed blocker can be decided");
    if (subtask.manager_id !== actorId) forbid("Only the team's manager can decide a disputed blocker");
    if (subtask.lead_id === actorId) forbid("The lead who disputed the blocker cannot decide it");
    await db.query("INSERT INTO blocker_events (blocker_id, kind, actor_id, reason) VALUES ($1, $2, $3, $4)",
      [blocker.id, input.uphold ? "upheld" : "rejected", actorId, reason]);
    await notify(db, [subtask.assignee, subtask.lead_id], "blocker_decided", "blocker", blocker.id,
      `Blocker on "${subtask.title}" was ${input.uphold ? "upheld" : "rejected"}: ${reason}`);
    return { outcome: input.uphold ? "upheld" : "rejected" };
  });
}

/** Employee or lead marks the blocker resolved; the system records how long it lasted. */
export async function resolveBlocker(pool: pg.Pool, actorId: string, input: { blockerId: string; note?: string }) {
  return withActor(pool, actorId, input.note?.trim() || "resolve blocker", async (db) => {
    const { blocker, subtask } = await blockerContext(db, input.blockerId);
    if (actorId !== subtask.assignee && actorId !== subtask.lead_id) forbid("Only the employee or the lead can resolve a blocker");
    if (blocker.resolved_at) invalid("This blocker is already resolved");
    await db.query("INSERT INTO blocker_events (blocker_id, kind, actor_id, reason) VALUES ($1, 'resolved', $2, $3)", [blocker.id, actorId, input.note ?? null]);
    const stillOpen = await one(db, "SELECT 1 FROM blocker_current WHERE subtask_id = $1 AND resolved_at IS NULL", [subtask.id]);
    if (!stillOpen && subtask.status === "blocked") {
      await db.query("INSERT INTO status_events (subtask_id, from_status, to_status, actor_id, note) VALUES ($1, 'blocked', 'in_progress', $2, 'blockers resolved')",
        [subtask.id, actorId]);
    }
    const r = await one(db, "SELECT resolved_at - raised_at AS lasted FROM blocker_current WHERE id = $1", [blocker.id]);
    return { lasted: r!.lasted };
  });
}

/**
 * Scheduled job: a blocker open for more than 2 days escalates to the manager,
 * once. Runs as a named system user so the audit log shows who acted.
 */
export async function escalateLongBlockers(pool: pg.Pool, systemUserId: string, now = new Date()) {
  return withActor(pool, systemUserId, "blocker open more than 2 days", async (db) => {
    const due = await many(
      db,
      `SELECT b.id, b.subtask_id FROM blocker_current b
       WHERE b.resolved_at IS NULL AND b.raised_at < $1::timestamptz - interval '2 days'
         AND NOT EXISTS (SELECT 1 FROM blocker_escalations x WHERE x.blocker_id = b.id)`,
      [now.toISOString()],
    );
    for (const b of due) {
      const s = await subtaskContext(db, b.subtask_id);
      await db.query("INSERT INTO blocker_escalations (blocker_id, manager_id) VALUES ($1, $2)", [b.id, s.manager_id]);
      await notify(db, [s.manager_id], "blocker_escalated", "blocker", b.id, `"${s.title}" has been blocked for more than 2 days`);
    }
    return { escalated: due.length };
  });
}
