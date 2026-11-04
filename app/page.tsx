import { redirect } from "next/navigation";
import { requireMe } from "@/lib/session";

export const dynamic = "force-dynamic";

export default async function Home() {
  const me = await requireMe();
  if (me.roles.has("owner")) redirect("/owner");
  if (me.manages.size > 0) redirect("/manager");
  if (me.leads.size > 0) redirect("/lead");
  if (me.roles.has("hr") || me.roles.has("head_of_hr")) redirect("/hr");
  redirect("/me");
}
