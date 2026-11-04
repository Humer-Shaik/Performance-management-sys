// Milestone 4: disputes, reviewer assignment, corrections, revised locked scores, escalation.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGoal } from "../src/server/goals";
import { createSubtask, setStatus } from "../src/server/subtasks";
import { decideBlocker, disputeBlocker, raiseBlocker } from "../src/server/blockers";
import { rateCollaboration, rateQuality } from "../src/server/ratings";
import { computeDrafts, lockPeriod, openPeriod, scoreBreakdown } from "../src/server/scoring";
import { addWorkingDays, decideDispute, escalateOverdueDisputes, fileDispute, rescoreAfterDisputes } from "../src/server/disputes";
import { freshDatabase, inDays, seed, seedOrg } from "./helpers";

let env: Awaited<ReturnType<typeof freshDatabase>>;
let u: Record<string, string>;
let t: Record<string, string>;
let goalId: string;
const ratings: string[] = [];
const P = "2026-Q4";
const LOCK_AT = new Date("2027-01-02T00:00:00Z");
const q = async (sql: string, params: unknown[] = []) => (await env.app.query(sql, params)).rows;

async function deliveredTask(title: string) {
  const { subtaskId } = await createSubtask(env.app, u.leadA!, { goalId, title, acceptanceCriteria: "ok", points: 3, due: inDays(15), assigneeId: u.emp! });
  await setStatus(env.app, u.emp!, { subtaskId, to: "in_progress" });
  await setStatus(env.app, u.emp!, { subtaskId, to: "in_review" });
  await setStatus(env.app, u.leadA!, { subtaskId, to: "done" });
  return subtaskId;
}

beforeAll(async () => {
  env = await freshDatabase("disputes");
  ({ u, t } = await seedOrg(env.owner));
  await seed(env.owner, async (c) => {
    u.headHr = (await c.query("INSERT INTO users (email, name) VALUES ('head@x.test', 'head') RETURNING id")).rows[0].id;
    await c.query("INSERT INTO user_roles (user_id, role, reason) VALUES ($1, 'head_of_hr', 'seed')", [u.headHr]);
  });
  await openPeriod(env.app, u.hr!, { id: P, startsOn: "2026-10-01", endsOn: "2026-12-31" });
  goalId = (await createGoal(env.app, u.manager!, { title: "Payroll", teamId: t.A!, deadline: inDays(40) })).goalId;
  const scores = [3, 2, 3] as const;
  for (const [i, score] of scores.entries()) {
    const s = await deliveredTask(`task ${i}`);
    ratings.push((await rateQuality(env.app, u.leadA!, { subtaskId: s, score, reason: score === 2 ? "criteria missed" : undefined })).ratingId);
  }
  for (const k of ["leadA", "emp2", "emp4"]) await rateCollaboration(env.app, u[k]!, { periodId: P, subjectId: u.emp!, score: 4, examples: "helpful" });
});

afterAll(async () => { await env?.cleanup(); });

describe("addWorkingDays", () => {
  it("skips weekends", () => {
    expect(addWorkingDays(new Date("2026-11-06T10:00:00Z"), 1).toISOString().slice(0, 10)).toBe("2026-11-09"); // Fri -> Mon
    expect(addWorkingDays(new Date("2026-11-04T10:00:00Z"), 10).toISOString().slice(0, 10)).toBe("2026-11-18");
  });
});

describe("filing", () => {
  it("is open only to the affected employee, within 14 days, once at a time", async () => {
    await expect(fileDispute(env.app, u.emp2!, { targetType: "quality_rating", targetId: ratings[1]!, evidence: "x" })).rejects.toThrow(/your own ratings/);
    await expect(fileDispute(env.app, u.emp!, { targetType: "quality_rating", targetId: ratings[1]!, evidence: " " })).rejects.toThrow(/evidence/);
    await expect(fileDispute(env.app, u.emp!, { targetType: "quality_rating", targetId: ratings[1]!, evidence: "x" }, new Date(Date.now() + 20 * 86_400_000)))
      .rejects.toThrow(/within 14 days/);
    await expect(fileDispute(env.app, u.emp!, { targetType: "review_comment", targetId: "x", evidence: "x" })).rejects.toThrow(/not part of version one/);
  });
});

describe("a quality rating dispute", () => {
  let disputeId: string;
  it("goes to the lead's manager, never the lead, and leaves the original in force", async () => {
    const r = await fileDispute(env.app, u.emp!, { targetType: "quality_rating", targetId: ratings[1]!, evidence: "both criteria are met, see PR 17" });
    disputeId = r.disputeId;
    expect(r.reviewerId).toBe(u.manager);
    await expect(fileDispute(env.app, u.emp!, { targetType: "quality_rating", targetId: ratings[1]!, evidence: "again" })).rejects.toThrow(/already have an open dispute/);
    expect((await q("SELECT score FROM quality_rating_latest WHERE id = $1", [ratings[1]]))[0].score).toBe(2);
    await expect(decideDispute(env.app, u.leadA!, { disputeId, outcome: "upheld", reason: "x" })).rejects.toThrow(/challenged cannot decide/);
    await expect(decideDispute(env.app, u.hr!, { disputeId, outcome: "upheld", reason: "x" })).rejects.toThrow(/assigned to someone else/);
  });

  it("corrects the rating as a new version when upheld, keeping the old one", async () => {
    await expect(decideDispute(env.app, u.manager!, { disputeId, outcome: "upheld", reason: "criteria met",
      correction: { kind: "quality_rating", rating: { score: 4 } } })).rejects.toThrow(/positive example/);
    await decideDispute(env.app, u.manager!, { disputeId, outcome: "upheld", reason: "criteria met",
      correction: { kind: "quality_rating", rating: { score: 4, example: "handled the leap-year case" } } });
    const versions = await q("SELECT score, change_reason FROM quality_ratings WHERE subtask_id = (SELECT subtask_id FROM quality_ratings WHERE id = $1) ORDER BY created_at", [ratings[1]]);
    expect(versions.map((v) => v.score)).toEqual([2, 4]);
    expect(versions[1].change_reason).toMatch(/^dispute decision/);
    await expect(decideDispute(env.app, u.manager!, { disputeId, outcome: "rejected", reason: "changed my mind" })).rejects.toThrow(/already decided/);
  });
});

describe("after the quarter locks", () => {
  it("an upheld dispute writes a revised score and keeps the locked one", async () => {
    await computeDrafts(env.scoring, u.system!, P);
    await lockPeriod(env.scoring, u.system!, P, LOCK_AT);
    const before = await scoreBreakdown(env.app, u.emp!, u.emp!, P);
    const { disputeId } = await fileDispute(env.app, u.emp!, { targetType: "quality_rating", targetId: ratings[0]!, evidence: "customer praised it" });
    const d = await decideDispute(env.app, u.manager!, { disputeId, outcome: "upheld", reason: "evidence is solid",
      correction: { kind: "quality_rating", rating: { score: 5, evidenceUrls: ["https://mail/thanks"] } } });
    expect(d.rescoreNeeded).toBe(true);

    await expect(rescoreAfterDisputes(env.app, u.system!)).rejects.toThrow(/permission denied/);
    const [r] = await rescoreAfterDisputes(env.scoring, u.system!);
    expect(r!.before).toBe(before.total);
    expect(r!.after!).toBeGreaterThan(before.total!);
    const after = await scoreBreakdown(env.app, u.emp!, u.emp!, P);
    expect(after.status).toBe("revised_by_dispute");
    expect((await q("SELECT status FROM score_snapshots WHERE employee_id = $1 AND status <> 'draft' ORDER BY computed_at", [u.emp])).map((x) => x.status))
      .toEqual(["locked", "revised_by_dispute"]);
    expect(await rescoreAfterDisputes(env.scoring, u.system!)).toEqual([]);
  });

  it("a dispute of the calculation goes to HR", async () => {
    const snap = await scoreBreakdown(env.app, u.emp!, u.emp!, P);
    const r = await fileDispute(env.app, u.emp!, { targetType: "score", targetId: snap.snapshotId, evidence: "a task is missing" });
    expect(r.reviewerId).toBe(u.hr);
    await decideDispute(env.app, u.hr!, { disputeId: r.disputeId, outcome: "rejected", reason: "the task is due next quarter" });
  });
});

describe("a blocker decision dispute", () => {
  it("can overturn a manager's rejection", async () => {
    const { subtaskId } = await createSubtask(env.app, u.leadA!, { goalId, title: "blocked one", acceptanceCriteria: "ok", points: 3, due: inDays(20), assigneeId: u.emp! });
    await setStatus(env.app, u.emp!, { subtaskId, to: "in_progress" });
    const { blockerId } = await raiseBlocker(env.app, u.emp!, { subtaskId, type: "external", reason: "vendor outage" });
    await disputeBlocker(env.app, u.leadA!, { blockerId, reason: "vendor was up" });
    await decideBlocker(env.app, u.manager!, { blockerId, uphold: false, reason: "status page shows no outage" });
    const r = await fileDispute(env.app, u.emp!, { targetType: "blocker_decision", targetId: blockerId, evidence: "vendor incident report INC-55" });
    expect(r.reviewerId).toBe(u.hr); // the manager made the decision, so HR reviews
    await decideDispute(env.app, u.hr!, { disputeId: r.disputeId, outcome: "upheld", reason: "incident report confirms", correction: { kind: "blocker_decision" } });
    expect((await q("SELECT outcome FROM blocker_current WHERE id = $1", [blockerId]))[0].outcome).toBe("upheld");
  });
});

describe("overdue disputes", () => {
  it("escalate to the head of HR, who can then decide", async () => {
    const { subtaskId } = await createSubtask(env.app, u.leadA!, { goalId, title: "estimate", acceptanceCriteria: "ok", points: 8, due: inDays(30), assigneeId: u.emp! });
    const { disputeId } = await fileDispute(env.app, u.emp!, { targetType: "estimate", targetId: subtaskId, evidence: "this is a 3-point change" });
    expect((await escalateOverdueDisputes(env.app, u.system!, new Date(Date.now() + 5 * 86_400_000))).escalated).toBe(0);
    expect((await escalateOverdueDisputes(env.app, u.system!, new Date(Date.now() + 20 * 86_400_000))).escalated).toBe(1);
    expect((await escalateOverdueDisputes(env.app, u.system!, new Date(Date.now() + 20 * 86_400_000))).escalated).toBe(0);
    await decideDispute(env.app, u.headHr!, { disputeId, outcome: "upheld", reason: "agreed", correction: { kind: "estimate", points: 3 } });
    expect((await q("SELECT points, original_points FROM subtask_current WHERE id = $1", [subtaskId]))[0]).toEqual({ points: 3, original_points: 8 });
  });
});

describe("reporting", () => {
  it("shows how often each lead's decisions are overturned", async () => {
    const [lead] = await q("SELECT decided, overturned, overturn_pct FROM dispute_overturn_rates WHERE user_id = $1", [u.leadA]);
    expect(lead).toEqual({ decided: "3", overturned: "3", overturn_pct: "100.0" });
    expect(await q("SELECT * FROM verify_audit_chain()")).toEqual([]);
  });
});
