// Team progress and deadline risk, as defined in the plan.
import type { EffortPoints, SubtaskStatus } from "../scoring/types";

/** Weights for the progress bar. Scores use Done only. */
export const PROGRESS_WEIGHT: Record<SubtaskStatus, number> = {
  not_started: 0,
  in_progress: 0.5,
  blocked: 0.5,
  in_review: 0.9,
  done: 1,
};

export interface ProgressTask {
  points: EffortPoints;
  status: SubtaskStatus;
  inScope: boolean;
}

export function goalProgress(tasks: ProgressTask[]) {
  const scope = tasks.filter((t) => t.inScope);
  const total = scope.reduce((a, t) => a + t.points, 0);
  if (total === 0) return { total: 0, barPct: 0, donePct: 0, complete: false };
  const bar = scope.reduce((a, t) => a + t.points * PROGRESS_WEIGHT[t.status], 0);
  const done = scope.filter((t) => t.status === "done").reduce((a, t) => a + t.points, 0);
  return {
    total,
    barPct: Math.round((bar / total) * 1000) / 10,
    donePct: Math.round((done / total) * 1000) / 10,
    complete: scope.every((t) => t.status === "done"),
  };
}

export type RiskLevel = "on_track" | "at_risk" | "critical" | "overdue" | "done";

export interface RiskInput {
  startedAt: string; // when the team was assigned the goal
  deadline: string; // YYYY-MM-DD, end of day
  now: string;
  /** Share of work done, 0-100, from goalProgress().barPct. */
  workPct: number;
  complete: boolean;
}

/**
 * Compares the share of time used with the share of work done.
 * On track: within 10 points or ahead. At risk: more than 10 behind.
 * Critical: more than 25 behind, or under 70% done with 20% of time left.
 */
export function goalRisk(r: RiskInput): { level: RiskLevel; timePct: number; gap: number } {
  const start = Date.parse(r.startedAt);
  const end = Date.parse(`${r.deadline}T23:59:59.999Z`);
  const now = Date.parse(r.now);
  const timePct = Math.min(100, Math.max(0, ((now - start) / (end - start)) * 100));
  const gap = Math.round((timePct - r.workPct) * 10) / 10;
  if (r.complete) return { level: "done", timePct, gap };
  if (now > end) return { level: "overdue", timePct, gap };
  if (gap > 25 || (r.workPct < 70 && timePct >= 80)) return { level: "critical", timePct, gap };
  if (gap > 10) return { level: "at_risk", timePct, gap };
  return { level: "on_track", timePct, gap };
}

/** Who is told at each level. */
export function riskRecipients(level: RiskLevel, highPriority: boolean): ("team_lead" | "manager" | "owner")[] {
  switch (level) {
    case "at_risk": return ["team_lead"];
    case "critical": return ["team_lead", "manager"];
    case "overdue": return highPriority ? ["team_lead", "manager", "owner"] : ["team_lead", "manager"];
    default: return [];
  }
}

/** Goals of 30 days or less are checked daily, longer ones weekly. */
export function checkCadence(startedAt: string, deadline: string): "daily" | "weekly" {
  const days = (Date.parse(`${deadline}T23:59:59.999Z`) - Date.parse(startedAt)) / 86_400_000;
  return days <= 30 ? "daily" : "weekly";
}
