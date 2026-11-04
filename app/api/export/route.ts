import { requireMe } from "@/lib/session";
import { appPool } from "@/lib/pool";
import { RAW_VIEWS, exportView, type RawView } from "@/src/server/owner";
import { DomainError } from "@/src/server/errors";

export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const me = await requireMe();
  const view = new URL(req.url).searchParams.get("view") ?? "";
  if (!(view in RAW_VIEWS)) return new Response("Unknown view", { status: 400 });
  try {
    const csv = await exportView(appPool(), me.id, view as RawView);
    const name = `${view}-${new Date().toISOString().slice(0, 10)}.csv`;
    return new Response(csv, { headers: { "content-type": "text/csv; charset=utf-8", "content-disposition": `attachment; filename="${name}"` } });
  } catch (e) {
    return new Response(e instanceof DomainError ? e.message : "Export failed", { status: e instanceof DomainError && e.code === "forbidden" ? 403 : 500 });
  }
}
