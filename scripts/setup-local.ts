// One-time local setup: creates the database and login roles, runs the
// migrations and writes .env.local. Needs a PostgreSQL superuser URL:
//   ADMIN_URL=postgres://you@localhost/postgres npm run setup
import { randomBytes } from "node:crypto";
import { existsSync, writeFileSync } from "node:fs";
import pg from "pg";
import { migrate } from "../src/db/migrate";

const admin = process.env.ADMIN_URL ?? `postgres://${process.env.USER ?? "postgres"}@localhost/postgres`;
const dbName = process.env.DB_NAME ?? "pms";
const pw = () => randomBytes(12).toString("hex");
const url = (user: string, pass: string) => { const u = new URL(admin); u.username = user; u.password = pass; u.pathname = `/${dbName}`; return u.toString(); };

const root = new pg.Client({ connectionString: admin });
await root.connect();
const exists = (await root.query("SELECT 1 FROM pg_database WHERE datname = $1", [dbName])).rowCount;
if (exists) { console.error(`Database "${dbName}" already exists. Drop it first or set DB_NAME.`); process.exit(1); }
const p = { owner: pw(), app: pw(), scoring: pw() };
for (const [role, pass] of [["pms_owner", p.owner], ["pms_app_login", p.app], ["pms_scoring_login", p.scoring]] as const) {
  const has = (await root.query("SELECT 1 FROM pg_roles WHERE rolname = $1", [role])).rowCount;
  await root.query(`${has ? "ALTER" : "CREATE"} ROLE ${role} LOGIN PASSWORD '${pass}'${role === "pms_owner" ? " CREATEROLE" : ""}`);
}
await root.query(`CREATE DATABASE ${dbName} OWNER pms_owner`);
await root.end();

const adminDb = new URL(admin); adminDb.pathname = `/${dbName}`;
const c = new pg.Client({ connectionString: adminDb.toString() });
await c.connect();
await c.query("CREATE EXTENSION IF NOT EXISTS pgcrypto");
await migrate(url("pms_owner", p.owner));
await c.query("GRANT pms_app TO pms_app_login; GRANT pms_scoring TO pms_scoring_login");
await c.end();

if (existsSync(".env.local")) console.warn(".env.local exists; writing .env.local.new instead");
writeFileSync(existsSync(".env.local") ? ".env.local.new" : ".env.local", [
  `DATABASE_URL=${url("pms_app_login", p.app)}`,
  `SCORING_DATABASE_URL=${url("pms_scoring_login", p.scoring)}`,
  `OWNER_DATABASE_URL=${url("pms_owner", p.owner)}`,
  `SESSION_SECRET=${randomBytes(32).toString("hex")}`,
  "DEMO_LOGIN=1",
  "",
].join("\n"));
console.log(`Database "${dbName}" ready. Next: npm run db:seed, then npm run dev`);
