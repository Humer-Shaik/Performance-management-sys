// Quality ratings (lead, against a rubric, with evidence rules) and
// confidential collaboration ratings (lead plus peers).
import type pg from "pg";
import { one, withActor, type Db } from "./db";
import { forbid, invalid, notFound, requireReason } from "./errors";
import { notify } from "./notify";
import { subtaskContext } from "./subtasks";

export interface QualityRatingInput {
  score: 1 | 2 | 3 | 4 | 5;
  rubricAnswers?: Record<string, unknown>;
  reason?: string;
  example?: string;
  evidenceUrls?: string[];
}

/** Evidence rules from the plan, checked here for clear messages and again by the database. */
export function checkEvidence(r: QualityRatingInput) {
  const has = (s?: string) => !!s && s.trim().length > 0;
  const evidence = (r.evidenceUrls ?? []).filter((u) => u.trim()).length > 0;
  if (![1, 2, 3, 4, 5].includes(r.score)) invalid("A rating is 1 to 5");
  if (r.score === 1 && (!has(r.reason) || !evidence)) invalid("A rating of 1 needs a written reason and evidence");
  if (r.score === 2 && !has(r.reason)) invalid("A rating of 2 needs a written reason");
  if (r.score === 4 && !has(r.example)) invalid("A rating of 4 needs a specific positive example");
  if (r.score === 5 && !evidence) invalid("A rating of 5 needs specific evidence");
}

async function doneAt(db: Db, subtaskId: string): Promise<string> {
  const r = await one<{ at: Date }>(db, "SELECT at FROM status_events WHERE subtask_id = $1 AND to_status = 'done' ORDER BY id DESC LIMIT 1", [subtaskId]);
  return r!.at.toISOString().slice(0, 10);
}

async function assertNotLocked(db: Db, day: string) {
  const r = await one<{ locked: boolean }>(db, "SELECT period_locked_on($1::date) AS locked", [day]);
  if (r!.locked) forbid("That quarter's scores are locked; changes now go through a dispute");
}

async function afterRating(db: Db, ratingId: string, score: number, employeeId: string, managerId: string, title: string, changed: boolean) {
  await notify(db, [employeeId], changed ? "rating_changed" : "rated", "quality_rating", ratingId,
    `${changed ? "Your rating was changed" : "You were rated"} ${score}/5 on "${title}"`);
  if (score === 1) await notify(db, [managerId], "rating_review_needed", "quality_rating", ratingId, `A rating of 1 on "${title}" needs your review`);
  if (score === 5) await notify(db, [managerId], "rating_validation_optional", "quality_rating", ratingId, `A rating of 5 on "${title}" can be validated`);
}

export async function rateQuality(pool: pg.Pool, actorId: string, input: QualityRatingInput & { subtaskId: string }) {
  checkEvidence(input);
  return withActor(pool, actorId, `quality rating ${input.score}`, async (db) => {
    const s = await subtaskContext(db, input.subtaskId);
    if (s.lead_id !== actorId) forbid("Only the team lead rates quality");
    if (s.status !== "done") invalid("Only done subtasks are rated");
    await assertNotLocked(db, await doneAt(db, s.id));
    const existing = await one(db, "SELECT id FROM quality_rating_latest WHERE subtask_id = $1", [s.id]);
    if (existing) invalid("This subtask is already rated; change the rating with a reason instead");
    const r = await one<{ id: string }>(
      db,
      `INSERT INTO quality_ratings (subtask_id, employee_id, rater_id, score, rubric_answers, reason, example, evidence_urls)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id`,
      [s.id, s.assignee, actorId, input.score, input.rubricAnswers ?? {}, input.reason ?? null, input.example ?? null, input.evidenceUrls ?? []],
    );
    await afterRating(db, r!.id, input.score, s.assignee, s.manager_id, s.title, false);
    return { ratingId: r!.id };
  });
}

/** A submitted rating is never edited: a change is a new version with a reason, and the employee is told. */
export async function changeQualityRating(pool: pg.Pool, actorId: string, input: QualityRatingInput & { ratingId: string; changeReason: string }) {
  checkEvidence(input);
  const changeReason = requireReason(input.changeReason, "Changing a rating");
  return withActor(pool, actorId, changeReason, async (db) => {
    const old = await one(db, "SELECT * FROM quality_rating_latest WHERE id = $1", [input.ratingId]);
    if (!old) notFound("Rating not found, or it has already been changed");
    const s = await subtaskContext(db, old!.subtask_id);
    if (s.lead_id !== actorId) forbid("Only the team lead can change a quality rating");
    await assertNotLocked(db, await doneAt(db, s.id));
    const r = await one<{ id: string }>(
      db,
      `INSERT INTO quality_ratings (subtask_id, employee_id, rater_id, score, rubric_answers, reason, example, evidence_urls, supersedes_id, change_reason)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
      [s.id, old!.employee_id, actorId, input.score, input.rubricAnswers ?? {}, input.reason ?? null, input.example ?? null,
        input.evidenceUrls ?? [], old!.id, changeReason],
    );
    await afterRating(db, r!.id, input.score, old!.employee_id, s.manager_id, s.title, true);
    return { ratingId: r!.id, previousScore: old!.score };
  });
}

/** Manager reviews a 1 (required) or validates a 5 (optional). */
export async function reviewQualityRating(pool: pg.Pool, actorId: string, input: { ratingId: string; outcome: "confirmed" | "questioned" | "validated"; note?: string }) {
  return withActor(pool, actorId, `rating review: ${input.outcome}`, async (db) => {
    const r = await one(db, "SELECT * FROM quality_ratings WHERE id = $1", [input.ratingId]);
    if (!r) notFound("Rating not found");
    const s = await subtaskContext(db, r!.subtask_id);
    if (s.manager_id !== actorId) forbid("Only the team's manager reviews ratings");
    if (r!.rater_id === actorId) forbid("You cannot review your own rating");
    if (input.outcome === "questioned" && !input.note?.trim()) invalid("Questioning a rating needs a note");
    await db.query("INSERT INTO quality_rating_reviews (rating_id, manager_id, outcome, note) VALUES ($1, $2, $3, $4)",
      [r!.id, actorId, input.outcome, input.note?.trim() || null]);
    if (input.outcome === "questioned") await notify(db, [s.lead_id], "rating_questioned", "quality_rating", r!.id, `Your rating on "${s.title}" was questioned: ${input.note}`);
    return { ok: true };
  });
}

/**
 * Collaboration: the lead and at least two peers rate each employee per
 * quarter, with specific examples. Who gave which score is never shown.
 */
export async function rateCollaboration(pool: pg.Pool, actorId: string, input: { periodId: string; subjectId: string; score: 1 | 2 | 3 | 4 | 5; examples: string }) {
  if (![1, 2, 3, 4, 5].includes(input.score)) invalid("A rating is 1 to 5");
  if (!input.examples?.trim()) invalid("Collaboration ratings need specific examples");
  if (input.subjectId === actorId) invalid("You cannot rate yourself");
  return withActor(pool, actorId, "collaboration rating", async (db) => {
    const period = await one(db, "SELECT * FROM periods WHERE id = $1", [input.periodId]);
    if (!period) notFound("Period not found");
    if (period!.locked_at) forbid("That quarter is locked");
    const lead = await one(db,
      `SELECT 1 FROM teams t JOIN team_members m ON m.team_id = t.id AND m.valid_to IS NULL
       WHERE t.lead_id = $1 AND m.user_id = $2`, [actorId, input.subjectId]);
    const peer = await one(db,
      `SELECT 1 FROM team_members a JOIN team_members b ON a.team_id = b.team_id
       WHERE a.user_id = $1 AND b.user_id = $2 AND a.valid_to IS NULL AND b.valid_to IS NULL`, [actorId, input.subjectId]);
    if (!lead && !peer) forbid("Only the employee's lead or teammates can rate collaboration");
    const done = await one(db, "SELECT 1 FROM collaboration_ratings WHERE period_id = $1 AND subject_id = $2 AND rater_id = $3",
      [input.periodId, input.subjectId, actorId]);
    if (done) invalid("You already rated this person for this quarter");
    await db.query(
      "INSERT INTO collaboration_ratings (period_id, subject_id, rater_id, rater_kind, score, examples) VALUES ($1, $2, $3, $4, $5, $6)",
      [input.periodId, input.subjectId, actorId, lead ? "lead" : "peer", input.score, input.examples.trim()],
    );
    return { raterKind: lead ? "lead" : "peer" };
  });
}
