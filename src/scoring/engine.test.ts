import { describe, expect, it } from "vitest";
import { computeScore, excludedBlockerMs } from "./engine";
import { DEFAULT_RULES, type ScoreInput, type SubtaskInput } from "./types";

const task = (over: Partial<SubtaskInput> & { id: string }): SubtaskInput => ({
  title: over.id,
  points: 3,
  originalPoints: 3,
  inScope: true,
  status: "done",
  doneAt: "2026-11-10T12:00:00Z",
  assignedAt: "2026-10-01T09:00:00Z",
  originalDue: "2026-11-10",
  revisedDue: "2026-11-10",
  creditShare: 1,
  blockers: [],
  reopenCount: 0,
  qualityRating: { score: 3, ratingId: `r-${over.id}` },
  ...over,
});

const base = (over: Partial<ScoreInput> = {}): ScoreInput => ({
  employeeId: "emp",
  periodId: "2026-Q4",
  periodEnd: "2026-12-31",
  asOf: "2026-12-31T23:00:00Z",
  subtasks: [task({ id: "a" }), task({ id: "b" }), task({ id: "c" })],
  collaboration: [
    { raterKind: "lead", raterId: "lead", score: 4 },
    { raterKind: "peer", raterId: "p1", score: 4 },
    { raterKind: "peer", raterId: "p2", score: 4 },
  ],
  ...over,
});

const signal = (r: ReturnType<typeof computeScore>, name: string) => r.signals.find((s) => s.name === name)!;

describe("computeScore", () => {
  it("combines the four signals with the plan's weights", () => {
    const r = computeScore(base(), DEFAULT_RULES);
    // delivery 100, timeliness 100, quality 3/5 -> 50, collaboration 4/5 -> 75
    expect(signal(r, "delivery").value).toBe(100);
    expect(signal(r, "timeliness").value).toBe(100);
    expect(signal(r, "quality").value).toBe(50);
    expect(signal(r, "collaboration").value).toBe(75);
    expect(r.total).toBe(0.4 * 100 + 0.3 * 100 + 0.2 * 50 + 0.1 * 75);
  });

  it("is deterministic and hashes its inputs", () => {
    const a = computeScore(base(), DEFAULT_RULES);
    const b = computeScore(base(), DEFAULT_RULES);
    expect(a).toEqual(b);
    expect(a.inputsHash).toMatch(/^[0-9a-f]{64}$/);
    const c = computeScore(base({ asOf: "2026-12-30T00:00:00Z" }), DEFAULT_RULES);
    expect(c.inputsHash).not.toBe(a.inputsHash);
  });

  it("marks thin signals insufficient and scales the other weights instead of scoring zero", () => {
    const r = computeScore(base({ collaboration: [{ raterKind: "lead", raterId: "lead", score: 1 }] }), DEFAULT_RULES);
    const collab = signal(r, "collaboration");
    expect(collab.status).toBe("insufficient_data");
    expect(collab.value).toBeNull();
    // remaining weights 0.4 + 0.3 + 0.2 = 0.9
    expect(r.total).toBeCloseTo((0.4 * 100 + 0.3 * 100 + 0.2 * 50) / 0.9, 2);
    expect(signal(r, "delivery").effectiveWeight).toBeCloseTo(0.44, 2);
  });

  it("returns no total when nothing can be measured", () => {
    const r = computeScore(base({ subtasks: [], collaboration: [] }), DEFAULT_RULES);
    expect(r.total).toBeNull();
    expect(r.signals.every((s) => s.status === "insufficient_data")).toBe(true);
  });

  it("does not hold work removed by a scope change against the employee", () => {
    const r = computeScore(
      base({ subtasks: [task({ id: "a" }), task({ id: "b" }), task({ id: "x", status: "in_progress", inScope: false, doneAt: undefined })] }),
      DEFAULT_RULES,
    );
    const d = signal(r, "delivery");
    expect(d.value).toBe(100);
    expect(d.tasks.find((t) => t.subtaskId === "x")).toMatchObject({ counted: false, excludedReason: "removed by approved scope change" });
  });

  it("keeps credit with the first employee after a reassignment", () => {
    const r = computeScore(base({ subtasks: [task({ id: "a", points: 8, creditShare: 0.5 }), task({ id: "b", points: 2 })] }), DEFAULT_RULES);
    expect(signal(r, "delivery").explanation).toBe("6 of 6 approved points done");
  });

  it("measures timeliness against both deadlines and scores the approved one", () => {
    const r = computeScore(
      base({
        subtasks: [
          task({ id: "a", originalDue: "2026-11-05", revisedDue: "2026-11-12" }), // late vs original, on time vs revised
          task({ id: "b" }),
          task({ id: "c", doneAt: "2026-11-15T09:00:00Z" }), // late
        ],
      }),
      DEFAULT_RULES,
    );
    const t = signal(r, "timeliness");
    expect(t.value).toBeCloseTo(66.67, 2);
    expect(t.explanation).toBe("2 of 3 on time against the approved deadline (1 of 3 against the original)");
    expect(t.tasks[0]!.detail).toMatchObject({ onTimeAgainstOriginal: false, onTimeAgainstRevised: true });
  });

  it("excludes verified blocker time but not employee-caused or rejected blockers", () => {
    const late = (blockerType: "external" | "employee_caused", outcome: "acknowledged" | "rejected") =>
      task({
        id: `${blockerType}-${outcome}`,
        doneAt: "2026-11-12T12:00:00Z", // 2 days late
        blockers: [{ id: "b1", type: blockerType, outcome, raisedAt: "2026-11-01T12:00:00Z", resolvedAt: "2026-11-04T12:00:00Z" }],
      });
    const run = (t: SubtaskInput) => signal(computeScore(base({ subtasks: [t, task({ id: "y" }), task({ id: "z" })] }), DEFAULT_RULES), "timeliness");
    expect(run(late("external", "acknowledged")).value).toBe(100);
    expect(run(late("employee_caused", "acknowledged")).value).toBeCloseTo(66.67, 2);
    expect(run(late("external", "rejected")).value).toBeCloseTo(66.67, 2);
  });

  it("counts overdue unfinished work as late and skips work not yet due", () => {
    const r = computeScore(
      base({
        asOf: "2026-11-20T00:00:00Z",
        subtasks: [
          task({ id: "a" }),
          task({ id: "b" }),
          task({ id: "late", status: "in_progress", doneAt: undefined, revisedDue: "2026-11-15" }),
          task({ id: "future", status: "in_progress", doneAt: undefined, revisedDue: "2026-12-15" }),
        ],
      }),
      DEFAULT_RULES,
    );
    const t = signal(r, "timeliness");
    expect(t.value).toBeCloseTo(66.67, 2);
    expect(t.tasks.find((x) => x.subtaskId === "future")?.excludedReason).toBe("not done and not yet due");
  });

  it("counts each reopen as a rating of 1 for the deliverer", () => {
    const r = computeScore(base({ subtasks: [task({ id: "a", qualityRating: { score: 5, ratingId: "r" }, reopenCount: 1 }), task({ id: "b" })] }), DEFAULT_RULES);
    // ratings 5, 1, 3 -> avg 3 -> 50
    expect(signal(r, "quality").value).toBe(50);
  });

  it("does not reveal individual peer ratings", () => {
    const r = computeScore(base(), DEFAULT_RULES);
    expect(JSON.stringify(signal(r, "collaboration"))).not.toContain("p1");
  });

  it("rejects rule sets whose weights do not sum to 1", () => {
    expect(() => computeScore(base(), { ...DEFAULT_RULES, weights: { delivery: 0.5, timeliness: 0.3, quality: 0.2, collaboration: 0.1 } })).toThrow(/sum to 1/);
  });
});

describe("excludedBlockerMs", () => {
  it("merges overlapping blockers so the same time is not excluded twice", () => {
    const r = excludedBlockerMs(
      [
        { id: "1", type: "external", outcome: "acknowledged", raisedAt: "2026-11-01T00:00:00Z", resolvedAt: "2026-11-03T00:00:00Z" },
        { id: "2", type: "internal", outcome: "upheld", raisedAt: "2026-11-02T00:00:00Z", resolvedAt: "2026-11-04T00:00:00Z" },
        { id: "3", type: "external", outcome: "open_dispute", raisedAt: "2026-11-10T00:00:00Z", resolvedAt: "2026-11-11T00:00:00Z" },
      ],
      Date.parse("2026-12-01T00:00:00Z"),
    );
    expect(r.ms).toBe(3 * 86_400_000);
    expect(r.ignored).toEqual([{ id: "3", why: "dispute awaiting manager decision" }]);
  });
});
