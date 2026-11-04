import { describe, expect, it } from "vitest";
import { checkCadence, goalProgress, goalRisk, riskRecipients } from "./progress";

describe("goalProgress", () => {
  it("weights by effort and status", () => {
    const p = goalProgress([
      { points: 8, status: "done", inScope: true },
      { points: 5, status: "in_progress", inScope: true },
      { points: 2, status: "in_review", inScope: true },
      { points: 3, status: "not_started", inScope: false },
    ]);
    // bar = (8 + 2.5 + 1.8) / 15
    expect(p.barPct).toBe(82);
    expect(p.donePct).toBeCloseTo(53.3, 1);
    expect(p.complete).toBe(false);
  });
  it("is complete when every in-scope subtask is done", () => {
    expect(goalProgress([{ points: 3, status: "done", inScope: true }]).complete).toBe(true);
  });
});

describe("goalRisk", () => {
  const start = "2026-11-01T00:00:00Z";
  const deadline = "2026-11-10"; // 10 days
  const at = (day: number) => new Date(Date.parse(start) + day * 86_400_000).toISOString();

  it("is on track within 10 points", () => {
    expect(goalRisk({ startedAt: start, deadline, now: at(5), workPct: 41, complete: false }).level).toBe("on_track");
  });
  it("is at risk more than 10 points behind", () => {
    expect(goalRisk({ startedAt: start, deadline, now: at(5), workPct: 35, complete: false }).level).toBe("at_risk");
  });
  it("is critical more than 25 points behind", () => {
    expect(goalRisk({ startedAt: start, deadline, now: at(5), workPct: 20, complete: false }).level).toBe("critical");
  });
  it("is critical under 70% done with 20% of time left", () => {
    expect(goalRisk({ startedAt: start, deadline, now: at(8.2), workPct: 69, complete: false }).level).toBe("critical");
  });
  it("is overdue past the deadline and tells the owner for high priority", () => {
    const r = goalRisk({ startedAt: start, deadline, now: at(11), workPct: 95, complete: false });
    expect(r.level).toBe("overdue");
    expect(riskRecipients(r.level, true)).toContain("owner");
    expect(riskRecipients(r.level, false)).not.toContain("owner");
  });
});

describe("checkCadence", () => {
  it("checks short goals daily and long goals weekly", () => {
    expect(checkCadence("2026-11-01T00:00:00Z", "2026-11-05")).toBe("daily");
    expect(checkCadence("2026-11-01T00:00:00Z", "2026-12-15")).toBe("weekly");
  });
});
