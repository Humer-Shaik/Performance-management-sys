// Demo data: the plan's two example goals with a small org, created through
// the same commands the app uses, so the audit log is real.
import "./env";
import pg from "pg";
import "../src/server/db";
import { createGoal } from "../src/server/goals";
import { createSubtask, setStatus, extendDeadline } from "../src/server/subtasks";
import { raiseBlocker } from "../src/server/blockers";
import { rateCollaboration, rateQuality } from "../src/server/ratings";
import { computeDrafts, openPeriod } from "../src/server/scoring";
import { checkRisks } from "../src/server/risk";

const owner = new pg.Client({ connectionString: process.env.OWNER_DATABASE_URL });
const app = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const scoring = new pg.Pool({ connectionString: process.env.SCORING_DATABASE_URL });
await owner.connect();

const u: Record<string, string> = {};
const t: Record<string, string> = {};
await owner.query("BEGIN");
await owner.query("SELECT set_config('app.actor_id', '00000000-0000-0000-0000-000000000000', true), set_config('app.reason', 'demo seed', true)");
if ((await owner.query("SELECT 1 FROM users LIMIT 1")).rowCount) { console.error("Database already has users; seed only an empty database."); process.exit(1); }
const people: [string, string, string[]][] = [
  ["owner", "Olivia Owner", ["owner"]], ["manager", "Marcus Manager", ["manager"]], ["hr", "Hana HR", ["hr"]], ["headhr", "Henry Head of HR", ["head_of_hr"]],
  ["leadA", "Lena Lead (Team A)", ["team_lead"]], ["leadB", "Liam Lead (Team B)", ["team_lead"]],
  ["a1", "Ava", ["employee"]], ["a2", "Ben", ["employee"]], ["a3", "Chen", ["employee"]], ["b1", "Dana", ["employee"]], ["b2", "Eli", ["employee"]],
  ["system", "System jobs", []],
];
for (const [k, name, roles] of people) {
  u[k] = (await owner.query("INSERT INTO users (email, name) VALUES ($1, $2) RETURNING id", [`${k}@example.com`.replace("system@", "system@"), name])).rows[0].id;
  for (const r of roles) await owner.query("INSERT INTO user_roles (user_id, role, reason) VALUES ($1, $2, 'demo seed')", [u[k], r]);
}
await owner.query("UPDATE users SET email = 'system@jobs.local' WHERE id = $1", [u.system]);
t.A = (await owner.query("INSERT INTO teams (name, lead_id, manager_id) VALUES ('Team A', $1, $2) RETURNING id", [u.leadA, u.manager])).rows[0].id;
t.B = (await owner.query("INSERT INTO teams (name, lead_id, manager_id) VALUES ('Team B', $1, $2) RETURNING id", [u.leadB, u.manager])).rows[0].id;
for (const [team, k] of [["A", "a1"], ["A", "a2"], ["A", "a3"], ["B", "b1"], ["B", "b2"]]) await owner.query("INSERT INTO team_members (team_id, user_id) VALUES ($1, $2)", [t[team!], u[k!]]);
await owner.query("COMMIT");
await owner.end();

const day = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);
const now = new Date();
const q = Math.floor(now.getUTCMonth() / 3);
const y = now.getUTCFullYear();
await openPeriod(app, u.hr!, { id: `${y}-Q${q + 1}`, startsOn: new Date(Date.UTC(y, q * 3, 1)).toISOString().slice(0, 10), endsOn: new Date(Date.UTC(y, q * 3 + 3, 0)).toISOString().slice(0, 10) });

const payroll = (await createGoal(app, u.manager!, { title: "Finish the payroll module", teamId: t.A!, deadline: day(45), priority: "high" })).goalId;
const ui = (await createGoal(app, u.manager!, { title: "Fix the UI", teamId: t.B!, deadline: day(5) })).goalId;

const st = async (lead: string, goalId: string, title: string, points: number, due: number, who: string, extra = {}) =>
  (await createSubtask(app, u[lead]!, { goalId, title, acceptanceCriteria: `${title}: reviewed and tested`, points, due: day(due), assigneeId: u[who]!, ...extra })).subtaskId;
const tax = await st("leadA", payroll, "Tax tables", 5, 15, "a1");
const slips = await st("leadA", payroll, "Payslip PDF", 3, 20, "a2");
const bank = await st("leadA", payroll, "Bank export file", 5, 25, "a1");
const audit = await st("leadA", payroll, "Payroll audit report", 2, 30, "a3");
const nav = await st("leadB", ui, "Fix navigation on mobile", 2, 3, "b1");
const forms = await st("leadB", ui, "Form validation messages", 3, 4, "b2", { shortLeadReason: "Release on Friday" });

const go = async (who: string, id: string, ...to: string[]) => { for (const s of to) await setStatus(app, u[who]!, { subtaskId: id, to: s as never }); };
await go("a1", tax, "in_progress", "in_review"); await go("leadA", tax, "done");
await rateQuality(app, u.leadA!, { subtaskId: tax, score: 4, example: "Covered the 2026 bracket change before it was asked for" });
await go("a2", slips, "in_progress", "in_review"); await go("leadA", slips, "done");
await rateQuality(app, u.leadA!, { subtaskId: slips, score: 3 });
await go("a1", bank, "in_progress");
await raiseBlocker(app, u.a1!, { subtaskId: bank, type: "external", reason: "Bank has not sent the new file format spec" });
await extendDeadline(app, u.leadA!, { subtaskId: audit, due: day(35), reason: "Waiting for finance to confirm report fields" });
await go("b1", nav, "in_progress");
for (const [rater, subject] of [["leadA", "a1"], ["a2", "a1"], ["a3", "a1"], ["leadA", "a2"], ["a1", "a2"]] as [string, string][]) {
  await rateCollaboration(app, u[rater]!, { periodId: `${y}-Q${q + 1}`, subjectId: u[subject]!, score: 4, examples: "Helped unblock a teammate this quarter" });
}
await checkRisks(app, u.system!);
await computeDrafts(scoring, u.system!, `${y}-Q${q + 1}`);
console.log("Demo data ready. Sign in at http://localhost:3000/login");
await app.end(); await scoring.end();
