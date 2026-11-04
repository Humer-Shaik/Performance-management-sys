// Database safeguard tests. Needs a local PostgreSQL 16 and a superuser URL:
//   TEST_ADMIN_URL=postgres://postgres@localhost/postgres npm run test:db
// Each run creates a fresh database, migrates it as the schema owner and
// connects as the app role, the way production does.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import pg from "pg";
import { migrate } from "../src/db/migrate";

const ADMIN_URL = process.env.TEST_ADMIN_URL ?? "postgres://postgres@localhost/postgres";
const dbName = `pms_t_${Date.now()}`;
const urlFor = (user: string, pass: string) => {
  const u = new URL(ADMIN_URL);
  u.username = user;
  u.password = pass;
  u.pathname = `/${dbName}`;
  return u.toString();
};

let admin: pg.Client; // superuser, used only to simulate direct database tampering
let app: pg.Client; // connects as the app role

async function asActor<T>(client: pg.Client, actor: string, reason: string, fn: () => Promise<T>) {
  await client.query("BEGIN");
  try {
    await client.query("SELECT set_config('app.actor_id', $1, true), set_config('app.reason', $2, true)", [actor, reason]);
    const out = await fn();
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  }
}

const ids = {} as Record<"owner" | "manager" | "lead" | "emp" | "peer" | "hr" | "team" | "goal" | "subtask", string>;

beforeAll(async () => {
  const root = new pg.Client({ connectionString: ADMIN_URL });
  await root.connect();
  await root.query(`DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='pms_owner_t') THEN CREATE ROLE pms_owner_t LOGIN PASSWORD 'o' CREATEROLE; END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='pms_app_t') THEN CREATE ROLE pms_app_t LOGIN PASSWORD 'a'; END IF;
  END $$`);
  await root.query(`CREATE DATABASE ${dbName} OWNER pms_owner_t`);
  await root.end();

  admin = new pg.Client({ connectionString: urlFor(new URL(ADMIN_URL).username, decodeURIComponent(new URL(ADMIN_URL).password)) });
  await admin.connect();
  await admin.query("CREATE EXTENSION pgcrypto");

  await migrate(urlFor("pms_owner_t", "o"));
  await admin.query("GRANT pms_app TO pms_app_t");

  app = new pg.Client({ connectionString: urlFor("pms_app_t", "a") });
  await app.connect();

  // Seed: the first user is created by the migration owner (bootstrap admin).
  const owner = new pg.Client({ connectionString: urlFor("pms_owner_t", "o") });
  await owner.connect();
  await asActor(owner, "00000000-0000-0000-0000-000000000000", "bootstrap", async () => {
    for (const k of ["owner", "manager", "lead", "emp", "peer", "hr"] as const) {
      ids[k] = (await owner.query("INSERT INTO users (email, name) VALUES ($1, $2) RETURNING id", [`${k}@x.test`, k])).rows[0].id;
    }
  });
  await owner.end();

  await asActor(app, ids.manager, "set up team and goal", async () => {
    ids.team = (await app.query("INSERT INTO teams (name, lead_id, manager_id) VALUES ('Team A', $1, $2) RETURNING id", [ids.lead, ids.manager])).rows[0].id;
    ids.goal = (await app.query(
      "INSERT INTO goals (title, created_by, original_team_id, original_deadline) VALUES ('Finish the payroll module', $1, $2, current_date + 45) RETURNING id",
      [ids.manager, ids.team],
    )).rows[0].id;
    await app.query("INSERT INTO goal_assignments (goal_id, team_id, deadline, assigned_by, reason) VALUES ($1, $2, current_date + 45, $3, 'initial')", [ids.goal, ids.team, ids.manager]);
  });
  await asActor(app, ids.lead, "split goal", async () => {
    ids.subtask = (await app.query(
      `INSERT INTO subtasks (goal_id, title, acceptance_criteria, original_points, reference_points, original_due, original_assignee, created_by)
       VALUES ($1, 'Tax tables', 'All 2026 brackets pass tests', 3, 3, current_date + 20, $2, $3) RETURNING id`,
      [ids.goal, ids.emp, ids.lead],
    )).rows[0].id;
  });
});

afterAll(async () => {
  await app?.end();
  await admin?.end();
  const root = new pg.Client({ connectionString: ADMIN_URL });
  await root.connect();
  await root.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
  await root.end();
});

describe("audit trail", () => {
  it("refuses writes with no actor", async () => {
    await expect(
      app.query("INSERT INTO progress_updates (subtask_id, author_id, body) VALUES ($1, $2, 'x')", [ids.subtask, ids.emp]),
    ).rejects.toThrow(/No actor set/);
  });

  it("logs every write with actor, reason and old and new values", async () => {
    const before = (await app.query("SELECT count(*)::int AS n FROM audit_log")).rows[0].n;
    await asActor(app, ids.lead, "client asked for an earlier date", () =>
      app.query("INSERT INTO subtask_revisions (subtask_id, field, old_value, new_value, reason, changed_by) VALUES ($1, 'due', to_jsonb(current_date + 20), to_jsonb(current_date + 25), 'client asked for an earlier date', $2)", [ids.subtask, ids.lead]),
    );
    const rows = (await app.query("SELECT * FROM audit_log ORDER BY seq DESC LIMIT 1")).rows;
    expect((await app.query("SELECT count(*)::int AS n FROM audit_log")).rows[0].n).toBe(before + 1);
    expect(rows[0]).toMatchObject({ actor_id: ids.lead, action: "INSERT", entity_type: "subtask_revisions", reason: "client asked for an earlier date" });
  });

  it("keeps the original due date and derives the current one", async () => {
    const r = (await app.query("SELECT original_due, due FROM subtask_current WHERE id = $1", [ids.subtask])).rows[0];
    expect(r.due.getTime() - r.original_due.getTime()).toBe(5 * 86400_000);
  });

  it("verifies an intact chain", async () => {
    expect((await app.query("SELECT * FROM verify_audit_chain()")).rows).toEqual([]);
  });

  it("does not let the app write or change the log directly", async () => {
    await expect(app.query("INSERT INTO audit_log (seq, at, db_user, action, entity_type, entity_id, prev_hash, hash) VALUES (999, now(), 'x', 'x', 'x', 'x', 'x', 'x')")).rejects.toThrow(/permission denied/);
    await expect(app.query("UPDATE audit_log SET reason = 'edited'")).rejects.toThrow(/permission denied/);
    await expect(app.query("SELECT append_audit('INSERT', 'x', 'x', null, null)")).rejects.toThrow(/permission denied/);
  });

  it("refuses edits to the log even for the superuser while triggers are on", async () => {
    await expect(admin.query("UPDATE audit_log SET reason = 'edited' WHERE seq = 1")).rejects.toThrow(/append-only/);
    await expect(admin.query("DELETE FROM audit_log WHERE seq = 1")).rejects.toThrow(/append-only/);
  });

  it("detects a direct database edit that bypasses the triggers", async () => {
    await admin.query("ALTER TABLE audit_log DISABLE TRIGGER audit_log_no_update");
    await admin.query("UPDATE audit_log SET reason = 'nothing to see' WHERE seq = 2");
    await admin.query("ALTER TABLE audit_log ENABLE TRIGGER audit_log_no_update");
    const bad = (await app.query("SELECT * FROM verify_audit_chain()")).rows;
    expect(bad).toEqual([{ bad_seq: "2", problem: "hash does not match entry contents" }]);
  });
});

describe("history cannot be overwritten", () => {
  it("refuses changing an original value", async () => {
    await expect(asActor(app, ids.lead, "x", () => app.query("UPDATE subtasks SET original_due = current_date + 2 WHERE id = $1", [ids.subtask]))).rejects.toThrow(/permission denied|append-only/);
    await expect(asActor(admin, ids.lead, "x", () => admin.query("UPDATE subtasks SET original_due = current_date + 2 WHERE id = $1", [ids.subtask]))).rejects.toThrow(/append-only/);
  });

  it("never deletes a blocker", async () => {
    const id = await asActor(app, ids.emp, "waiting on vendor API keys", async () =>
      (await app.query("INSERT INTO blockers (subtask_id, raised_by, type, reason) VALUES ($1, $2, 'external', 'waiting on vendor API keys') RETURNING id", [ids.subtask, ids.emp])).rows[0].id,
    );
    await expect(asActor(admin, ids.lead, "x", () => admin.query("DELETE FROM blockers WHERE id = $1", [id]))).rejects.toThrow(/append-only/);
  });

  it("fills a set-once column once and then locks it", async () => {
    await asActor(app, ids.hr, "open quarter", () => app.query("INSERT INTO periods VALUES ('2026-Q4', '2026-10-01', '2026-12-31')"));
    await asActor(app, ids.hr, "quarter end", () => app.query("UPDATE periods SET locked_at = now() WHERE id = '2026-Q4'"));
    await expect(asActor(app, ids.hr, "reopen", () => app.query("UPDATE periods SET locked_at = NULL WHERE id = '2026-Q4'"))).rejects.toThrow(/already set/);
    await expect(asActor(app, ids.hr, "move dates", () => app.query("UPDATE periods SET ends_on = '2027-01-31' WHERE id = '2026-Q4'"))).rejects.toThrow(/append-only/);
  });

  it("does not let the app write scores", async () => {
    await expect(asActor(app, ids.lead, "x", () => app.query("INSERT INTO score_snapshots (period_id, employee_id, rule_version_id, inputs_hash, breakdown, status) VALUES ('2026-Q4', $1, gen_random_uuid(), 'x', '{}', 'draft')", [ids.emp]))).rejects.toThrow(/permission denied/);
  });
});

describe("rating and dispute rules", () => {
  const rate = (score: number, extra: Partial<{ reason: string; example: string; evidence: string[] }> = {}) =>
    asActor(app, ids.lead, "rating", () =>
      app.query(
        "INSERT INTO quality_ratings (subtask_id, employee_id, rater_id, score, reason, example, evidence_urls) VALUES ($1, $2, $3, $4, $5, $6, $7)",
        [ids.subtask, ids.emp, ids.lead, score, extra.reason ?? null, extra.example ?? null, extra.evidence ?? []],
      ),
    );

  it("requires reason and evidence for a 1", async () => {
    await expect(rate(1, { reason: "missed criteria" })).rejects.toThrow(/check constraint/);
    await expect(rate(1, { reason: "missed criteria", evidence: ["https://tracker/123"] })).resolves.toBeDefined();
  });
  it("requires a reason for a 2, an example for a 4 and evidence for a 5", async () => {
    await expect(rate(2)).rejects.toThrow(/check constraint/);
    await expect(rate(4)).rejects.toThrow(/check constraint/);
    await expect(rate(5)).rejects.toThrow(/check constraint/);
    await expect(rate(3)).resolves.toBeDefined();
  });
  it("never lets the challenged person review the dispute", async () => {
    await expect(
      asActor(app, ids.emp, "dispute", () =>
        app.query(
          "INSERT INTO disputes (filed_by, target_type, target_id, challenged_user_id, evidence, decision_made_at, reviewer_id, due_at) VALUES ($1, 'quality_rating', 'x', $2, 'see PR', now(), $2, now() + interval '14 days')",
          [ids.emp, ids.lead],
        ),
      ),
    ).rejects.toThrow(/check constraint/);
  });
});
