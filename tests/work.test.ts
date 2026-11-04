// Milestone 2 rules: goals, subtasks, approvals, statuses and blockers,
// exercised through the server commands against a real database.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGoal, requestTeamExtension, transferGoal } from "../src/server/goals";
import {
  changeEstimate, createSubtask, extendDeadline, mergeSubtasks, reassign, requestMoreTime, setStatus, splitSubtask, updateProgress,
} from "../src/server/subtasks";
import { decideChangeRequest, escalateRefusedRequest } from "../src/server/requests";
import { acknowledgeBlocker, decideBlocker, disputeBlocker, escalateLongBlockers, raiseBlocker, resolveBlocker } from "../src/server/blockers";
import { freshDatabase, inDays, seed } from "./helpers";

let env: Awaited<ReturnType<typeof freshDatabase>>;
const u: Record<string, string> = {};
const t: Record<string, string> = {};

const q = async (sql: string, params: unknown[] = []) => (await env.app.query(sql, params)).rows;
const current = async (id: string) => (await q("SELECT * FROM subtask_current WHERE id = $1", [id]))[0];
const notes = async (userId: string, kind: string) => q("SELECT * FROM notifications WHERE user_id = $1 AND kind = $2", [userId, kind]);

let goalId: string;
const sub = (over: Record<string, unknown> = {}) => ({
  goalId, title: "Tax tables", acceptanceCriteria: "All brackets pass tests", points: 3, due: inDays(20), assigneeId: u.emp!, ...over,
});

beforeAll(async () => {
  env = await freshDatabase("work");
  await seed(env.owner, async (c) => {
    for (const k of ["owner", "manager", "hr", "leadA", "leadB", "emp", "emp2", "emp3", "system"]) {
      u[k] = (await c.query("INSERT INTO users (email, name) VALUES ($1, $1) RETURNING id", [`${k}@x.test`])).rows[0].id;
    }
    const role = (k: string, r: string) => c.query("INSERT INTO user_roles (user_id, role, reason) VALUES ($1, $2, 'seed')", [u[k], r]);
    await role("owner", "owner"); await role("manager", "manager"); await role("hr", "hr");
    await role("leadA", "team_lead"); await role("leadB", "team_lead");
    for (const k of ["emp", "emp2", "emp3"]) await role(k, "employee");
    t.A = (await c.query("INSERT INTO teams (name, lead_id, manager_id) VALUES ('Team A', $1, $2) RETURNING id", [u.leadA, u.manager])).rows[0].id;
    t.B = (await c.query("INSERT INTO teams (name, lead_id, manager_id) VALUES ('Team B', $1, $2) RETURNING id", [u.leadB, u.manager])).rows[0].id;
    for (const [team, k] of [["A", "emp"], ["A", "emp2"], ["B", "emp3"]] as const) {
      await c.query("INSERT INTO team_members (team_id, user_id) VALUES ($1, $2)", [t[team], u[k]]);
    }
  });
  goalId = (await createGoal(env.app, u.manager!, { title: "Finish the payroll module", teamId: t.A!, deadline: inDays(45), priority: "high" })).goalId;
});

afterAll(async () => { await env?.cleanup(); });

describe("goals", () => {
  it("only management creates goals; the owner stays read-only", async () => {
    for (const k of ["emp", "leadA", "owner"]) {
      await expect(createGoal(env.app, u[k]!, { title: "x", teamId: t.A!, deadline: inDays(5) })).rejects.toThrow(/Only a manager, HR or an admin/);
    }
    expect(await notes(u.leadA!, "goal_assigned")).toHaveLength(1);
  });

  it("extends a team deadline only with manager approval and keeps the original", async () => {
    const { requestId } = await requestTeamExtension(env.app, u.leadA!, { goalId, newDeadline: inDays(50), reason: "vendor delay" });
    await expect(decideChangeRequest(env.app, u.leadA!, { requestId, approve: true, reason: "ok" })).rejects.toThrow(/your own request/);
    await decideChangeRequest(env.app, u.manager!, { requestId, approve: true, reason: "vendor confirmed delay" });
    const [g] = await q("SELECT g.original_deadline, c.current_deadline FROM goals g JOIN goal_current c USING (id) WHERE g.id = $1", [goalId]);
    expect(g).toEqual({ original_deadline: inDays(45), current_deadline: inDays(50) });
  });
});

describe("subtasks", () => {
  it("only the lead of the goal's team plans it", async () => {
    await expect(createSubtask(env.app, u.leadB!, sub())).rejects.toThrow(/Only the team lead/);
    await expect(createSubtask(env.app, u.leadA!, sub({ assigneeId: u.emp3 }))).rejects.toThrow(/not on this team/);
    await expect(createSubtask(env.app, u.leadA!, sub({ due: inDays(60) }))).rejects.toThrow(/team deadline/);
  });

  it("needs a reason to override the reference effort, and keeps both", async () => {
    await expect(createSubtask(env.app, u.leadA!, sub({ points: 5, referencePoints: 3 }))).rejects.toThrow(/reference effort needs a reason/);
    const { subtaskId } = await createSubtask(env.app, u.leadA!, sub({ points: 5, referencePoints: 3, overrideReason: "legacy code" }));
    const [s] = await q("SELECT original_points, reference_points, override_reason FROM subtasks WHERE id = $1", [subtaskId]);
    expect(s).toEqual({ original_points: 5, reference_points: 3, override_reason: "legacy code" });
  });

  it("flags deadlines shorter than the minimum lead time", async () => {
    await expect(createSubtask(env.app, u.leadA!, sub({ points: 8, due: inDays(3) }))).rejects.toThrow(/needs at least 10 days/);
    const r = await createSubtask(env.app, u.leadA!, sub({ points: 8, due: inDays(3), shortLeadReason: "client demo moved up" }));
    expect(r.shortLeadFlagged).toBe(true);
  });

  it("warns when every subtask is due on the team's last day", async () => {
    const g = (await createGoal(env.app, u.manager!, { title: "Fix the UI", teamId: t.A!, deadline: inDays(30) })).goalId;
    await createSubtask(env.app, u.leadA!, sub({ goalId: g, due: inDays(30) }));
    const r = await createSubtask(env.app, u.leadA!, sub({ goalId: g, due: inDays(30) }));
    expect(r.warnings).toContain("Every subtask is due on the team's last day");
  });

  it("changes estimates directly before work starts, and needs approval for big changes after", async () => {
    const { subtaskId } = await createSubtask(env.app, u.leadA!, sub());
    expect(await changeEstimate(env.app, u.leadA!, { subtaskId, points: 8, reason: "bigger than thought" })).toEqual({ applied: true });
    await setStatus(env.app, u.emp!, { subtaskId, to: "in_progress" });
    expect(await changeEstimate(env.app, u.leadA!, { subtaskId, points: 5, reason: "one level down" })).toEqual({ applied: true });
    const r = await changeEstimate(env.app, u.leadA!, { subtaskId, points: 2, reason: "scope trimmed" });
    expect(r.applied).toBe(false);
    expect((await current(subtaskId)).points).toBe(5);
    await decideChangeRequest(env.app, u.manager!, { requestId: r.requestId!, approve: true, reason: "agreed" });
    expect(await current(subtaskId)).toMatchObject({ points: 2, original_points: 3 });
  });

  it("keeps credit with the first employee when work is reassigned after it started", async () => {
    const { subtaskId } = await createSubtask(env.app, u.leadA!, sub());
    expect(await reassign(env.app, u.leadA!, { subtaskId, assigneeId: u.emp2!, reason: "workload" })).toEqual({ applied: true });
    await setStatus(env.app, u.emp2!, { subtaskId, to: "in_progress" });
    await expect(reassign(env.app, u.leadA!, { subtaskId, assigneeId: u.emp!, reason: "sick leave" })).rejects.toThrow(/share of work already done/);
    const r = await reassign(env.app, u.leadA!, { subtaskId, assigneeId: u.emp!, reason: "sick leave", creditToPrevious: 0.4 });
    await decideChangeRequest(env.app, u.manager!, { requestId: r.requestId!, approve: true, reason: "ok" });
    expect((await current(subtaskId)).assignee).toBe(u.emp);
    const [rev] = await q("SELECT credit_to_previous FROM subtask_revisions WHERE subtask_id = $1 AND field = 'assignee' ORDER BY id DESC LIMIT 1", [subtaskId]);
    expect(rev.credit_to_previous).toBe("0.40");
    expect((await current(subtaskId)).original_assignee).toBe(u.emp);
  });

  it("extends a subtask deadline and keeps the original", async () => {
    const { subtaskId } = await createSubtask(env.app, u.leadA!, sub());
    await extendDeadline(env.app, u.leadA!, { subtaskId, due: inDays(25), reason: "waiting on finance" });
    expect(await current(subtaskId)).toMatchObject({ original_due: inDays(20), due: inDays(25) });
    await expect(extendDeadline(env.app, u.leadA!, { subtaskId, due: inDays(55), reason: "x" })).rejects.toThrow(/team deadline/);
  });

  it("lets an employee escalate a refused request for more time to the manager", async () => {
    const { subtaskId } = await createSubtask(env.app, u.leadA!, sub());
    await expect(requestMoreTime(env.app, u.emp2!, { subtaskId, due: inDays(30), reason: "x" })).rejects.toThrow(/assigned employee/);
    const { requestId } = await requestMoreTime(env.app, u.emp!, { subtaskId, due: inDays(30), reason: "tests are failing upstream" });
    await expect(decideChangeRequest(env.app, u.manager!, { requestId, approve: true, reason: "x" })).rejects.toThrow(/waiting on someone else/);
    await decideChangeRequest(env.app, u.leadA!, { requestId, approve: false, reason: "not needed" });
    await escalateRefusedRequest(env.app, u.emp!, { requestId, reason: "the upstream bug is real" });
    await expect(decideChangeRequest(env.app, u.leadA!, { requestId, approve: false, reason: "still no" })).rejects.toThrow(/waiting on someone else/);
    await decideChangeRequest(env.app, u.manager!, { requestId, approve: true, reason: "confirmed upstream bug" });
    expect((await current(subtaskId)).due).toBe(inDays(30));
  });

  it("splits and merges with history kept", async () => {
    const { subtaskId } = await createSubtask(env.app, u.leadA!, sub({ points: 8 }));
    const part = { title: "part", acceptanceCriteria: "done", points: 3, due: inDays(20), assigneeId: u.emp! };
    const { parts } = await splitSubtask(env.app, u.leadA!, { subtaskId, reason: "too big", parts: [part, part] });
    expect((await current(subtaskId)).in_scope).toBe(false);
    expect((await q("SELECT count(*)::int AS n FROM subtasks WHERE split_from = $1", [subtaskId]))[0].n).toBe(2);
    await mergeSubtasks(env.app, u.leadA!, { intoId: parts[0]!, fromIds: [parts[1]!], reason: "same work" });
    expect(await current(parts[1]!)).toBeUndefined();
    expect((await q("SELECT count(*)::int AS n FROM subtasks WHERE id = $1", [parts[1]]))[0].n).toBe(1);
  });
});

describe("statuses", () => {
  it("follows the review flow and counts a reopen against the deliverer", async () => {
    const { subtaskId } = await createSubtask(env.app, u.leadA!, sub());
    await expect(setStatus(env.app, u.emp2!, { subtaskId, to: "in_progress" })).rejects.toThrow(/cannot move/);
    await setStatus(env.app, u.emp!, { subtaskId, to: "in_progress" });
    await updateProgress(env.app, u.emp!, { subtaskId, body: "half the brackets done" });
    await expect(setStatus(env.app, u.emp!, { subtaskId, to: "done" })).rejects.toThrow(/cannot move/);
    await setStatus(env.app, u.emp!, { subtaskId, to: "in_review" });
    await setStatus(env.app, u.leadA!, { subtaskId, to: "done" });
    await expect(setStatus(env.app, u.leadA!, { subtaskId, to: "in_progress" })).rejects.toThrow(/needs a reason/);
    await setStatus(env.app, u.leadA!, { subtaskId, to: "in_progress", note: "rounding bug found in prod" });
    const [r] = await q("SELECT employee_id, score, is_reopen FROM quality_ratings WHERE subtask_id = $1", [subtaskId]);
    expect(r).toEqual({ employee_id: u.emp, score: 1, is_reopen: true });
  });
});

describe("blockers", () => {
  it("belong to the employee and go to the manager when disputed", async () => {
    const { subtaskId } = await createSubtask(env.app, u.leadA!, sub());
    await setStatus(env.app, u.emp!, { subtaskId, to: "in_progress" });
    await expect(raiseBlocker(env.app, u.leadA!, { subtaskId, type: "external", reason: "x" })).rejects.toThrow(/assigned employee/);
    const { blockerId } = await raiseBlocker(env.app, u.emp!, { subtaskId, type: "external", reason: "vendor API keys missing" });
    expect((await current(subtaskId)).status).toBe("blocked");
    await expect(setStatus(env.app, u.emp!, { subtaskId, to: "in_review" })).rejects.toThrow(/raise or resolve blocker/);

    await disputeBlocker(env.app, u.leadA!, { blockerId, reason: "keys were sent last week" });
    await expect(acknowledgeBlocker(env.app, u.leadA!, { blockerId })).rejects.toThrow(/already answered/);
    await expect(decideBlocker(env.app, u.leadA!, { blockerId, uphold: false, reason: "x" })).rejects.toThrow(/Only the team's manager/);
    await decideBlocker(env.app, u.manager!, { blockerId, uphold: true, reason: "keys were for the wrong environment" });
    const [b] = await q("SELECT outcome FROM blocker_current WHERE id = $1", [blockerId]);
    expect(b.outcome).toBe("upheld");

    const r = await resolveBlocker(env.app, u.emp!, { blockerId });
    expect(r.lasted).toBeDefined();
    expect((await current(subtaskId)).status).toBe("in_progress");
  });

  it("can never be deleted, even directly in the database", async () => {
    await expect(env.admin.query("DELETE FROM blockers")).rejects.toThrow(/append-only/);
    await expect(env.app.query("DELETE FROM blockers")).rejects.toThrow(/permission denied/);
  });

  it("escalate to the manager once after 2 days", async () => {
    const { subtaskId } = await createSubtask(env.app, u.leadA!, sub());
    await setStatus(env.app, u.emp!, { subtaskId, to: "in_progress" });
    await raiseBlocker(env.app, u.emp!, { subtaskId, type: "internal", reason: "waiting on design" });
    const later = new Date(Date.now() + 3 * 86_400_000);
    const first = await escalateLongBlockers(env.app, u.system!, later);
    expect(first.escalated).toBeGreaterThanOrEqual(1);
    expect((await escalateLongBlockers(env.app, u.system!, later)).escalated).toBe(0);
    expect((await notes(u.manager!, "blocker_escalated")).length).toBe(first.escalated);
  });
});

describe("goal transfer", () => {
  it("only the manager moves a goal, the owner is told, and lateness stays with the first team", async () => {
    const late = await seed(env.owner, async (c) => {
      const g = (await c.query("INSERT INTO goals (title, created_by, original_team_id, original_deadline) VALUES ('Late goal', $1, $2, $3) RETURNING id",
        [u.manager, t.A, inDays(-2)])).rows[0].id;
      await c.query("INSERT INTO goal_assignments (goal_id, team_id, deadline, assigned_by, assigned_at, reason) VALUES ($1, $2, $3, $4, now() - interval '20 days', 'seed')",
        [g, t.A, inDays(-2), u.manager]);
      return g as string;
    });
    await expect(transferGoal(env.app, u.leadA!, { goalId: late, toTeamId: t.B!, reason: "x" })).rejects.toThrow(/team's manager/);
    const r = await transferGoal(env.app, u.manager!, { goalId: late, toTeamId: t.B!, reason: "Team A overloaded", newDeadline: inDays(10) });
    expect(r.overdueAtTransfer).toBe(true);
    const rows = await q("SELECT team_id, ended_at IS NOT NULL AS ended, overdue_at_transfer FROM goal_assignments WHERE goal_id = $1 ORDER BY id", [late]);
    expect(rows).toEqual([
      { team_id: t.A, ended: true, overdue_at_transfer: true },
      { team_id: t.B, ended: false, overdue_at_transfer: null },
    ]);
    expect(await notes(u.owner!, "goal_transferred")).toHaveLength(1);
  });
});

describe("audit trail", () => {
  it("is intact after all of the above", async () => {
    expect(await q("SELECT * FROM verify_audit_chain()")).toEqual([]);
    expect((await q("SELECT count(*)::int AS n FROM audit_log"))[0].n).toBeGreaterThan(100);
  });
});
