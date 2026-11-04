import { requireMe } from "@/lib/session";
import * as Q from "@/lib/queries";
import { appPool } from "@/lib/pool";
import { leadReport } from "@/src/server/reports";
import * as A from "@/app/actions";
import { Hidden, Pill, Shell, Table, flashFrom, type SearchParams } from "@/components/ui";
import { LeadReport } from "@/components/Report";
import { DecideDisputeForm } from "@/components/DecideDispute";

export const dynamic = "force-dynamic";
const back = { back: "/hr" };

export default async function HrPage({ searchParams }: { searchParams: SearchParams }) {
  const me = await requireMe();
  const flash = await flashFrom(searchParams);
  const [periods, disputes, leads] = await Promise.all([Q.periods(), Q.disputesToDecide(me.id), Q.leads()]);
  const period = flash.one("period") ?? periods[0]?.id;
  const reports = period ? await Promise.all(leads.map(async (l) => ({ l, r: await leadReport(appPool(), me.id, l.id, period).catch(() => null) }))) : [];

  return (
    <Shell me={me} active="/hr" title="HR" sub="Quarters, disputes and lead accountability." flash={flash}>
      <h2>Quarters</h2>
      <Table rows={periods} empty="No quarters yet." cols={[["id", "Quarter"], ["starts_on", "Starts"], ["ends_on", "Ends"], ["locked_at", "Locked", (p) => p.locked_at ? <Pill v="locked" /> : <span className="muted">Open</span>]]} />
      <details><summary>Open a quarter</summary>
        <form action={A.openPeriod} className="stack panel"><Hidden values={back} />
          <label>Id<input name="id" placeholder="2027-Q1" pattern="\d{4}-Q[1-4]" required /></label>
          <label>Starts<input type="date" name="startsOn" required /></label><label>Ends<input type="date" name="endsOn" required /></label>
          <button className="primary">Open</button></form></details>
      <p className="muted">Scores are calculated nightly and locked after each quarter ends by the scheduled job (<code>npm run jobs</code>). Nobody can lock or edit them by hand.</p>

      <h2>Disputes to decide</h2>
      <Table rows={disputes} empty="No disputes assigned to you." cols={[
        ["filed_by_name", "Filed by"], ["target_type", "About"], ["challenged_name", "Decision by"], ["evidence", "Evidence"], ["due_at", "Decide by"],
        ["state", "", (d) => <Pill v={d.state} />],
        ["a", "", (d) => <details><summary>Decide</summary><DecideDisputeForm d={d} backTo="/hr" /></details>],
      ]} />

      <h2>Lead accountability</h2>
      {periods.length > 0 && <form className="inline" method="get"><select name="period" defaultValue={period}>{periods.map((p) => <option key={p.id}>{p.id}</option>)}</select><button>Show</button></form>}
      {reports.map(({ l, r }) => r && <LeadReport key={l.id} r={r} name={l.name} />)}
    </Shell>
  );
}
