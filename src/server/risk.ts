// Risk job: compares the share of time used with the share of work done for
// every open goal. Short goals are checked daily, long ones weekly. A change
// of level is logged and the right people are told.
import type pg from "pg";
import { checkCadence, goalRisk, riskRecipients } from "../domain/progress";
import { many, one, withActor } from "./db";
import { goalState } from "./goals";
import { notify, ownerIds } from "./notify";

const LABEL = { on_track: "on track", at_risk: "at risk", critical: "critical", overdue: "overdue", done: "done" } as const;

export async function checkRisks(pool: pg.Pool, systemUserId: string, now = new Date()) {
  return withActor(pool, systemUserId, "risk check", async (db) => {
    const goals = await many(db, "SELECT g.*, t.lead_id, t.manager_id FROM goal_current g JOIN teams t ON t.id = g.current_team_id");
    const changes: { goalId: string; from: string | null; to: string }[] = [];
    for (const g of goals) {
      const last = await one(db, "SELECT level, checked_at, assignment_id FROM goal_risk_current WHERE goal_id = $1", [g.id]);
      if (last?.level === "done" && last.assignment_id === g.assignment_id) continue;
      const cadenceMs = checkCadence(g.team_assigned_at.toISOString(), g.current_deadline) === "daily" ? 86_400_000 : 7 * 86_400_000;
      const sameAssignment = last && last.assignment_id === g.assignment_id;
      if (sameAssignment && now.getTime() - last.checked_at.getTime() < cadenceMs - 60_000) continue;

      const { progress } = await goalState(db, g.id);
      const risk = goalRisk({ startedAt: g.team_assigned_at.toISOString(), deadline: g.current_deadline, now: now.toISOString(),
        workPct: progress.barPct, complete: progress.complete });
      const changed = !sameAssignment || last.level !== risk.level;
      await db.query(
        "INSERT INTO risk_checks (goal_id, assignment_id, level, time_pct, work_pct, changed, checked_at) VALUES ($1, $2, $3, $4, $5, $6, $7)",
        [g.id, g.assignment_id, risk.level, Math.round(risk.timePct * 10) / 10, progress.barPct, changed, now.toISOString()]);
      if (!changed) continue;
      changes.push({ goalId: g.id, from: sameAssignment ? last.level : null, to: risk.level });
      const roles = riskRecipients(risk.level, g.priority === "high");
      const to = [
        ...(roles.includes("team_lead") ? [g.lead_id] : []),
        ...(roles.includes("manager") ? [g.manager_id] : []),
        ...(roles.includes("owner") ? await ownerIds(db) : []),
      ];
      await notify(db, to, `goal_${risk.level}`, "goal", g.id,
        `"${g.title}" is ${LABEL[risk.level]}: ${progress.barPct}% done with ${Math.round(risk.timePct)}% of the time used`);
    }
    return { changes };
  });
}
