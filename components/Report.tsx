import { Table } from "./ui";

/** A lead's accountability report: the numbers, with flags as questions to look at. */
export function LeadReport({ r, name }: { r: any; name?: string }) {
  return (
    <div className="panel">
      {name && <h3 style={{ margin: "0 0 8px" }}>{name}</h3>}
      {r.flags.length === 0 ? <p className="muted">No patterns flagged.</p> : (
        <ul className="flags">{r.flags.map((f: any, i: number) => <li key={i}><span className="pill warn">{f.measure}</span> {f.message}</li>)}</ul>
      )}
      <p className="muted" style={{ fontSize: 12 }}>A flag is a question to look at, not a verdict.</p>
      <div className="grid">
        <div><strong>Workload</strong>
          <Table rows={r.workload} cols={[["name", "Person"], ["points", "Points"], ["vsTeamPct", "vs team %"], ["highShare", "High-effort share", (w) => `${Math.round(w.highShare * 100)}%`]]} />
        </div>
        <div>
          <p><strong>Deadlines:</strong> {r.deadlines.shortLead} of {r.deadlines.subtasks} below minimum lead time</p>
          <p><strong>Ratings:</strong> average {r.ratings.average ?? "–"} (company {r.ratings.companyAverage ?? "–"}), {r.ratings.count} ratings</p>
          <p><strong>Blockers:</strong> {r.blockers.total} raised, {r.blockers.slow} answered late, {r.blockers.disputed_then_upheld} disputed then upheld</p>
          <p><strong>Disputes:</strong> {r.disputes.overturned} of {r.disputes.decided} decisions overturned</p>
          <p><strong>Goals:</strong> {r.goals.late} of {r.goals.total} late</p>
        </div>
      </div>
    </div>
  );
}
