// Read-only queries for the screens, always scoped to the signed-in user.
import { many, one } from "@/src/server/db";
import { goalProgress } from "@/src/domain/progress";
import { appPool } from "./pool";

const db = () => appPool();

export const periods = () => many(db(), "SELECT * FROM periods ORDER BY starts_on DESC");
export const openPeriodRow = () => one(db(), "SELECT * FROM periods WHERE locked_at IS NULL AND current_date BETWEEN starts_on AND ends_on");

export const notifications = (userId: string) =>
  many(db(), "SELECT * FROM notifications WHERE user_id = $1 ORDER BY id DESC LIMIT 15", [userId]);

const SUBTASK_COLUMNS = `sc.*, g.title AS goal_title, g.current_deadline, u.name AS assignee_name,
  (SELECT q.id FROM quality_rating_latest q WHERE q.subtask_id = sc.id ORDER BY q.created_at DESC LIMIT 1) AS rating_id,
  (SELECT q.score FROM quality_rating_latest q WHERE q.subtask_id = sc.id ORDER BY q.created_at DESC LIMIT 1) AS rating`;

export const mySubtasks = (userId: string) => many(db(),
  `SELECT ${SUBTASK_COLUMNS} FROM subtask_current sc JOIN goal_current g ON g.id = sc.goal_id JOIN users u ON u.id = sc.assignee
   WHERE sc.assignee = $1 AND sc.in_scope ORDER BY sc.status = 'done', sc.due`, [userId]);

export const teamSubtasks = (teamId: string) => many(db(),
  `SELECT ${SUBTASK_COLUMNS} FROM subtask_current sc JOIN goal_current g ON g.id = sc.goal_id JOIN users u ON u.id = sc.assignee
   WHERE g.current_team_id = $1 AND sc.in_scope ORDER BY u.name, sc.status = 'done', sc.due`, [teamId]);

export const openBlockersFor = (where: "raised_by" | "team", id: string) => many(db(),
  `SELECT b.*, s.title AS subtask_title, u.name AS raised_by_name FROM blocker_current b
   JOIN subtask_current s ON s.id = b.subtask_id JOIN goal_current g ON g.id = s.goal_id JOIN users u ON u.id = b.raised_by
   WHERE b.resolved_at IS NULL AND ${where === "raised_by" ? "b.raised_by = $1" : "g.current_team_id = $1"} ORDER BY b.raised_at`, [id]);

export const disputedBlockersForManager = (managerId: string) => many(db(),
  `SELECT b.*, s.title AS subtask_title, u.name AS raised_by_name FROM blocker_current b
   JOIN subtask_current s ON s.id = b.subtask_id JOIN goal_current g ON g.id = s.goal_id JOIN teams t ON t.id = g.current_team_id
   JOIN users u ON u.id = b.raised_by WHERE b.outcome = 'open_dispute' AND t.manager_id = $1`, [managerId]);

export const requestsFor = (column: "requested_by" | "approver", userId: string) => many(db(),
  `SELECT r.*, rb.name AS requested_by_name,
     CASE WHEN r.target_type = 'goal' THEN (SELECT title FROM goals WHERE id = r.target_id) ELSE (SELECT title FROM subtasks WHERE id = r.target_id) END AS target_title
   FROM change_request_current r JOIN users rb ON rb.id = r.requested_by
   WHERE ${column === "requested_by" ? "r.requested_by = $1" : `(r.status = 'pending' AND r.approver_id = $1) OR (r.status = 'escalated' AND r.target_type = 'subtask'
     AND EXISTS (SELECT 1 FROM subtask_current s JOIN goal_current g ON g.id = s.goal_id JOIN teams t ON t.id = g.current_team_id WHERE s.id = r.target_id AND t.manager_id = $1))`}
   ORDER BY r.requested_at DESC`, [userId]);

export const myRatings = (userId: string) => many(db(),
  `SELECT q.*, s.title AS subtask_title FROM quality_rating_latest q JOIN subtasks s ON s.id = q.subtask_id WHERE q.employee_id = $1 ORDER BY q.created_at DESC`, [userId]);

export const disputesFiledBy = (userId: string) => many(db(), "SELECT d.*, r.name AS reviewer_name FROM dispute_current d JOIN users r ON r.id = d.reviewer_id WHERE d.filed_by = $1 ORDER BY d.filed_at DESC", [userId]);
export const disputesToDecide = (userId: string) => many(db(),
  `SELECT d.*, f.name AS filed_by_name, c.name AS challenged_name FROM dispute_current d JOIN users f ON f.id = d.filed_by JOIN users c ON c.id = d.challenged_user_id
   WHERE d.state <> 'decided' AND (d.reviewer_id = $1 OR d.escalated_to = $1) ORDER BY d.due_at`, [userId]);

export const ratingsToReview = (managerId: string) => many(db(),
  `SELECT q.*, s.title AS subtask_title, e.name AS employee_name, r.name AS rater_name FROM quality_rating_latest q
   JOIN subtask_current s ON s.id = q.subtask_id JOIN goal_current g ON g.id = s.goal_id JOIN teams t ON t.id = g.current_team_id
   JOIN users e ON e.id = q.employee_id JOIN users r ON r.id = q.rater_id
   WHERE t.manager_id = $1 AND q.score IN (1, 5) AND NOT EXISTS (SELECT 1 FROM quality_rating_reviews v WHERE v.rating_id = q.id)`, [managerId]);

export const teamsLedBy = (userId: string) => many(db(), "SELECT * FROM teams WHERE lead_id = $1 ORDER BY name", [userId]);
export const teamsManagedBy = (userId: string) => many(db(), "SELECT t.*, u.name AS lead_name FROM teams t JOIN users u ON u.id = t.lead_id WHERE t.manager_id = $1 ORDER BY t.name", [userId]);
export const allTeams = () => many(db(), "SELECT t.*, u.name AS lead_name FROM teams t JOIN users u ON u.id = t.lead_id ORDER BY t.name");
export const teamMembers = (teamId: string) => many(db(), "SELECT u.id, u.name FROM team_members m JOIN users u ON u.id = m.user_id WHERE m.team_id = $1 AND m.valid_to IS NULL ORDER BY u.name", [teamId]);
export const leads = () => many(db(), "SELECT DISTINCT u.id, u.name FROM teams t JOIN users u ON u.id = t.lead_id ORDER BY u.name");

/** Goals with effort-weighted progress and the latest risk check. */
export async function goalsWithProgress(where: "team" | "manager" | "all", id?: string) {
  const filter = where === "team" ? "WHERE g.current_team_id = $1" : where === "manager" ? "WHERE t.manager_id = $1" : "";
  const rows = await many(db(),
    `SELECT g.*, t.name AS team_name, r.level AS risk, r.time_pct FROM goal_current g JOIN teams t ON t.id = g.current_team_id
     LEFT JOIN goal_risk_current r ON r.goal_id = g.id ${filter} ORDER BY g.current_deadline`, id ? [id] : []);
  for (const g of rows) {
    const tasks = await many(db(), "SELECT points, status, in_scope FROM subtask_current WHERE goal_id = $1", [g.id]);
    g.progress = goalProgress(tasks.map((t) => ({ points: t.points, status: t.status, inScope: t.in_scope })));
  }
  return rows;
}

export const demoUsers = () => many(db(),
  `SELECT u.id, u.name, u.email, coalesce(string_agg(r.role::text, ', ' ORDER BY r.role), '') AS roles
   FROM users u LEFT JOIN user_roles r ON r.user_id = u.id AND r.valid_to IS NULL
   WHERE u.email NOT LIKE 'system@%' GROUP BY u.id ORDER BY roles, u.name`);

export const teammates = (userId: string) => many(db(),
  `SELECT DISTINCT u.id, u.name FROM team_members a JOIN team_members b ON a.team_id = b.team_id JOIN users u ON u.id = b.user_id
   WHERE a.user_id = $1 AND b.user_id <> $1 AND a.valid_to IS NULL AND b.valid_to IS NULL ORDER BY u.name`, [userId]);
