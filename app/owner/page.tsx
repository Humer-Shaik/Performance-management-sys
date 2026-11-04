import Link from "next/link";
import { requireMe } from "@/lib/session";
import * as Q from "@/lib/queries";
import { appPool } from "@/lib/pool";
import { RAW_VIEWS, rawView, type RawView } from "@/src/server/owner";
import { leadReport } from "@/src/server/reports";
import * as A from "@/app/actions";
import { Bar, Changed, Hidden, Pill, Shell, Table, fmt, flashFrom, type SearchParams } from "@/components/ui";
import { LeadReport } from "@/components/Report";

export const dynamic = "force-dynamic";

const LABELS: Record<RawView, string> = {
  goals: "Goals", subtasks: "Subtasks", assignments: "Team assignments", changes: "Every change", requests: "Requests and approvals",
  ratings: "Ratings", blockers: "Blockers", disputes: "Disputes", scores: "Scores", audit: "Audit log",
};

export default async function OwnerPage({ searchParams }: { searchParams: SearchParams }) {
  const me = await requireMe();
  const flash = await flashFrom(searchParams);
  const view = (flash.one("view") ?? "overview") as RawView | "overview" | "accountability";
  const back = { back: "/owner" };

  let body;
  if (view === "overview") {
    const goals = await Q.goalsWithProgress("all");
    const overdueHigh = goals.filter((g) => g.priority === "high" && (g.risk === "overdue" || g.risk === "critical"));
    body = <>
      <div className="grid">
        <div className="panel"><div className="muted">Goals</div><div style={{ fontSize: 24 }}>{goals.length}</div></div>
        <div className="panel"><div className="muted">At risk or worse</div><div style={{ fontSize: 24 }}>{goals.filter((g) => ["at_risk", "critical", "overdue"].includes(g.risk)).length}</div></div>
        <div className="panel"><div className="muted">High priority, critical or overdue</div><div style={{ fontSize: 24 }}>{overdueHigh.length}</div></div>
      </div>
      <h2>All goals</h2>
      <Table rows={goals} cols={[
        ["title", "Goal"], ["team_name", "Team"], ["priority", "Priority"],
        ["progress", "Progress", (g) => <><Bar pct={g.progress.barPct} /><span className="muted">{g.progress.barPct}%</span></>],
        ["deadline", "Deadline", (g) => <Changed was={g.original_deadline} now={g.current_deadline} />], ["risk", "Risk", (g) => <Pill v={g.risk} />],
        ["a", "", (g) => <details><summary>Comment or request review</summary>
          <form action={A.addOwnerNote} className="stack"><Hidden values={{ ...back, entityType: "goal", entityId: g.id }} />
            <select name="kind"><option value="comment">Comment</option><option value="review_request">Request a review</option></select>
            <textarea name="body" required /><button>Save</button></form></details>],
      ]} />
    </>;
  } else if (view === "accountability") {
    const period = (await Q.periods())[0];
    const leads = await Q.leads();
    body = period ? await Promise.all(leads.map(async (l) => <LeadReport key={l.id} r={await leadReport(appPool(), me.id, l.id, period.id)} name={l.name} />)) : <p className="muted">No quarter yet.</p>;
  } else {
    const rows = await rawView(appPool(), me.id, view);
    const cols = rows[0] ? Object.keys(rows[0]).filter((k) => k !== "id" && k !== "hash" && k !== "prev_hash") : [];
    body = <>
      <p><a href={`/api/export?view=${view}`} className="pill">Download as spreadsheet (CSV)</a> <span className="muted">{rows.length} records, unfiltered.</span></p>
      <Table rows={rows} cols={cols.map((c) => [c, c.replace(/_/g, " "), (r: any) => <span style={{ whiteSpace: "pre-wrap" }}>{fmt(r[c]).slice(0, 300)}</span>])} />
    </>;
  }

  return (
    <Shell me={me} active="/owner" title="Owner view" sub="Read-only and unfiltered. Nobody can hide records from this view, and nobody, including you, can edit them." flash={flash}>
      <nav style={{ display: "flex", gap: 10, flexWrap: "wrap", marginBottom: 14 }}>
        {[["overview", "Overview"], ["accountability", "Accountability"], ...Object.keys(RAW_VIEWS).map((k) => [k, LABELS[k as RawView]])].map(([k, label]) =>
          <Link key={k} href={`/owner?view=${k}`} className={`pill ${view === k ? "ok" : ""}`}>{label}</Link>)}
      </nav>
      {body}
    </Shell>
  );
}
