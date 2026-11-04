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

  const owner = new pg.Client({ connectionString: urlFor("pms_owner_t", "o") });
  await owner.connect();
  const app = new pg.Pool({ connectionString: urlFor("pms_app_t", "a"), max: 4 });

  return {
    admin,
    owner,
    app,
    async cleanup() {
      await app.end();
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
