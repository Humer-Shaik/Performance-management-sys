import type { ReactNode } from "react";
import Link from "next/link";
import type { Me } from "@/lib/session";
import { logout } from "@/app/actions";

export function Shell({ me, active, title, sub, flash, children }: {
  me: Me; active: string; title: string; sub?: string; flash?: { ok?: string; error?: string }; children: ReactNode;
}) {
  const r = me.roles;
  const links: [string, string, boolean][] = [
    ["/me", "My work", true],
    ["/lead", "My team", me.leads.size > 0],
    ["/manager", "Manager", me.manages.size > 0 || r.has("manager")],
    ["/hr", "HR", r.has("hr") || r.has("head_of_hr") || r.has("admin")],
    ["/owner", "Owner view", r.has("owner") || r.has("admin")],
  ];
  return (
    <>
      <header className="top">
        <span className="brand">Performance</span>
        <nav>{links.filter((l) => l[2]).map(([href, label]) => <Link key={href} href={href} className={active === href ? "on" : ""}>{label}</Link>)}</nav>
        <span className="muted">{me.name}</span>
        <form action={logout}><button>Sign out</button></form>
      </header>
      <main>
        <h1>{title}</h1>
        {sub && <p className="sub">{sub}</p>}
        {flash?.error && <div className="flash error">{flash.error}</div>}
        {flash?.ok && <div className="flash ok">{flash.ok}</div>}
        {children}
      </main>
    </>
  );
}

const STATUS: Record<string, [string, string]> = {
  not_started: ["Not started", ""], in_progress: ["In progress", ""], blocked: ["Blocked", "bad"], in_review: ["In review", "warn"], done: ["Done", "ok"],
  on_track: ["On track", "ok"], at_risk: ["At risk", "warn"], critical: ["Critical", "bad"], overdue: ["Overdue", "bad"],
  pending: ["Pending", "warn"], approved: ["Approved", "ok"], refused: ["Refused", "bad"], escalated: ["Escalated", "warn"],
  open: ["Open", "warn"], decided: ["Decided", ""], upheld: ["Upheld", "ok"], partly_upheld: ["Partly upheld", "ok"], rejected: ["Rejected", "bad"],
  acknowledged: ["Acknowledged", ""], unanswered: ["Unanswered", "warn"], open_dispute: ["Disputed", "warn"],
  ok: ["OK", "ok"], insufficient_data: ["Insufficient data", "warn"], draft: ["Draft", ""], locked: ["Locked", "ok"], revised_by_dispute: ["Revised by dispute", "warn"],
};
export function Pill({ v }: { v?: string | null }) {
  if (!v) return <span className="muted">–</span>;
  const [label, tone] = STATUS[v] ?? [v.replace(/_/g, " "), ""];
  return <span className={`pill ${tone}`}>{label}</span>;
}

export function Changed({ was, now }: { was: unknown; now: unknown }) {
  const a = fmt(was), b = fmt(now);
  return a === b ? <>{b}</> : <><span className="was" title="original">{a}</span>{b}</>;
}

export function Bar({ pct }: { pct: number }) {
  return <div className="bar" title={`${pct}%`}><span style={{ width: `${Math.min(100, Math.max(0, pct))}%` }} /></div>;
}

export function fmt(v: unknown): string {
  if (v === null || v === undefined || v === "") return "–";
  if (v instanceof Date) return v.toISOString().replace("T", " ").slice(0, 16);
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

export function Table({ rows, cols, empty = "Nothing here." }: { rows: Record<string, any>[]; cols: [string, string, ((r: any) => ReactNode)?][]; empty?: string }) {
  if (rows.length === 0) return <div className="tablewrap"><div className="empty">{empty}</div></div>;
  return (
    <div className="tablewrap">
      <table>
        <thead><tr>{cols.map(([k, label]) => <th key={k}>{label}</th>)}</tr></thead>
        <tbody>{rows.map((r, i) => <tr key={r.id ?? i}>{cols.map(([k, , render]) => <td key={k}>{render ? render(r) : fmt(r[k])}</td>)}</tr>)}</tbody>
      </table>
    </div>
  );
}

export function Hidden({ values }: { values: Record<string, string> }) {
  return <>{Object.entries(values).map(([k, v]) => <input key={k} type="hidden" name={k} value={v} />)}</>;
}

export const POINTS = [1, 2, 3, 5, 8];
export const today = () => new Date().toISOString().slice(0, 10);

export type SearchParams = Promise<Record<string, string | string[] | undefined>>;
export async function flashFrom(sp: SearchParams) {
  const p = await sp;
  const one = (k: string) => (typeof p[k] === "string" ? (p[k] as string) : undefined);
  return { ok: one("ok"), error: one("error"), params: p, one };
}
