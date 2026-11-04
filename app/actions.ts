"use server";
// Every button and form in the app goes through one of these actions. They
// call the same server commands the tests cover; the rules live there.
import { redirect } from "next/navigation";
import { appPool } from "@/lib/pool";
import { clearSession, requireMe, setSession } from "@/lib/session";
import { DomainError } from "@/src/server/errors";
import { one } from "@/src/server/db";
import * as goals from "@/src/server/goals";
import * as subtasks from "@/src/server/subtasks";
import * as requests from "@/src/server/requests";
import * as blockers from "@/src/server/blockers";
import * as ratings from "@/src/server/ratings";
import * as scoring from "@/src/server/scoring";
import * as disputes from "@/src/server/disputes";
import * as owner from "@/src/server/owner";

const s = (f: FormData, k: string) => {
  const v = f.get(k);
  return typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
};
const req = (f: FormData, k: string) => s(f, k) ?? "";
const num = (f: FormData, k: string) => (s(f, k) === undefined ? undefined : Number(s(f, k)));

function back(f: FormData) {
  const b = s(f, "back") ?? "/";
  return b.startsWith("/") && !b.startsWith("//") ? b.split("?")[0]! : "/";
}

async function run(f: FormData, okMessage: string, fn: (me: string) => Promise<unknown>) {
  const me = await requireMe();
  const to = back(f);
  let error: string | undefined;
  try {
    await fn(me.id);
  } catch (e) {
    error = e instanceof DomainError ? e.message : (e as Error).message;
  }
  redirect(error ? `${to}?error=${encodeURIComponent(error)}` : `${to}?ok=${encodeURIComponent(okMessage)}`);
}

export async function login(f: FormData) {
  if (process.env.DEMO_LOGIN !== "1") redirect("/login?error=Demo%20sign-in%20is%20off");
  const user = await one(appPool(), "SELECT id FROM users WHERE id = $1", [req(f, "userId")]);
  if (!user) redirect("/login?error=Unknown%20user");
  await setSession(user!.id);
  redirect("/");
}

export async function logout() {
  await clearSession();
  redirect("/login");
}

const pool = appPool;

export async function createGoal(f: FormData) {
  await run(f, "Goal created", (me) => goals.createGoal(pool(), me, {
    title: req(f, "title"), description: s(f, "description"), teamId: req(f, "teamId"), deadline: req(f, "deadline"),
    priority: (s(f, "priority") as "low" | "normal" | "high") ?? "normal",
  }));
}
export async function transferGoal(f: FormData) {
  await run(f, "Goal moved", (me) => goals.transferGoal(pool(), me, { goalId: req(f, "goalId"), toTeamId: req(f, "toTeamId"), reason: req(f, "reason"), newDeadline: s(f, "newDeadline") }));
}
export async function requestTeamExtension(f: FormData) {
  await run(f, "Extension requested", (me) => goals.requestTeamExtension(pool(), me, { goalId: req(f, "goalId"), newDeadline: req(f, "newDeadline"), reason: req(f, "reason") }));
}

export async function createSubtask(f: FormData) {
  await run(f, "Subtask created", (me) => subtasks.createSubtask(pool(), me, {
    goalId: req(f, "goalId"), title: req(f, "title"), acceptanceCriteria: req(f, "acceptanceCriteria"), points: num(f, "points") ?? 0,
    referencePoints: num(f, "referencePoints"), overrideReason: s(f, "overrideReason"), due: req(f, "due"), assigneeId: req(f, "assigneeId"),
    reviewRequired: s(f, "reviewRequired") !== "no", shortLeadReason: s(f, "shortLeadReason"),
  }));
}
export async function changeEstimate(f: FormData) {
  await run(f, "Estimate change saved", (me) => subtasks.changeEstimate(pool(), me, { subtaskId: req(f, "subtaskId"), points: num(f, "points") ?? 0, reason: req(f, "reason") }));
}
export async function extendDeadline(f: FormData) {
  await run(f, "Deadline extended", (me) => subtasks.extendDeadline(pool(), me, { subtaskId: req(f, "subtaskId"), due: req(f, "due"), reason: req(f, "reason") }));
}
export async function requestMoreTime(f: FormData) {
  await run(f, "Request sent to your lead", (me) => subtasks.requestMoreTime(pool(), me, { subtaskId: req(f, "subtaskId"), due: req(f, "due"), reason: req(f, "reason") }));
}
export async function reassign(f: FormData) {
  await run(f, "Reassignment saved", (me) => subtasks.reassign(pool(), me, {
    subtaskId: req(f, "subtaskId"), assigneeId: req(f, "assigneeId"), reason: req(f, "reason"),
    creditToPrevious: num(f, "creditPct") === undefined ? undefined : num(f, "creditPct")! / 100,
  }));
}
export async function setStatus(f: FormData) {
  await run(f, "Status updated", (me) => subtasks.setStatus(pool(), me, { subtaskId: req(f, "subtaskId"), to: req(f, "to") as never, note: s(f, "note") }));
}
export async function updateProgress(f: FormData) {
  await run(f, "Progress posted", (me) => subtasks.updateProgress(pool(), me, { subtaskId: req(f, "subtaskId"), body: req(f, "body") }));
}

export async function decideRequest(f: FormData) {
  await run(f, "Decision recorded", (me) => requests.decideChangeRequest(pool(), me, { requestId: req(f, "requestId"), approve: s(f, "approve") === "yes", reason: req(f, "reason") }));
}
export async function escalateRequest(f: FormData) {
  await run(f, "Escalated to your manager", (me) => requests.escalateRefusedRequest(pool(), me, { requestId: req(f, "requestId"), reason: req(f, "reason") }));
}

export async function raiseBlocker(f: FormData) {
  await run(f, "Blocker raised", (me) => blockers.raiseBlocker(pool(), me, { subtaskId: req(f, "subtaskId"), type: req(f, "type") as never, reason: req(f, "reason") }));
}
export async function acknowledgeBlocker(f: FormData) {
  await run(f, "Blocker acknowledged", (me) => blockers.acknowledgeBlocker(pool(), me, { blockerId: req(f, "blockerId"), note: s(f, "note") }));
}
export async function disputeBlocker(f: FormData) {
  await run(f, "Blocker disputed; the manager decides", (me) => blockers.disputeBlocker(pool(), me, { blockerId: req(f, "blockerId"), reason: req(f, "reason") }));
}
export async function decideBlocker(f: FormData) {
  await run(f, "Blocker decided", (me) => blockers.decideBlocker(pool(), me, { blockerId: req(f, "blockerId"), uphold: s(f, "uphold") === "yes", reason: req(f, "reason") }));
}
export async function resolveBlocker(f: FormData) {
  await run(f, "Blocker resolved", (me) => blockers.resolveBlocker(pool(), me, { blockerId: req(f, "blockerId"), note: s(f, "note") }));
}

const ratingFields = (f: FormData) => ({
  score: (num(f, "score") ?? 0) as 1 | 2 | 3 | 4 | 5, reason: s(f, "reason"), example: s(f, "example"),
  evidenceUrls: (s(f, "evidence") ?? "").split(/\s+/).filter(Boolean),
});
export async function rateQuality(f: FormData) {
  await run(f, "Rating saved", (me) => ratings.rateQuality(pool(), me, { subtaskId: req(f, "subtaskId"), ...ratingFields(f) }));
}
export async function changeQualityRating(f: FormData) {
  await run(f, "Rating changed; the employee was told", (me) => ratings.changeQualityRating(pool(), me, { ratingId: req(f, "ratingId"), changeReason: req(f, "changeReason"), ...ratingFields(f) }));
}
export async function reviewQualityRating(f: FormData) {
  await run(f, "Review recorded", (me) => ratings.reviewQualityRating(pool(), me, { ratingId: req(f, "ratingId"), outcome: req(f, "outcome") as never, note: s(f, "note") }));
}
export async function rateCollaboration(f: FormData) {
  await run(f, "Collaboration rating saved", (me) => ratings.rateCollaboration(pool(), me, { periodId: req(f, "periodId"), subjectId: req(f, "subjectId"), score: (num(f, "score") ?? 0) as never, examples: req(f, "examples") }));
}

export async function openPeriod(f: FormData) {
  await run(f, "Period opened", (me) => scoring.openPeriod(pool(), me, { id: req(f, "id"), startsOn: req(f, "startsOn"), endsOn: req(f, "endsOn") }));
}

export async function fileDispute(f: FormData) {
  await run(f, "Dispute filed", (me) => disputes.fileDispute(pool(), me, { targetType: req(f, "targetType") as never, targetId: req(f, "targetId"), evidence: req(f, "evidence") }));
}
export async function decideDispute(f: FormData) {
  const outcome = req(f, "outcome") as "upheld" | "partly_upheld" | "rejected";
  const kind = req(f, "targetType");
  let correction: disputes.Correction | undefined;
  if (outcome !== "rejected") {
    if (kind === "quality_rating" && s(f, "score")) correction = { kind, rating: ratingFields(f) };
    else if (kind === "estimate" && s(f, "points")) correction = { kind, points: num(f, "points")! };
    else if (kind === "deadline" && s(f, "due")) correction = { kind, due: req(f, "due") };
    else if (kind === "blocker_decision") correction = { kind };
    else if (kind === "score") correction = { kind };
  }
  await run(f, "Dispute decided", (me) => disputes.decideDispute(pool(), me, { disputeId: req(f, "disputeId"), outcome, reason: req(f, "reason"), correction }));
}

export async function addOwnerNote(f: FormData) {
  await run(f, "Note saved", (me) => owner.addOwnerNote(pool(), me, { entityType: req(f, "entityType"), entityId: req(f, "entityId"), kind: (s(f, "kind") as never) ?? "comment", body: req(f, "body") }));
}
