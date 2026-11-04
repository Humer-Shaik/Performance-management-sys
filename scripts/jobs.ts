// Scheduled jobs. Run nightly (cron, a scheduler or a hosted job runner):
// risk checks, blocker and dispute escalations, draft scores, quarter locks
// and rescoring after disputes. Runs as the "system" user.
import "./env";
import pg from "pg";
import "../src/server/db";
import { checkRisks } from "../src/server/risk";
import { escalateLongBlockers } from "../src/server/blockers";
import { escalateOverdueDisputes, rescoreAfterDisputes } from "../src/server/disputes";
import { computeDrafts, lockPeriod } from "../src/server/scoring";

const app = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const scoring = new pg.Pool({ connectionString: process.env.SCORING_DATABASE_URL });
const system = (await app.query("SELECT id FROM users WHERE email = $1", [process.env.SYSTEM_USER_EMAIL ?? "system@jobs.local"])).rows[0]?.id;
if (!system) throw new Error("No system user found (SYSTEM_USER_EMAIL)");

console.log("risk", await checkRisks(app, system));
console.log("blockers", await escalateLongBlockers(app, system));
console.log("disputes", await escalateOverdueDisputes(app, system));
const periods = (await app.query("SELECT id, ends_on, locked_at FROM periods")).rows;
const today = new Date().toISOString().slice(0, 10);
for (const p of periods) {
  if (p.locked_at) continue;
  if (p.ends_on < today) console.log("lock", p.id, await lockPeriod(scoring, system, p.id));
  else console.log("drafts", p.id, (await computeDrafts(scoring, system, p.id)).length);
}
console.log("rescore", await rescoreAfterDisputes(scoring, system));
await app.end(); await scoring.end();
