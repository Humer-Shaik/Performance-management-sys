import { requireMe } from "@/lib/session";
import * as Q from "@/lib/queries";
import { appPool } from "@/lib/pool";
import { scoreBreakdown } from "@/src/server/scoring";
import * as A from "@/app/actions";
import { Changed, Hidden, Pill, Shell, Table, fmt, flashFrom, today, type SearchParams } from "@/components/ui";
import { Breakdown } from "@/components/Breakdown";

export const dynamic = "force-dynamic";
const back = { back: "/me" };

export default async function MyWork({ searchParams }: { searchParams: SearchParams }) {
  const me = await requireMe();
  const flash = await flashFrom(searchParams);
  const [tasks, blockers, myRequests, ratings, disputes, periods, notes, mates, open] = await Promise.all([
    Q.mySubtasks(me.id), Q.openBlockersFor("raised_by", me.id), Q.requestsFor("requested_by", me.id), Q.myRatings(me.id),
    Q.disputesFiledBy(me.id), Q.periods(), Q.notifications(me.id), Q.teammates(me.id), Q.openPeriodRow(),
  ]);
  const periodId = flash.one("period") ?? periods[0]?.id;
  let breakdown: Awaited<ReturnType<typeof scoreBreakdown>> | null = null;
  if (periodId) breakdown = await scoreBreakdown(appPool(), me.id, me.id, periodId).catch(() => null);

  const DisputeForm = ({ type, id }: { type: string; id: string }) => (
    <details><summary>Dispute</summary>
      <form action={A.fileDispute} className="stack"><Hidden values={{ ...back, targetType: type, targetId: id }} />
        <textarea name="evidence" placeholder="Your evidence (links, facts)" required /><button>File dispute</button></form>
    </details>
  );

  return (
    <Shell me={me} active="/me" title="My work" sub="Your subtasks, blockers, requests, disputes and score." flash={flash}>
      <h2>My subtasks</h2>
      <Table rows={tasks} empty="No subtasks assigned to you." cols={[
        ["title", "Subtask", (t) => <><strong>{t.title}</strong><div className="muted">{t.goal_title}</div></>],
        ["status", "Status", (t) => <Pill v={t.status} />],
        ["points", "Effort", (t) => <Changed was={t.original_points} now={t.points} />],
        ["due", "Due", (t) => <Changed was={t.original_due} now={t.due} />],
        ["rating", "Rating", (t) => t.rating ? <>{t.rating}/5</> : "–"],
        ["actions", "", (t) => (
          <>
            {t.status === "not_started" && <form action={A.setStatus} className="inline"><Hidden values={{ ...back, subtaskId: t.id, to: "in_progress" }} /><button>Start</button></form>}
            {t.status === "in_progress" && <form action={A.setStatus} className="inline"><Hidden values={{ ...back, subtaskId: t.id, to: t.review_required ? "in_review" : "done" }} /><button>{t.review_required ? "Submit for review" : "Mark done"}</button></form>}
            {(t.status === "in_progress" || t.status === "in_review" || t.status === "blocked") && (
              <details><summary>Raise blocker</summary>
                <form action={A.raiseBlocker} className="stack"><Hidden values={{ ...back, subtaskId: t.id }} />
                  <select name="type"><option value="internal">Internal (inside the team)</option><option value="external">External (other team, client, vendor)</option><option value="employee_caused">Caused by me</option></select>
                  <textarea name="reason" placeholder="What is blocking you" required /><button>Raise</button></form>
              </details>)}
            {t.status !== "done" && (
              <details><summary>Ask for more time</summary>
                <form action={A.requestMoreTime} className="stack"><Hidden values={{ ...back, subtaskId: t.id }} />
                  <input type="date" name="due" min={today()} required /><textarea name="reason" placeholder="Why" required /><button>Send to lead</button></form>
              </details>)}
            {t.status === "in_progress" && (
              <details><summary>Post progress</summary>
                <form action={A.updateProgress} className="stack"><Hidden values={{ ...back, subtaskId: t.id }} /><textarea name="body" required /><button>Post</button></form>
              </details>)}
            <details><summary>Dispute deadline or effort</summary>
              <form action={A.fileDispute} className="stack"><Hidden values={{ ...back, targetId: t.id }} />
                <select name="targetType"><option value="deadline">Deadline</option><option value="estimate">Effort estimate</option></select>
                <textarea name="evidence" placeholder="Your evidence" required /><button>File dispute</button></form></details>
          </>
        )],
      ]} />

      <h2>My open blockers</h2>
      <Table rows={blockers} empty="No open blockers." cols={[
        ["subtask_title", "Subtask"], ["type", "Type"], ["reason", "Reason"], ["raised_at", "Raised"],
        ["outcome", "Lead's answer", (b) => <Pill v={b.outcome} />],
        ["a", "", (b) => <>
          <form action={A.resolveBlocker} className="inline"><Hidden values={{ ...back, blockerId: b.id }} /><button>Resolved</button></form>
          {(b.outcome === "rejected" || b.outcome === "open_dispute") && <DisputeForm type="blocker_decision" id={b.id} />}
        </>],
      ]} />

      <h2>My requests</h2>
      <Table rows={myRequests} empty="No requests." cols={[
        ["target_title", "For"], ["field", "Change"], ["new_value", "Asked for"], ["reason", "Reason"], ["status", "Status", (r) => <Pill v={r.status} />],
        ["a", "", (r) => r.status === "refused" && r.field === "deadline" && r.target_type === "subtask" && (
          <form action={A.escalateRequest} className="inline"><Hidden values={{ ...back, requestId: r.id }} /><input name="reason" placeholder="Why escalate" required /><button>Escalate to manager</button></form>)],
      ]} />

      <h2>My ratings</h2>
      <Table rows={ratings} empty="No ratings yet." cols={[
        ["subtask_title", "Subtask"], ["score", "Rating", (r) => <>{r.score}/5{r.is_reopen ? " (reopened)" : ""}</>],
        ["reason", "Reason"], ["example", "Example"], ["change_reason", "Changed because"], ["created_at", "When"],
        ["a", "", (r) => <DisputeForm type="quality_rating" id={r.id} />],
      ]} />

      <h2>My score</h2>
      {periods.length > 0 && (
        <form className="inline" method="get"><select name="period" defaultValue={periodId}>{periods.map((p) => <option key={p.id}>{p.id}</option>)}</select><button>Show</button></form>
      )}
      {breakdown ? <><Breakdown b={breakdown} />{breakdown.status !== "draft" && <DisputeForm type="score" id={breakdown.snapshotId} />}</> : <p className="muted">No score calculated yet for this period.</p>}

      <h2>My disputes</h2>
      <Table rows={disputes} empty="No disputes." cols={[
        ["target_type", "About"], ["evidence", "Evidence"], ["reviewer_name", "Reviewer"], ["due_at", "Decision due"],
        ["state", "State", (d) => <Pill v={d.outcome ?? d.state} />], ["decision_reason", "Decision"],
      ]} />

      {open && mates.length > 0 && <>
        <h2>Peer feedback for {open.id}</h2>
        <details><summary>Rate a teammate's collaboration (confidential)</summary>
          <form action={A.rateCollaboration} className="stack panel"><Hidden values={{ ...back, periodId: open.id }} />
            <select name="subjectId">{mates.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select>
            <select name="score">{[1, 2, 3, 4, 5].map((n) => <option key={n}>{n}</option>)}</select>
            <textarea name="examples" placeholder="Specific examples" required /><button>Save</button></form></details>
      </>}

      <h2>Notifications</h2>
      <Table rows={notes} empty="Nothing new." cols={[["created_at", "When"], ["body", "Message"]]} />
      <p className="muted">Times are UTC. {fmt(new Date())}</p>
    </Shell>
  );
}
