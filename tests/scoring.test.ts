// Milestone 3: ratings, collaboration, the score job and the quarter lock.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createGoal } from "../src/server/goals";
import { createSubtask, reassign, setStatus } from "../src/server/subtasks";
import { decideChangeRequest } from "../src/server/requests";
import { changeQualityRating, rateCollaboration, rateQuality, reviewQualityRating } from "../src/server/ratings";
import { computeDrafts, lockPeriod, openPeriod, scoreBreakdown } from "../src/server/scoring";
import { freshDatabase, inDays, seedOrg } from "./helpers";

let env: Awaited<ReturnType<typeof freshDatabase>>;
let u: Record<string, string>;
let t: Record<string, string>;
let goalId: string;
const done: string[] = [];
const P = "2026-Q4";

const q = async (sql: string, params: unknown[] = []) => (await env.app.query(sql, params)).rows;
const sub = (over: Record<string, unknown> = {}) => ({
  goalId, title: "task", acceptanceCriteria: "passes review", points: 3, due: inDays(15), assigneeId: u.emp!, ...over,
});
async function deliver(subtaskId: string, by: string) {
  await setStatus(env.app, by, { subtaskId, to: "in_progress" });
  await setStatus(env.app, by, { subtaskId, to: "in_review" });
  await setStatus(env.app, u.leadA!, { subtaskId, to: "done" });
}

beforeAll(async () => {
  env = await freshDatabase("scoring");
  ({ u, t } = await seedOrg(env.owner));
  goalId = (await createGoal(env.app, u.manager!, { title: "Finish the payroll module", teamId: t.A!, deadline: inDays(40) })).goalId;
  for (let i = 0; i < 3; i++) {
    const { subtaskId } = await createSubtask(env.app, u.leadA!, sub({ title: `task ${i}` }));
    await deliver(subtaskId, u.emp!);
    done.push(subtaskId);
  }
});

afterAll(async () => { await env?.cleanup(); });

describe("periods", () => {
  it("are opened by HR only", async () => {
    await expect(openPeriod(env.app, u.manager!, { id: P, startsOn: "2026-10-01", endsOn: "2026-12-31" })).rejects.toThrow(/Only HR/);
    await openPeriod(env.app, u.hr!, { id: P, startsOn: "2026-10-01", endsOn: "2026-12-31" });
  });
});

describe("quality ratings", () => {
  it("enforce the evidence rules", async () => {
    await expect(rateQuality(env.app, u.leadA!, { subtaskId: done[0]!, score: 1, reason: "bad" })).rejects.toThrow(/reason and evidence/);
    await expect(rateQuality(env.app, u.leadA!, { subtaskId: done[0]!, score: 2 })).rejects.toThrow(/written reason/);
    await expect(rateQuality(env.app, u.leadA!, { subtaskId: done[0]!, score: 4 })).rejects.toThrow(/positive example/);
    await expect(rateQuality(env.app, u.leadA!, { subtaskId: done[0]!, score: 5 })).rejects.toThrow(/specific evidence/);
    await expect(rateQuality(env.app, u.leadB!, { subtaskId: done[0]!, score: 3 })).rejects.toThrow(/Only the team lead/);
  });

  it("are rated once, then changed only as a new version with a reason", async () => {
    const { ratingId } = await rateQuality(env.app, u.leadA!, { subtaskId: done[0]!, score: 3 });
    await expect(rateQuality(env.app, u.leadA!, { subtaskId: done[0]!, score: 4, example: "x" })).rejects.toThrow(/already rated/);
    await expect(changeQualityRating(env.app, u.leadA!, { ratingId, score: 4, example: "caught an edge case in review", changeReason: "" })).rejects.toThrow(/needs a reason/);
    const r = await changeQualityRating(env.app, u.leadA!, { ratingId, score: 4, example: "caught an edge case in review", changeReason: "missed the test coverage" });
    expect(r.previousScore).toBe(3);
    expect((await q("SELECT count(*)::int AS n FROM quality_ratings WHERE subtask_id = $1", [done[0]]))[0].n).toBe(2);
    expect(await q("SELECT body FROM notifications WHERE user_id = $1 AND kind = 'rating_changed'", [u.emp])).toHaveLength(1);
  });

  it("send a 5 to the manager, who may validate it", async () => {
    const { ratingId } = await rateQuality(env.app, u.leadA!, { subtaskId: done[1]!, score: 5, evidenceUrls: ["https://git/pr/42"] });
    await expect(reviewQualityRating(env.app, u.leadA!, { ratingId, outcome: "validated" })).rejects.toThrow(/Only the team's manager/);
    await reviewQualityRating(env.app, u.manager!, { ratingId, outcome: "validated" });
    await rateQuality(env.app, u.leadA!, { subtaskId: done[2]!, score: 2, reason: "two acceptance criteria missed" });
  });
});

describe("collaboration", () => {
  it("is rated by the lead and teammates only, once each, with examples", async () => {
    await expect(rateCollaboration(env.app, u.emp!, { periodId: P, subjectId: u.emp!, score: 5, examples: "x" })).rejects.toThrow(/rate yourself/);
    await expect(rateCollaboration(env.app, u.emp3!, { periodId: P, subjectId: u.emp!, score: 5, examples: "x" })).rejects.toThrow(/lead or teammates/);
    await expect(rateCollaboration(env.app, u.emp2!, { periodId: P, subjectId: u.emp!, score: 5, examples: " " })).rejects.toThrow(/specific examples/);
    expect(await rateCollaboration(env.app, u.leadA!, { periodId: P, subjectId: u.emp!, score: 4, examples: "ran the handover" })).toEqual({ raterKind: "lead" });
    expect(await rateCollaboration(env.app, u.emp2!, { periodId: P, subjectId: u.emp!, score: 4, examples: "paired on tax rules" })).toEqual({ raterKind: "peer" });
    await expect(rateCollaboration(env.app, u.emp2!, { periodId: P, subjectId: u.emp!, score: 5, examples: "again" })).rejects.toThrow(/already rated/);
  });
});

describe("score job", () => {
  it("cannot be run by the app role", async () => {
    await expect(computeDrafts(env.app, u.system!, P)).rejects.toThrow(/permission denied/);
  });

  it("scores from records, marks thin signals insufficient, and hides peer identities", async () => {
    await computeDrafts(env.scoring, u.system!, P);
    const b = await scoreBreakdown(env.app, u.emp!, u.emp!, P);
    const sig = Object.fromEntries((b.signals as any[]).map((s) => [s.name, s]));
    expect(sig.delivery.value).toBe(100);
    expect(sig.timeliness.value).toBe(100);
    expect(sig.quality.value).toBeCloseTo(((4 + 5 + 2) / 3 - 1) / 4 * 100, 1);
    expect(sig.collaboration.status).toBe("insufficient_data"); // one peer so far
    expect(b.total).toBeCloseTo((0.4 * 100 + 0.3 * 100 + 0.2 * sig.quality.value) / 0.9, 1);
    expect(JSON.stringify(b)).not.toContain(u.emp2);

    await rateCollaboration(env.app, u.emp4!, { periodId: P, subjectId: u.emp!, score: 3, examples: "slow to answer reviews" });
    await computeDrafts(env.scoring, u.system!, P);
    const b2 = await scoreBreakdown(env.app, u.emp!, u.emp!, P);
    expect((b2.signals as any[]).find((s) => s.name === "collaboration").status).toBe("ok");
  });

  it("keeps credit with the first employee after reassignment", async () => {
    const { subtaskId } = await createSubtask(env.app, u.leadA!, sub({ assigneeId: u.emp2, points: 8, due: inDays(30) }));
    await setStatus(env.app, u.emp2!, { subtaskId, to: "in_progress" });
    const r = await reassign(env.app, u.leadA!, { subtaskId, assigneeId: u.emp!, reason: "emp2 on leave", creditToPrevious: 0.5 });
    await decideChangeRequest(env.app, u.manager!, { requestId: r.requestId!, approve: true, reason: "ok" });
    await computeDrafts(env.scoring, u.system!, P);
    const b = await scoreBreakdown(env.app, u.emp2!, u.emp2!, P);
    const line = (b.signals as any[]).find((s) => s.name === "delivery").tasks.find((x: any) => x.subtaskId === subtaskId);
    expect(line.detail).toMatchObject({ creditShare: 0.5, done: true });
  });

  it("shows a score only to the employee, their lead and manager, HR, admins and the owner", async () => {
    await expect(scoreBreakdown(env.app, u.emp2!, u.emp!, P)).rejects.toThrow(/cannot see/);
    await expect(scoreBreakdown(env.app, u.leadB!, u.emp!, P)).rejects.toThrow(/cannot see/);
    for (const k of ["leadA", "manager", "hr", "owner"]) await expect(scoreBreakdown(env.app, u[k]!, u.emp!, P)).resolves.toBeDefined();
  });
});

describe("quarter lock", () => {
  it("locks only after the period ends, then freezes scores and ratings", async () => {
    await expect(lockPeriod(env.scoring, u.system!, P, new Date("2026-12-31T12:00:00Z"))).rejects.toThrow(/only after it ends/);
    const { locked } = await lockPeriod(env.scoring, u.system!, P, new Date("2027-01-02T00:00:00Z"));
    expect(locked).toBe(4);
    expect((await scoreBreakdown(env.app, u.emp!, u.emp!, P)).status).toBe("locked");

    await expect(computeDrafts(env.scoring, u.system!, P)).rejects.toThrow(/locked/);
    const [latest] = await q("SELECT id FROM quality_rating_latest WHERE subtask_id = $1", [done[2]]);
    await expect(changeQualityRating(env.app, u.leadA!, { ratingId: latest.id, score: 3, changeReason: "softer" })).rejects.toThrow(/locked/);
    await expect(rateCollaboration(env.app, u.leadA!, { periodId: P, subjectId: u.emp2!, score: 3, examples: "x" })).rejects.toThrow(/locked/);
    await expect(env.admin.query("UPDATE score_snapshots SET total = 99")).rejects.toThrow(/append-only/);
    await expect(env.admin.query("UPDATE periods SET locked_at = NULL")).rejects.toThrow(/already set/);
  });

  it("leaves the audit chain intact", async () => {
    expect(await q("SELECT * FROM verify_audit_chain()")).toEqual([]);
  });
});
