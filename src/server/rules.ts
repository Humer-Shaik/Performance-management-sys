import { one, type Db } from "./db";
import { DEFAULT_RULES, type RuleSet } from "../scoring/types";

/** The approved rule version in force for a period, or the defaults if none is approved yet. */
export async function rulesFor(db: Db, periodId: string): Promise<{ id: string | null; rules: RuleSet }> {
  const row = await one<{ id: string; rules: RuleSet }>(
    db,
    `SELECT id, rules FROM scoring_rule_versions
     WHERE approved_at IS NOT NULL AND effective_from_period <= $1
     ORDER BY effective_from_period DESC, approved_at DESC LIMIT 1`,
    [periodId],
  );
  return row ? { id: row.id, rules: { ...DEFAULT_RULES, ...row.rules } } : { id: null, rules: DEFAULT_RULES };
}

export function periodOf(date: Date): string {
  return `${date.getUTCFullYear()}-Q${Math.floor(date.getUTCMonth() / 3) + 1}`;
}
