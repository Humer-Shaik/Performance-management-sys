import pg from "pg";
import "@/src/server/db"; // registers the date parser

const g = globalThis as unknown as { __pmsApp?: pg.Pool; __pmsScoring?: pg.Pool };

/** The app's connection (role pms_app). */
export function appPool(): pg.Pool {
  if (!g.__pmsApp) {
    if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
    g.__pmsApp = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 10 });
  }
  return g.__pmsApp;
}

/** The scoring job's connection (role pms_scoring), the only one that can write scores. */
export function scoringPool(): pg.Pool {
  if (!g.__pmsScoring) {
    const url = process.env.SCORING_DATABASE_URL;
    if (!url) throw new Error("SCORING_DATABASE_URL is not set");
    g.__pmsScoring = new pg.Pool({ connectionString: url, max: 2 });
  }
  return g.__pmsScoring;
}
