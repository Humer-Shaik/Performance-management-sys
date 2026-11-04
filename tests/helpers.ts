// Creates a fresh database per test file, migrated as the schema owner, with
// a pool that connects as the app role (as production does).
import pg from "pg";
import { migrate } from "../src/db/migrate";

export const ADMIN_URL = process.env.TEST_ADMIN_URL ?? "postgres://postgres@localhost/postgres";

export async function freshDatabase(tag: string) {
  const dbName = `pms_${tag}_${Date.now()}`;
  const urlFor = (user: string, pass: string) => {
    const u = new URL(ADMIN_URL);
    u.username = user;
    u.password = pass;
    u.pathname = `/${dbName}`;
    return u.toString();
  };
  const root = new pg.Client({ connectionString: ADMIN_URL });
  await root.connect();
  await root.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='pms_owner_t') THEN CREATE ROLE pms_owner_t LOGIN PASSWORD 'o' CREATEROLE; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='pms_app_t') THEN CREATE ROLE pms_app_t LOGIN PASSWORD 'a'; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='pms_scoring_t') THEN CREATE ROLE pms_scoring_t LOGIN PASSWORD 's'; END IF;
  END $$`);
  await root.query(`CREATE DATABASE ${dbName} OWNER pms_owner_t`);
  await root.end();

  const adminUrl = new URL(ADMIN_URL);
  adminUrl.pathname = `/${dbName}`;
  const admin = new pg.Client({ connectionString: adminUrl.toString() });
  await admin.connect();
  await admin.query("CREATE EXTENSION pgcrypto");
  await migrate(urlFor("pms_owner_t", "o"));
  await admin.query("GRANT pms_app TO pms_app_t");
  await admin.query("GRANT pms_scoring TO pms_scoring_t");

  const owner = new pg.Client({ connectionString: urlFor("pms_owner_t", "o") });
  await owner.connect();
  const app = new pg.Pool({ connectionString: urlFor("pms_app_t", "a"), max: 4 });
  const scoring = new pg.Pool({ connectionString: urlFor("pms_scoring_t", "s"), max: 2 });

  return {
    admin,
    owner,
    app,
    scoring,
    async cleanup() {
      await app.end();
      await scoring.end();
      await owner.end();
      await admin.end();
      const r = new pg.Client({ connectionString: ADMIN_URL });
      await r.connect();
      await r.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
      await r.end();
    },
  };
}

/** Runs seed SQL as the schema owner with a bootstrap actor. */
export async function seed<T>(owner: pg.Client, fn: (c: pg.Client) => Promise<T>): Promise<T> {
  await owner.query("BEGIN");
  try {
    await owner.query("SELECT set_config('app.actor_id', '00000000-0000-0000-0000-000000000000', true), set_config('app.reason', 'seed', true)");
    const out = await fn(owner);
    await owner.query("COMMIT");
    return out;
  } catch (e) {
    await owner.query("ROLLBACK");
    throw e;
  }
}

export const inDays = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

/** A small org: owner, manager, HR, two teams with leads, employees, and a system user for jobs. */
export async function seedOrg(owner: pg.Client) {
  const u: Record<string, string> = {};
  const t: Record<string, string> = {};
  await seed(owner, async (c) => {
    for (const k of ["owner", "manager", "hr", "leadA", "leadB", "emp", "emp2", "emp3", "emp4", "system"]) {
      u[k] = (await c.query("INSERT INTO users (email, name) VALUES ($1, $1) RETURNING id", [`${k}@x.test`])).rows[0].id;
    }
    const role = (k: string, r: string) => c.query("INSERT INTO user_roles (user_id, role, reason) VALUES ($1, $2, 'seed')", [u[k], r]);
    await role("owner", "owner"); await role("manager", "manager"); await role("hr", "hr");
    await role("leadA", "team_lead"); await role("leadB", "team_lead");
    for (const k of ["emp", "emp2", "emp3", "emp4"]) await role(k, "employee");
    t.A = (await c.query("INSERT INTO teams (name, lead_id, manager_id) VALUES ('Team A', $1, $2) RETURNING id", [u.leadA, u.manager])).rows[0].id;
    t.B = (await c.query("INSERT INTO teams (name, lead_id, manager_id) VALUES ('Team B', $1, $2) RETURNING id", [u.leadB, u.manager])).rows[0].id;
    for (const [team, k] of [["A", "emp"], ["A", "emp2"], ["A", "emp4"], ["B", "emp3"]] as const) {
      await c.query("INSERT INTO team_members (team_id, user_id) VALUES ($1, $2)", [t[team], u[k]]);
    }
  });
  return { u, t };
}
