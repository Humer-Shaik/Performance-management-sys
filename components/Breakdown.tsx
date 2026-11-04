import { Pill, fmt } from "./ui";

/** The score with every signal, the tasks that counted, and why any were left out. */
export function Breakdown({ b }: { b: { total: number | null; status: string; ruleVersion: string; computedAt: Date; signals: any[] } }) {
  return (
    <div className="panel">
      <div style={{ display: "flex", gap: 16, alignItems: "baseline", flexWrap: "wrap" }}>
        <div style={{ fontSize: 28, fontWeight: 650 }}>{b.total === null ? "Insufficient data" : b.total.toFixed(1)}</div>
        <Pill v={b.status} />
        <span className="muted">Rules {b.ruleVersion} · calculated {fmt(b.computedAt)}</span>
      </div>
      {b.signals.map((s) => (
        <details key={s.name} open={s.status !== "ok"}>
          <summary>
            {s.name[0].toUpperCase() + s.name.slice(1)}: {s.value === null ? "–" : s.value.toFixed(1)} · weight {Math.round(s.weight * 100)}%
            {s.status === "ok" ? ` (counts ${Math.round(s.effectiveWeight * 100)}%)` : ""} · <Pill v={s.status} />
          </summary>
          <p className="muted" style={{ margin: "6px 0" }}>{s.explanation}</p>
          {s.tasks.length > 0 && (
            <div className="tablewrap"><table><thead><tr><th>Subtask</th><th>Counted</th><th>Details</th></tr></thead>
              <tbody>{s.tasks.map((t: any) => (
                <tr key={t.subtaskId}><td>{t.title}</td><td>{t.counted ? "Yes" : <span className="muted">No: {t.excludedReason}</span>}</td>
                  <td className="muted">{Object.entries(t.detail).filter(([, v]) => v !== null && !(Array.isArray(v) && v.length === 0)).map(([k, v]) => `${k}: ${fmt(v)}`).join(" · ")}</td></tr>
              ))}</tbody></table></div>
          )}
        </details>
      ))}
    </div>
  );
}
