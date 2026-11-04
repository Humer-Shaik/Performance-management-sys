import { requireMe } from "@/lib/session";
import * as Q from "@/lib/queries";
import { appPool } from "@/lib/pool";
import { managerReport } from "@/src/server/reports";
import * as A from "@/app/actions";
import { Bar, Changed, Hidden, POINTS, Pill, Shell, Table, flashFrom, today, type SearchParams } from "@/components/ui";
import { LeadReport } from "@/components/Report";
import { DecideDisputeForm } from "@/components/DecideDispute";

export const dynamic = "force-dynamic";
const back = { back: "/manager" };

export default async function ManagerPage({ searchParams }: { searchParams: SearchParams }) {
  const me = await requireMe();
  const flash = await flashFrom(searchParams);
  const period = (await Q.openPeriodRow()) ?? (await Q.periods())[0];
  const [teams, allTeams, goals, approvals, blockers, ratings, disputes] = await Promise.all([
    Q.teamsManagedBy(me.id), Q.allTeams(), Q.goalsWithProgress("manager", me.id), Q.requestsFor("approver", me.id),
    Q.disputedBlockersForManager(me.id), Q.ratingsToReview(me.id), Q.disputesToDecide(me.id),
  ]);
  const report = period ? await managerReport(appPool(), me.id, me.id, period.id).catch(() => null) : null;

  return (
    <Shell me={me} active="/manager" title="Manager" sub="Your teams' progress and risk, and everything waiting on your decision." flash={flash}>
      <details><summary>Create a goal</summary>
        <form action={A.createGoal} className="stack panel"><Hidden values={back} />
          <label>Title<input name="title" required /></label>
          <label>Description<textarea name="description" /></label>
          <label>Team<select name="teamId">{allTeams.map((t) => <option key={t.id} value={t.id}>{t.name} (lead {t.lead_name})</option>)}</select></label>
          <label>Deadline<input type="date" name="deadline" min={today()} required /></label>
          <label>Priority<select name="priority"><option value="normal">Normal</option><option value="high">High</option><option value="low">Low</option></select></label>
          <button className="primary">Create and assign</button>
        </form></details>

      <h2>Goals in your teams</h2>
      <Table rows={goals} empty="No goals yet." cols={[
        ["title", "Goal", (g) => <><strong>{g.title}</strong>{g.priority === "high" && <> <span className="pill bad">high priority</span></>}</>],
        ["team_name", "Team"],
        ["progress", "Progress", (g) => <><Bar pct={g.progress.barPct} /><span className="muted">{g.progress.barPct}%</span></>],
        ["deadline", "Deadline", (g) => <Changed was={g.original_deadline} now={g.current_deadline} />],
        ["risk", "Risk", (g) => <Pill v={g.risk} />],
        ["a", "", (g) => <details><summary>Move to another team</summary>
          <form action={A.transferGoal} className="stack"><Hidden values={{ ...back, goalId: g.id }} />
            <select name="toTeamId">{allTeams.filter((t) => t.id !== g.current_team_id).map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
            <input type="date" name="newDeadline" title="New deadline (optional)" /><input name="reason" placeholder="Reason (owner is told)" required /><button>Move</button></form></details>],
      ]} />

      <h2>Approvals</h2>
      <Table rows={approvals} empty="Nothing waiting for approval." cols={[
        ["requested_by_name", "From"], ["target_title", "For"], ["field", "Change"], ["old_value", "Now"], ["new_value", "Asked for"], ["reason", "Reason"],
        ["status", "", (r) => <Pill v={r.status} />],
        ["a", "", (r) => <form action={A.decideRequest} className="inline"><Hidden values={{ ...back, requestId: r.id }} />
          <input name="reason" placeholder="Reason" required /><button name="approve" value="yes" className="primary">Approve</button><button name="approve" value="no">Refuse</button></form>],
      ]} />

      <h2>Disputed blockers</h2>
      <Table rows={blockers} empty="No disputed blockers." cols={[
        ["raised_by_name", "Raised by"], ["subtask_title", "Subtask"], ["type", "Type"], ["reason", "Reason"],
        ["a", "", (b) => <form action={A.decideBlocker} className="inline"><Hidden values={{ ...back, blockerId: b.id }} />
          <input name="reason" placeholder="Reason" required /><button name="uphold" value="yes" className="primary">Uphold</button><button name="uphold" value="no">Reject</button></form>],
      ]} />

      <h2>Ratings to review</h2>
      <Table rows={ratings} empty="No 1s or 5s waiting for review." cols={[
        ["employee_name", "Employee"], ["subtask_title", "Subtask"], ["score", "Rating"], ["rater_name", "Rated by"], ["reason", "Reason"], ["evidence_urls", "Evidence"],
        ["a", "", (r) => <form action={A.reviewQualityRating} className="inline"><Hidden values={{ ...back, ratingId: r.id }} />
          <input name="note" placeholder="Note" /><button name="outcome" value={r.score === 5 ? "validated" : "confirmed"}>{r.score === 5 ? "Validate" : "Confirm"}</button>
          <button name="outcome" value="questioned">Question</button></form>],
      ]} />

      <h2>Disputes to decide</h2>
      <Table rows={disputes} empty="No disputes assigned to you." cols={[
        ["filed_by_name", "Filed by"], ["target_type", "About"], ["challenged_name", "Decision by"], ["evidence", "Evidence"], ["due_at", "Decide by"],
        ["a", "", (d) => <details><summary>Decide</summary><DecideDisputeForm d={d} backTo="/manager" /></details>],
      ]} />

      {report && <>
        <h2>Lead accountability ({period!.id})</h2>
        <p className="muted">{report.pending.approvals} approvals and {report.pending.disputes} disputes pending.</p>
        {report.leads.map((r, i) => <LeadReport key={r.leadId} r={r} name={teams.find((t) => t.lead_id === r.leadId)?.lead_name ?? `Lead ${i + 1}`} />)}
      </>}
    </Shell>
  );
}
