import { requireMe } from "@/lib/session";
import * as Q from "@/lib/queries";
import { appPool } from "@/lib/pool";
import { leadReport } from "@/src/server/reports";
import * as A from "@/app/actions";
import { Bar, Changed, Hidden, POINTS, Pill, Shell, Table, flashFrom, today, type SearchParams } from "@/components/ui";
import { LeadReport } from "@/components/Report";

export const dynamic = "force-dynamic";
const back = { back: "/lead" };

export default async function LeadPage({ searchParams }: { searchParams: SearchParams }) {
  const me = await requireMe();
  const flash = await flashFrom(searchParams);
  const teams = await Q.teamsLedBy(me.id);
  const period = (await Q.openPeriodRow()) ?? (await Q.periods())[0];
  const approvals = await Q.requestsFor("approver", me.id);

  const sections = await Promise.all(teams.map(async (team) => ({
    team,
    goals: await Q.goalsWithProgress("team", team.id),
    tasks: await Q.teamSubtasks(team.id),
    members: await Q.teamMembers(team.id),
    blockers: await Q.openBlockersFor("team", team.id),
  })));
  const report = period ? await leadReport(appPool(), me.id, me.id, period.id).catch(() => null) : null;

  return (
    <Shell me={me} active="/lead" title="My team" sub="Plan the work, review it and answer blockers. Scores are calculated by the system." flash={flash}>
      {approvals.length > 0 && <>
        <h2>Requests waiting on you</h2>
        <Table rows={approvals} cols={[
          ["requested_by_name", "From"], ["target_title", "For"], ["field", "Change"], ["old_value", "Now"], ["new_value", "Asked for"], ["reason", "Reason"],
          ["a", "", (r) => <form action={A.decideRequest} className="inline"><Hidden values={{ ...back, requestId: r.id }} />
            <input name="reason" placeholder="Reason" required /><button name="approve" value="yes" className="primary">Approve</button><button name="approve" value="no">Refuse</button></form>],
        ]} />
      </>}

      {sections.map(({ team, goals, tasks, members, blockers }) => (
        <section key={team.id}>
          <h2>{team.name}: goals</h2>
          <Table rows={goals} empty="No goals assigned to this team." cols={[
            ["title", "Goal", (g) => <><strong>{g.title}</strong> {g.priority === "high" && <span className="pill bad">high priority</span>}</>],
            ["progress", "Progress", (g) => <><Bar pct={g.progress.barPct} /><span className="muted">{g.progress.barPct}% · {g.progress.donePct}% done</span></>],
            ["deadline", "Deadline", (g) => <Changed was={g.assigned_deadline} now={g.current_deadline} />],
            ["risk", "Risk", (g) => <Pill v={g.risk} />],
            ["a", "", (g) => <details><summary>Request extension</summary>
              <form action={A.requestTeamExtension} className="stack"><Hidden values={{ ...back, goalId: g.id }} />
                <input type="date" name="newDeadline" required /><textarea name="reason" placeholder="Why" required /><button>Send to manager</button></form></details>],
          ]} />

          {goals.length > 0 && <details style={{ marginTop: 10 }}><summary>Add a subtask</summary>
            <form action={A.createSubtask} className="stack panel"><Hidden values={back} />
              <label>Goal<select name="goalId">{goals.map((g) => <option key={g.id} value={g.id}>{g.title} (due {g.current_deadline})</option>)}</select></label>
              <label>Title<input name="title" required /></label>
              <label>Acceptance criteria<textarea name="acceptanceCriteria" required /></label>
              <label>Effort<select name="points">{POINTS.map((p) => <option key={p}>{p}</option>)}</select></label>
              <label>Reference effort for this kind of work (if different)<select name="referencePoints"><option value="">Same</option>{POINTS.map((p) => <option key={p}>{p}</option>)}</select></label>
              <label>Reason for overriding the reference<input name="overrideReason" /></label>
              <label>Assignee<select name="assigneeId">{members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
              <label>Due<input type="date" name="due" min={today()} required /></label>
              <label>Reason, if shorter than the minimum lead time<input name="shortLeadReason" /></label>
              <label>Review before Done<select name="reviewRequired"><option value="yes">Yes</option><option value="no">No (simple task)</option></select></label>
              <button className="primary">Create subtask</button>
            </form></details>}

          <h2>{team.name}: subtasks</h2>
          <Table rows={tasks} empty="No subtasks yet." cols={[
            ["assignee_name", "Person"],
            ["title", "Subtask", (t) => <><strong>{t.title}</strong><div className="muted">{t.goal_title}</div></>],
            ["status", "Status", (t) => <Pill v={t.status} />],
            ["points", "Effort", (t) => <Changed was={t.original_points} now={t.points} />],
            ["due", "Due", (t) => <Changed was={t.original_due} now={t.due} />],
            ["a", "", (t) => <>
              {t.status === "in_review" && <form action={A.setStatus} className="inline"><Hidden values={{ ...back, subtaskId: t.id }} />
                <button name="to" value="done" className="primary">Accept as done</button><button name="to" value="in_progress">Send back</button></form>}
              {t.status === "done" && !t.rating && <details><summary>Rate quality</summary>
                <form action={A.rateQuality} className="stack"><Hidden values={{ ...back, subtaskId: t.id }} />
                  <select name="score">{[1, 2, 3, 4, 5].map((n) => <option key={n}>{n}</option>)}</select>
                  <input name="reason" placeholder="Written reason (required for 1 and 2)" />
                  <input name="example" placeholder="Specific positive example (required for 4)" />
                  <input name="evidence" placeholder="Evidence links, space-separated (required for 1 and 5)" />
                  <button>Save rating</button></form></details>}
              {t.status === "done" && t.rating && <details><summary>Change rating ({t.rating}/5)</summary>
                <form action={A.changeQualityRating} className="stack"><Hidden values={{ ...back, ratingId: t.rating_id }} />
                  <select name="score">{[1, 2, 3, 4, 5].map((n) => <option key={n}>{n}</option>)}</select>
                  <input name="reason" placeholder="Written reason" /><input name="example" placeholder="Example" /><input name="evidence" placeholder="Evidence links" />
                  <input name="changeReason" placeholder="Why the rating changes (the employee is told)" required /><button>Change rating</button></form></details>}
              {t.status === "done" && <details><summary>Reopen</summary>
                <form action={A.setStatus} className="stack"><Hidden values={{ ...back, subtaskId: t.id, to: "in_progress" }} />
                  <input name="note" placeholder="What is wrong (counts against quality)" required /><button>Reopen</button></form></details>}
              {t.status !== "done" && <>
                <details><summary>Extend deadline</summary>
                  <form action={A.extendDeadline} className="stack"><Hidden values={{ ...back, subtaskId: t.id }} />
                    <input type="date" name="due" required /><input name="reason" placeholder="Reason" required /><button>Extend</button></form></details>
                <details><summary>Change estimate</summary>
                  <form action={A.changeEstimate} className="stack"><Hidden values={{ ...back, subtaskId: t.id }} />
                    <select name="points">{POINTS.map((p) => <option key={p}>{p}</option>)}</select><input name="reason" placeholder="Reason" required /><button>Change</button></form></details>
                <details><summary>Reassign</summary>
                  <form action={A.reassign} className="stack"><Hidden values={{ ...back, subtaskId: t.id }} />
                    <select name="assigneeId">{members.filter((m) => m.id !== t.assignee).map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select>
                    <input type="number" name="creditPct" min={0} max={100} placeholder="% already done (after work started)" />
                    <input name="reason" placeholder="Reason" required /><button>Reassign</button></form></details>
              </>}
            </>],
          ]} />

          <h2>{team.name}: open blockers</h2>
          <Table rows={blockers} empty="No open blockers." cols={[
            ["raised_by_name", "Raised by"], ["subtask_title", "Subtask"], ["type", "Type"], ["reason", "Reason"], ["raised_at", "Raised"],
            ["outcome", "Answer", (b) => <Pill v={b.outcome} />],
            ["a", "", (b) => b.outcome === "unanswered" && <>
              <form action={A.acknowledgeBlocker} className="inline"><Hidden values={{ ...back, blockerId: b.id }} /><button>Acknowledge</button></form>
              <details><summary>Dispute</summary><form action={A.disputeBlocker} className="stack"><Hidden values={{ ...back, blockerId: b.id }} />
                <input name="reason" placeholder="Why it is not a blocker (the manager decides)" required /><button>Dispute</button></form></details>
            </>],
          ]} />

          {period && !period.locked_at && <details style={{ marginTop: 10 }}><summary>Rate collaboration for {period.id}</summary>
            <form action={A.rateCollaboration} className="stack panel"><Hidden values={{ ...back, periodId: period.id }} />
              <select name="subjectId">{members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select>
              <select name="score">{[1, 2, 3, 4, 5].map((n) => <option key={n}>{n}</option>)}</select>
              <textarea name="examples" placeholder="Specific examples" required /><button>Save</button></form></details>}
        </section>
      ))}

      {report && <><h2>My accountability report ({period!.id})</h2><LeadReport r={report} /></>}
    </Shell>
  );
}
