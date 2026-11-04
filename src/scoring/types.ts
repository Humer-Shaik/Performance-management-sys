export type SignalName = "delivery" | "timeliness" | "quality" | "collaboration";

export const EFFORT_SCALE = { very_low: 1, low: 2, medium: 3, high: 5, very_high: 8 } as const;
export type EffortPoints = (typeof EFFORT_SCALE)[keyof typeof EFFORT_SCALE];

/** One approved scoring rule version. Stored in scoring_rule_versions.rules. */
export interface RuleSet {
  version: string;
  weights: Record<SignalName, number>;
  /** Below these amounts a signal is "insufficient data", never zero. */
  minimums: {
    deliveryPoints: number;
    timelinessTasks: number;
    qualityRatings: number;
    collaborationPeers: number;
  };
}

export const DEFAULT_RULES: RuleSet = {
  version: "2026.1",
  weights: { delivery: 0.4, timeliness: 0.3, quality: 0.2, collaboration: 0.1 },
  minimums: { deliveryPoints: 5, timelinessTasks: 3, qualityRatings: 3, collaborationPeers: 2 },
};

export type SubtaskStatus = "not_started" | "in_progress" | "blocked" | "in_review" | "done";

export interface BlockerInput {
  id: string;
  type: "internal" | "external" | "employee_caused";
  raisedAt: string; // ISO timestamp
  resolvedAt?: string;
  /**
   * open_dispute: the lead disputed it and the manager has not decided yet.
   * rejected: the manager rejected it. Anything else counts as verified.
   */
  outcome: "acknowledged" | "upheld" | "unanswered" | "open_dispute" | "rejected";
}

export interface SubtaskInput {
  id: string;
  title: string;
  /** Current approved points (original kept elsewhere for display). */
  points: EffortPoints;
  originalPoints: EffortPoints;
  /** False when removed by an approved scope change. */
  inScope: boolean;
  status: SubtaskStatus;
  doneAt?: string;
  assignedAt: string;
  originalDue: string; // YYYY-MM-DD, end of day
  revisedDue: string; // approved current due date
  /** Share of this subtask's credit that belongs to this employee (reassignment splits it). */
  creditShare: number;
  blockers: BlockerInput[];
  /** Times reopened after Done while delivered by this employee. */
  reopenCount: number;
  /** Latest version of the lead's quality rating, if rated. */
  qualityRating?: { score: 1 | 2 | 3 | 4 | 5; ratingId: string };
}

export interface CollaborationInput {
  raterKind: "lead" | "peer";
  raterId: string;
  score: 1 | 2 | 3 | 4 | 5;
}

export interface ScoreInput {
  employeeId: string;
  periodId: string;
  periodEnd: string; // YYYY-MM-DD
  /** Moment the calculation is made; tasks not yet due at this time are skipped for timeliness. */
  asOf: string;
  subtasks: SubtaskInput[];
  collaboration: CollaborationInput[];
}

export interface TaskLine {
  subtaskId: string;
  title: string;
  counted: boolean;
  excludedReason?: string;
  detail: Record<string, unknown>;
}

export interface SignalResult {
  name: SignalName;
  weight: number;
  status: "ok" | "insufficient_data";
  /** 0-100 when ok. */
  value: number | null;
  /** Weight after scaling for insufficient signals. */
  effectiveWeight: number;
  explanation: string;
  tasks: TaskLine[];
}

export interface ScoreResult {
  employeeId: string;
  periodId: string;
  ruleVersion: string;
  /** Null only when every signal is insufficient. */
  total: number | null;
  signals: SignalResult[];
  inputsHash: string;
}
