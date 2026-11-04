// The scoring engine: a pure function of recorded inputs and one rule version.
// Same inputs always give the same score, and every number comes with the list
// of tasks that fed it and the reason any task was left out.
import { createHash } from "node:crypto";
import type {
  BlockerInput,
  RuleSet,
  ScoreInput,
  ScoreResult,
  SignalName,
  SignalResult,
  SubtaskInput,
  TaskLine,
} from "./types";

const DAY_MS = 86_400_000;
const REASSIGNED = "reassigned before it was finished; your share counts for delivery only";
const round2 = (n: number) => Math.round(n * 100) / 100;
/** Maps a 1-5 rating to 0-100. */
const ratingTo100 = (avg: number) => ((avg - 1) / 4) * 100;
/** A due date counts until the end of that day (UTC). */
const endOfDay = (date: string) => Date.parse(`${date}T23:59:59.999Z`);

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Blocked time that does not count against the employee: blockers the employee
 * did not cause, that were not rejected and whose dispute is not still open.
 * Overlapping blockers are merged so the same hours are not excluded twice.
 */
export function excludedBlockerMs(blockers: BlockerInput[], until: number): { ms: number; used: string[]; ignored: { id: string; why: string }[] } {
  const used: string[] = [];
  const ignored: { id: string; why: string }[] = [];
  const intervals: [number, number][] = [];
  for (const b of blockers) {
    if (b.type === "employee_caused") { ignored.push({ id: b.id, why: "employee-caused" }); continue; }
    if (b.outcome === "rejected") { ignored.push({ id: b.id, why: "rejected by manager" }); continue; }
    if (b.outcome === "open_dispute") { ignored.push({ id: b.id, why: "dispute awaiting manager decision" }); continue; }
    const start = Date.parse(b.raisedAt);
    const end = Math.min(b.resolvedAt ? Date.parse(b.resolvedAt) : until, until);
    if (end > start) { intervals.push([start, end]); used.push(b.id); }
  }
  intervals.sort((a, b) => a[0] - b[0]);
  let ms = 0;
  let cur: [number, number] | undefined;
  for (const iv of intervals) {
    if (cur && iv[0] <= cur[1]) cur[1] = Math.max(cur[1], iv[1]);
    else { if (cur) ms += cur[1] - cur[0]; cur = [iv[0], iv[1]]; }
  }
  if (cur) ms += cur[1] - cur[0];
  return { ms, used, ignored };
}

function delivery(input: ScoreInput, rules: RuleSet): Omit<SignalResult, "weight" | "effectiveWeight"> {
  let assigned = 0;
  let done = 0;
  const tasks: TaskLine[] = input.subtasks.map((t) => {
    if (!t.inScope) return { subtaskId: t.id, title: t.title, counted: false, excludedReason: "removed by approved scope change", detail: {} };
    const pts = t.points * t.creditShare;
    assigned += pts;
    // A share kept after reassignment is credit for work already done.
    const isDone = t.status === "done" || t.deliveredBy === false;
    if (isDone) done += pts;
    return { subtaskId: t.id, title: t.title, counted: true, detail: { points: t.points, originalPoints: t.originalPoints, creditShare: t.creditShare, done: isDone } };
  });
  if (assigned < rules.minimums.deliveryPoints) {
    return { name: "delivery", status: "insufficient_data", value: null, tasks, explanation: `${round2(assigned)} points assigned; at least ${rules.minimums.deliveryPoints} needed` };
  }
  return { name: "delivery", status: "ok", value: round2((done / assigned) * 100), tasks, explanation: `${round2(done)} of ${round2(assigned)} approved points done` };
}

function timeliness(input: ScoreInput, rules: RuleSet): Omit<SignalResult, "weight" | "effectiveWeight"> {
  const asOf = Date.parse(input.asOf);
  const periodEnd = endOfDay(input.periodEnd);
  const cutoff = Math.min(asOf, periodEnd);
  let measured = 0;
  let onTimeRevised = 0;
  let onTimeOriginal = 0;
  const tasks: TaskLine[] = input.subtasks.map((t: SubtaskInput) => {
    const base = { subtaskId: t.id, title: t.title };
    if (!t.inScope) return { ...base, counted: false, excludedReason: "removed by approved scope change", detail: {} };
    if (t.deliveredBy === false) return { ...base, counted: false, excludedReason: REASSIGNED, detail: {} };
    const finishedAt = t.status === "done" && t.doneAt ? Date.parse(t.doneAt) : undefined;
    const revisedDue = endOfDay(t.revisedDue);
    const originalDue = endOfDay(t.originalDue);
    if (finishedAt === undefined && revisedDue >= cutoff) {
      return { ...base, counted: false, excludedReason: "not done and not yet due", detail: { revisedDue: t.revisedDue } };
    }
    const end = finishedAt ?? cutoff;
    const blocked = excludedBlockerMs(t.blockers, end);
    const allowance = blocked.ms;
    const revisedOk = finishedAt !== undefined && finishedAt <= revisedDue + allowance;
    const originalOk = finishedAt !== undefined && finishedAt <= originalDue + allowance;
    measured += 1;
    if (revisedOk) onTimeRevised += 1;
    if (originalOk) onTimeOriginal += 1;
    return {
      ...base,
      counted: true,
      detail: {
        assignedAt: t.assignedAt,
        originalDue: t.originalDue,
        revisedDue: t.revisedDue,
        doneAt: t.doneAt ?? null,
        excludedBlockedDays: round2(allowance / DAY_MS),
        blockersExcluded: blocked.used,
        blockersNotExcluded: blocked.ignored,
        onTimeAgainstRevised: revisedOk,
        onTimeAgainstOriginal: originalOk,
      },
    };
  });
  if (measured < rules.minimums.timelinessTasks) {
    return { name: "timeliness", status: "insufficient_data", value: null, tasks, explanation: `${measured} subtasks due; at least ${rules.minimums.timelinessTasks} needed` };
  }
  return {
    name: "timeliness",
    status: "ok",
    value: round2((onTimeRevised / measured) * 100),
    tasks,
    explanation: `${onTimeRevised} of ${measured} on time against the approved deadline (${onTimeOriginal} of ${measured} against the original)`,
  };
}

function quality(input: ScoreInput, rules: RuleSet): Omit<SignalResult, "weight" | "effectiveWeight"> {
  const scores: number[] = [];
  const tasks: TaskLine[] = input.subtasks.map((t) => {
    const base = { subtaskId: t.id, title: t.title };
    if (t.deliveredBy === false) return { ...base, counted: false, excludedReason: REASSIGNED, detail: {} };
    if (t.status !== "done" && t.reopenCount === 0) return { ...base, counted: false, excludedReason: "not done", detail: {} };
    const reopens = Array<number>(t.reopenCount).fill(1);
    if (!t.qualityRating && reopens.length === 0) return { ...base, counted: false, excludedReason: "not rated yet", detail: {} };
    if (t.qualityRating) scores.push(t.qualityRating.score);
    scores.push(...reopens);
    return { ...base, counted: true, detail: { rating: t.qualityRating?.score ?? null, ratingId: t.qualityRating?.ratingId ?? null, reopensCountedAsOne: t.reopenCount } };
  });
  if (scores.length < rules.minimums.qualityRatings) {
    return { name: "quality", status: "insufficient_data", value: null, tasks, explanation: `${scores.length} ratings; at least ${rules.minimums.qualityRatings} needed` };
  }
  const avg = scores.reduce((a, b) => a + b, 0) / scores.length;
  return { name: "quality", status: "ok", value: round2(ratingTo100(avg)), tasks, explanation: `average rating ${round2(avg)} of 5 over ${scores.length} ratings, reopens counted as 1` };
}

function collaboration(input: ScoreInput, rules: RuleSet): Omit<SignalResult, "weight" | "effectiveWeight"> {
  const leads = input.collaboration.filter((c) => c.raterKind === "lead");
  const peers = input.collaboration.filter((c) => c.raterKind === "peer");
  // Peer input is confidential: the breakdown shows counts, not who rated what.
  const tasks: TaskLine[] = [];
  if (leads.length === 0 || peers.length < rules.minimums.collaborationPeers) {
    return {
      name: "collaboration",
      status: "insufficient_data",
      value: null,
      tasks,
      explanation: `${leads.length} lead and ${peers.length} peer ratings; needs the lead and at least ${rules.minimums.collaborationPeers} peers`,
    };
  }
  const all = [...leads, ...peers];
  const avg = all.reduce((a, c) => a + c.score, 0) / all.length;
  return { name: "collaboration", status: "ok", value: round2(ratingTo100(avg)), tasks, explanation: `average ${round2(avg)} of 5 from the lead and ${peers.length} peers` };
}

export function computeScore(input: ScoreInput, rules: RuleSet): ScoreResult {
  const weightSum = Object.values(rules.weights).reduce((a, b) => a + b, 0);
  if (Math.abs(weightSum - 1) > 1e-9) throw new Error(`Rule ${rules.version}: weights must sum to 1, got ${weightSum}`);
  for (const t of input.subtasks) {
    if (t.creditShare < 0 || t.creditShare > 1) throw new Error(`Subtask ${t.id}: creditShare must be between 0 and 1`);
  }

  const raw = [delivery(input, rules), timeliness(input, rules), quality(input, rules), collaboration(input, rules)];
  const validWeight = raw.filter((s) => s.status === "ok").reduce((a, s) => a + rules.weights[s.name as SignalName], 0);
  const signals: SignalResult[] = raw.map((s) => {
    const weight = rules.weights[s.name];
    return { ...s, weight, effectiveWeight: s.status === "ok" && validWeight > 0 ? round2(weight / validWeight) : 0 };
  });
  const total =
    validWeight === 0
      ? null
      : round2(signals.reduce((a, s) => a + (s.status === "ok" ? (s.value as number) * (rules.weights[s.name] / validWeight) : 0), 0));

  const inputsHash = createHash("sha256").update(canonicalJson({ input, rules })).digest("hex");
  return { employeeId: input.employeeId, periodId: input.periodId, ruleVersion: rules.version, total, signals, inputsHash };
}
