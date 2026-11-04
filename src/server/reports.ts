// Lead and manager accountability reports. In version one these are plain
// reports with the plan's default thresholds highlighted. A flag is a
// question for HR and the owner, not a verdict.
import { many, one, type Db } from "./db";
import { forbid, notFound } from "./errors";
import { has, loadActor } from "./policy";

export interface Flag { measure: string; message: string }

export const THRESHOLDS = {
  workloadPct: 30, // assigned points more than 30% above or below the team average
  difficultyGap: 0.4, // share of high-complexity points differs from teammates by more than 40 points
  shortLeadRate: 0.2, // more than 20% of deadlines below the minimum lead time
  extensionConcentration: 0.5, // one person gets more than half of the extensions (3 or more in total)
  ratingVsCompany: 0.75,
  ratingVsTeammates: 1,
  blockerAckHours: 24,
  overturnRate: 0.3, // more than 30% of decided disputes overturned (2 or more decided)
};

const avg = (xs: number[]) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const r1 = (n: number) => Math.round(n * 10) / 10;

async function canSeeLead(db: Db, viewerId: string, leadId: string) {
  if (viewerId === leadId) return;
  const viewer = await loadActor(db, viewerId);
  if (has(viewer, "hr", "head_of_hr", "admin", "owner")) return;
  const manages = await one(db, "SELECT 1 FROM teams WHERE lead_id = $1 AND manager_id = $2", [leadId, viewerId]);
  if (!manages) forbid("You cannot see this accountability report");
}

export async function leadReport(db: Db, viewerId: string, leadId: string, periodId: string) {
  await canSeeLead(db, viewerId, leadId);
  const period = await one(db, "SELECT * FROM periods WHERE id = $1", [periodId]);
  if (!period) notFound("Period not found");
  const teams = await many(db, "SELECT id, name FROM teams WHERE lead_id = $1", [leadId]);
  const teamIds = teams.map((t) => t.id);
  const flags: Flag[] = [];
  const range = [period!.starts_on, period!.ends_on];

  // Workload and difficulty: points assigned per current team member this period.
  const members = await many(db, "SELECT DISTINCT m.user_id, u.name FROM team_members m JOIN users u ON u.id = m.user_id WHERE m.team_id = ANY($1) AND m.valid_to IS NULL", [teamIds]);
  const work = await many(db,
    `SELECT sc.assignee, sum(sc.points)::int AS points,
            sum(sc.points) FILTER (WHERE sc.points >= 5)::int AS high_points,
            sum(sc.points) FILTER (WHERE sc.points <= 2)::int AS low_points
     FROM subtask_current sc JOIN goal_current g ON g.id = sc.goal_id
     WHERE g.current_team_id = ANY($1) AND sc.in_scope AND sc.due BETWEEN $2 AND $3
     GROUP BY sc.assignee`, [teamIds, ...range]);
  const byUser = new Map(work.map((w) => [w.assignee, w]));
  const workload = members.map((m) => {
    const w = byUser.get(m.user_id);
    const points = w?.points ?? 0;
    return { userId: m.user_id, name: m.name, points, highShare: points ? (w?.high_points ?? 0) / points : 0, lowShare: points ? (w?.low_points ?? 0) / points : 0, vsTeamPct: 0 };
  });
  const teamAvg = avg(workload.map((w) => w.points));
  for (const w of workload) {
    const devPct = teamAvg ? ((w.points - teamAvg) / teamAvg) * 100 : 0;
    w.vsTeamPct = r1(devPct);
    if (teamAvg && Math.abs(devPct) > THRESHOLDS.workloadPct) {
      flags.push({ measure: "workload", message: `${w.name} has ${w.points} points, ${r1(Math.abs(devPct))}% ${devPct > 0 ? "above" : "below"} the team average` });
    }
    const others = workload.filter((x) => x.userId !== w.userId && x.points > 0);
    if (w.points > 0 && others.length) {
      const gap = w.highShare - avg(others.map((o) => o.highShare));
      if (Math.abs(gap) > THRESHOLDS.difficultyGap) {
        flags.push({ measure: "difficulty", message: `${w.name} gets mostly ${gap > 0 ? "high" : "low"}-complexity work compared with teammates` });
      }
    }
  }

  // Deadline fairness.
  const lead = await one(db,
    `SELECT count(*)::int AS total, count(*) FILTER (WHERE s.short_lead_reason IS NOT NULL)::int AS short
     FROM subtasks s WHERE s.created_by = $1 AND s.original_due BETWEEN $2 AND $3`, [leadId, ...range]);
  const shortRate = lead!.total ? lead!.short / lead!.total : 0;
  if (shortRate > THRESHOLDS.shortLeadRate) flags.push({ measure: "deadlines", message: `${Math.round(shortRate * 100)}% of deadlines were shorter than the minimum lead time` });
  const ext = await many(db,
    `SELECT sc.assignee, count(*)::int AS n FROM subtask_revisions r JOIN subtask_current sc ON sc.id = r.subtask_id
     WHERE r.field = 'due' AND r.changed_by = $1 AND r.changed_at::date BETWEEN $2 AND $3 GROUP BY sc.assignee`, [leadId, ...range]);
  const extTotal = ext.reduce((a, e) => a + e.n, 0);
  for (const e of ext) {
    if (extTotal >= 3 && e.n / extTotal > THRESHOLDS.extensionConcentration) {
      const name = members.find((m) => m.user_id === e.assignee)?.name ?? "one employee";
      flags.push({ measure: "deadlines", message: `${name} received ${e.n} of ${extTotal} deadline extensions` });
    }
  }

  // Rating spread.
  const company = await one(db, "SELECT avg(score)::float AS a FROM quality_rating_latest WHERE created_at::date BETWEEN $1 AND $2", range);
  const mine = await one(db, "SELECT avg(score)::float AS a, count(*)::int AS n FROM quality_rating_latest WHERE rater_id = $1 AND created_at::date BETWEEN $2 AND $3", [leadId, ...range]);
  if (mine!.n && company!.a !== null && Math.abs(mine!.a - company!.a) > THRESHOLDS.ratingVsCompany) {
    flags.push({ measure: "ratings", message: `Average rating ${r1(mine!.a)} vs company ${r1(company!.a)}` });
  }
  const perEmp = await many(db,
    `SELECT employee_id, avg(score)::float AS a FROM quality_rating_latest WHERE rater_id = $1 AND created_at::date BETWEEN $2 AND $3 GROUP BY employee_id`, [leadId, ...range]);
  for (const p of perEmp) {
    const others = perEmp.filter((o) => o.employee_id !== p.employee_id);
    if (others.length && avg(others.map((o) => o.a)) - p.a > THRESHOLDS.ratingVsTeammates) {
      const name = members.find((m) => m.user_id === p.employee_id)?.name ?? "one employee";
      flags.push({ measure: "ratings", message: `${name} averages ${r1(p.a)}, more than 1 point below teammates` });
    }
  }

  // Blocker handling.
  const blockers = await one(db,
    `SELECT count(*)::int AS total,
       count(*) FILTER (WHERE coalesce(b.answered_at, now()) - b.raised_at > make_interval(hours => $4))::int AS slow,
       count(*) FILTER (WHERE b.outcome = 'upheld' AND EXISTS (SELECT 1 FROM blocker_events e WHERE e.blocker_id = b.id AND e.kind = 'disputed' AND e.actor_id = $1))::int AS disputed_then_upheld
     FROM blocker_current b JOIN subtask_current sc ON sc.id = b.subtask_id JOIN goal_current g ON g.id = sc.goal_id
     WHERE g.current_team_id = ANY($5) AND b.raised_at::date BETWEEN $2 AND $3`, [leadId, ...range, THRESHOLDS.blockerAckHours, teamIds]);
  if (blockers!.slow) flags.push({ measure: "blockers", message: `${blockers!.slow} blockers waited more than 1 working day to be answered` });
  if (blockers!.disputed_then_upheld) flags.push({ measure: "blockers", message: `${blockers!.disputed_then_upheld} blockers the lead disputed were upheld by the manager` });

  // Dispute record.
  const disputes = await one(db, "SELECT decided::int, overturned::int, overturn_pct::float FROM dispute_overturn_rates WHERE user_id = $1", [leadId]);
  if (disputes && disputes.decided >= 2 && disputes.overturned / disputes.decided > THRESHOLDS.overturnRate) {
    flags.push({ measure: "disputes", message: `${disputes.overturned} of ${disputes.decided} disputed decisions were overturned` });
  }

  // Goal delivery: finished late, or transferred away while late.
  const goals = await many(db,
    `SELECT g.id, g.title, a.deadline, a.ended_at, a.overdue_at_transfer,
       (SELECT max(d.done_at) FROM subtask_done_at d JOIN subtask_current sc ON sc.id = d.id WHERE sc.goal_id = g.id) AS finished_at,
       NOT EXISTS (SELECT 1 FROM subtask_current sc WHERE sc.goal_id = g.id AND sc.in_scope AND sc.status <> 'done') AS complete
     FROM goal_assignments a JOIN goals g ON g.id = a.goal_id
     WHERE a.team_id = ANY($1) AND a.deadline BETWEEN $2 AND $3`, [teamIds, ...range]);
  const late = goals.filter((g) => g.overdue_at_transfer || (g.complete && g.finished_at && g.finished_at.toISOString().slice(0, 10) > g.deadline));
  for (const g of late) flags.push({ measure: "goals", message: `"${g.title}" ${g.overdue_at_transfer ? "was transferred away while late" : "finished late"}` });

  return {
    leadId, periodId, teams,
    workload,
    deadlines: { subtasks: lead!.total, shortLead: lead!.short, extensions: ext },
    ratings: { average: mine!.n ? r1(mine!.a) : null, companyAverage: company!.a === null ? null : r1(company!.a), count: mine!.n },
    blockers: blockers!,
    disputes: disputes ?? { decided: 0, overturned: 0, overturn_pct: null },
    goals: { total: goals.length, late: late.length },
    flags,
  };
}

/** A manager's report: each of their leads' reports, plus their own pending work. */
export async function managerReport(db: Db, viewerId: string, managerId: string, periodId: string) {
  const viewer = await loadActor(db, viewerId);
  if (viewerId !== managerId && !has(viewer, "hr", "head_of_hr", "admin", "owner")) forbid("You cannot see this report");
  const leads = await many<{ lead_id: string }>(db, "SELECT DISTINCT lead_id FROM teams WHERE manager_id = $1", [managerId]);
  const pendingApprovals = await one(db, "SELECT count(*)::int AS n FROM change_request_current r WHERE r.status = 'pending' AND r.approver_id = $1", [managerId]);
  const pendingDisputes = await one(db, "SELECT count(*)::int AS n FROM dispute_current WHERE state = 'open' AND reviewer_id = $1", [managerId]);
  const overdueDisputes = await one(db, "SELECT count(*)::int AS n FROM dispute_current WHERE state = 'open' AND reviewer_id = $1 AND due_at < now()", [managerId]);
  const flags: Flag[] = [];
  if (overdueDisputes!.n) flags.push({ measure: "disputes", message: `${overdueDisputes!.n} disputes are past their decision date` });
  return {
    managerId, periodId,
    pending: { approvals: pendingApprovals!.n, disputes: pendingDisputes!.n },
    leads: await Promise.all(leads.map((l) => leadReport(db, viewerId, l.lead_id, periodId))),
    flags,
  };
}
