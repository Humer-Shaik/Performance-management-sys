import pg from "pg";

// Dates (not timestamps) come back as YYYY-MM-DD strings, never shifted by time zone.
pg.types.setTypeParser(1082, (v: string) => v);

export type Db = pg.Pool | pg.PoolClient | pg.Client;

/**
 * Runs fn in one transaction with the actor and reason set, so every write
 * is attributed in the audit log. Rolls back on any error.
 */
export async function withActor<T>(pool: pg.Pool, actorId: string, reason: string, fn: (db: Db) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.actor_id', $1, true), set_config('app.reason', $2, true)", [actorId, reason]);
    const out = await fn(client);
    await client.query("COMMIT");
    return out;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function one<T = Record<string, any>>(db: Db, sql: string, params: unknown[] = []): Promise<T | undefined> {
  return (await db.query(sql, params)).rows[0] as T | undefined;
}

export async function many<T = Record<string, any>>(db: Db, sql: string, params: unknown[] = []): Promise<T[]> {
  return (await db.query(sql, params)).rows as T[];
}
