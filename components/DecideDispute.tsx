import * as A from "@/app/actions";
import { Hidden, POINTS } from "./ui";

export function DecideDisputeForm({ d, backTo }: { d: any; backTo: string }) {
  return (
    <form action={A.decideDispute} className="stack"><Hidden values={{ back: backTo, disputeId: d.id, targetType: d.target_type }} />
      <select name="outcome"><option value="rejected">Reject</option><option value="partly_upheld">Partly uphold</option><option value="upheld">Uphold</option></select>
      {d.target_type === "quality_rating" && <>
        <label>Corrected rating<select name="score"><option value="">No change</option>{[1, 2, 3, 4, 5].map((n) => <option key={n}>{n}</option>)}</select></label>
        <input name="example" placeholder="Example (for 4)" /><input name="evidence" placeholder="Evidence links (for 1 and 5)" />
      </>}
      {d.target_type === "estimate" && <label>Corrected effort<select name="points"><option value="">No change</option>{POINTS.map((p) => <option key={p}>{p}</option>)}</select></label>}
      {d.target_type === "deadline" && <label>Corrected due date<input type="date" name="due" /></label>}
      <textarea name="reason" placeholder="Decision and reason (recorded)" required /><button className="primary">Decide</button>
    </form>
  );
}

