// Milestone 5a: risk job, accountability reports, owner raw view and export.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGoal } from "../src/server/goals";
import { createSubtask, extendDeadline, setStatus } from "../src/server/subtasks";
import { decideBlocker, disputeBlocker, raiseBlocker } from "../src/server/blockers";
import { openPeriod } from "../src/server/scoring";
import { checkRisks } from "../src/server/risk";
import { leadReport, managerReport } from "../src/server/reports";
import { addOwnerNote, exportView, rawView, toCsv } from "../src/server/owner";
import { freshDatabase, inDays, seedOrg } from "./helpers";

let env: Awaited<ReturnType<typeof freshDatabase>>;
let u: Record<string, string>;
let t: Record<string, string>;
let goalId: string;
const P = "2026-Q4";
const q = async (sql: string, params: unknown[] = []) => (await env.app.query(sql, params)).rows;
const DAY = 86_400_000;

beforeAll(async () => {
  env = await freshDatabase("reports");
  ({ u, t } = await seedOrg(env.owner));
  await openPeriod(env.app, u.hr!, { id: P, startsOn: "2026-10-01", endsOn: "2026-12-31" });
  goalId = (await createGoal(env.app, u.manager!, { title: "Payroll", teamId: t.A!, deadline: inDays(40), priority: "high" })).goalId;
  const mk = (assignee: string, points: number, due: number, shortLeadReason?: string) =>
    createSubtask(env.app, u.leadA!, { goalId, title: `${points}pt`, acceptanceCriteria: "ok", points, due: inDays(due), assigneeId: u[assignee]!, shortLeadReason });
  const big = [await mk("emp", 8, 20), await mk("emp", 8, 25), await mk("emp", 5, 15)];
  await mk("emp2", 2, 10);
  await mk("emp4", 1, 0, "hotfix for payroll run");
  await mk("emp4", 1, 0, "second hotfix");
  for (const [i, s] of big.entries()) await extendDeadline(env.app, u.leadA!, { subtaskId: s.subtaskId, due: inDays(30 + i), reason: "scope grew" });

  await setStatus(env.app, u.emp!, { subtaskId: big[0]!.subtaskId, to: "in_progress" });
  const { blockerId } = await raiseBlocker(env.app, u.emp!, { subtaskId: big[0]!.subtaskId, type: "external", reason: "bank file format unknown" });
  await disputeBlocker(env.app, u.leadA!, { blockerId, reason: "spec is in the wiki" });
  await decideBlocker(env.app, u.manager!, { blockerId, uphold: true, reason: "the wiki spec is outdated" });
});

afterAll(async () => { await env?.cleanup(); });

describe("risk job", () => {
  it("logs level changes and tells the right people", async () => {
    const start = Date.now();
    const first = await checkRisks(env.app, u.system!, new Date(start));
    expect(first.changes).toEqual([{ goalId, from: null, to: "on_track" }]);
    expect((await checkRisks(env.app, u.system!, new Date(start + 3600_000))).changes).toEqual([]); // weekly goal, not due again

    const critical = await checkRisks(env.app, u.system!, new Date(start + 25 * DAY));
    expect(critical.changes[0]).toMatchObject({ from: "on_track", to: "critical" });
    expect(await q("SELECT user_id FROM notifications WHERE kind = 'goal_critical' ORDER BY user_id", [])).toHaveLength(2);

    const overdue = await checkRisks(env.app, u.system!, new Date(start + 45 * DAY));
    expect(overdue.changes[0]).toMatchObject({ to: "overdue" });
    expect(await q("SELECT 1 FROM notifications WHERE kind = 'goal_overdue' AND user_id = $1", [u.owner])).toHaveLength(1);
  });
});

describe("lead accountability report", () => {
  it("flags the plan's default patterns", async () => {
    const r = await leadReport(env.app, u.hr!, u.leadA!, P);
    const text = r.flags.map((f) => `${f.measure}: ${f.message}`);
    expect(text).toEqual(expect.arrayContaining([
      expect.stringMatching(/^workload: emp@x.test has 21 points, .*above/),
      expect.stringMatching(/^workload: emp2@x.test has 2 points, .*below/),
      expect.stringMatching(/^difficulty: emp@x.test gets mostly high-complexity/),
      expect.stringMatching(/^deadlines: 33% of deadlines were shorter/),
      expect.stringMatching(/^deadlines: emp@x.test received 3 of 3 deadline extensions/),
      expect.stringMatching(/^blockers: 1 blockers the lead disputed were upheld/),
    ]));
    expect(r.workload.find((w) => w.userId === u.emp)!.vsTeamPct).toBeGreaterThan(30);
  });

  it("is visible to the lead, their manager, HR and the owner only", async () => {
    await expect(leadReport(env.app, u.leadB!, u.leadA!, P)).rejects.toThrow(/cannot see/);
    await expect(leadReport(env.app, u.emp!, u.leadA!, P)).rejects.toThrow(/cannot see/);
    for (const k of ["leadA", "manager", "hr", "owner"]) await expect(leadReport(env.app, u[k]!, u.leadA!, P)).resolves.toBeDefined();
    const m = await managerReport(env.app, u.manager!, u.manager!, P);
    expect(m.leads).toHaveLength(2);
    await expect(managerReport(env.app, u.leadA!, u.manager!, P)).rejects.toThrow(/cannot see/);
  });
});

describe("owner raw view", () => {
  it("shows originals next to current values, to the owner and admins only", async () => {
    await expect(rawView(env.app, u.manager!, "subtasks")).rejects.toThrow(/Only the owner/);
    const subs = await rawView(env.app, u.owner!, "subtasks");
    const ext = subs.find((s) => s.title === "8pt" && s.current_due !== s.original_due);
    expect(ext).toBeDefined();
    const blockers = await rawView(env.app, u.owner!, "blockers");
    expect(blockers[0].events.map((e: any) => e.kind)).toEqual(["disputed", "upheld"]);
    expect((await rawView(env.app, u.owner!, "audit")).length).toBeGreaterThan(20);
  });

  it("exports any view as CSV", async () => {
    const csv = await exportView(env.app, u.owner!, "goals");
    expect(csv.split("\r\n")[0]).toContain("original_deadline");
    expect(toCsv([{ a: 'say "hi", ok', b: { x: 1 }, c: null }])).toBe('a,b,c\r\n"say ""hi"", ok","{""x"":1}",\r\n');
  });

  it("lets the owner comment but not change records", async () => {
    await expect(addOwnerNote(env.app, u.leadA!, { entityType: "goal", entityId: goalId, kind: "comment", body: "x" })).rejects.toThrow(/Only the owner/);
    await addOwnerNote(env.app, u.owner!, { entityType: "goal", entityId: goalId, kind: "review_request", body: "Why so many extensions?" });
    expect(await q("SELECT kind FROM owner_notes")).toEqual([{ kind: "review_request" }]);
    expect(await q("SELECT * FROM verify_audit_chain()")).toEqual([]);
  });
});
