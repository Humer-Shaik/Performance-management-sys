// Who can do what. Every command loads the actor's context and checks it here
// before writing; the database constraints are the second line of defence.
import { many, one, type Db } from "./db";
import { forbid } from "./errors";

export type Role = "employee" | "team_lead" | "manager" | "hr" | "head_of_hr" | "admin" | "owner";

export interface Actor {
  id: string;
  roles: Set<Role>;
  leads: Set<string>; // team ids
  manages: Set<string>; // team ids
  memberOf: Set<string>; // team ids
}

export async function loadActor(db: Db, userId: string): Promise<Actor> {
  const user = await one(db, "SELECT id FROM users WHERE id = $1", [userId]);
  if (!user) forbid("Unknown user");
  const roles = await many<{ role: Role }>(db, "SELECT role FROM user_roles WHERE user_id = $1 AND valid_to IS NULL", [userId]);
  const leads = await many<{ id: string }>(db, "SELECT id FROM teams WHERE lead_id = $1", [userId]);
  const manages = await many<{ id: string }>(db, "SELECT id FROM teams WHERE manager_id = $1", [userId]);
  const member = await many<{ team_id: string }>(db, "SELECT team_id FROM team_members WHERE user_id = $1 AND valid_to IS NULL", [userId]);
  return {
    id: userId,
    roles: new Set(roles.map((r) => r.role)),
    leads: new Set(leads.map((t) => t.id)),
    manages: new Set(manages.map((t) => t.id)),
    memberOf: new Set(member.map((m) => m.team_id)),
  };
}

export const has = (a: Actor, ...roles: Role[]) => roles.some((r) => a.roles.has(r));

export function assertCanCreateGoal(a: Actor) {
  // The owner is read-only by design.
  if (!has(a, "manager", "hr", "admin")) forbid("Only a manager, HR or an admin can create goals");
}

export function assertLeadOf(a: Actor, teamId: string) {
  if (!a.leads.has(teamId)) forbid("Only the team lead can do this");
}

export function assertManagerOf(a: Actor, teamId: string) {
  if (!a.manages.has(teamId)) forbid("Only the team's manager can do this");
}
