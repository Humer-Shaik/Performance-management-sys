import { login } from "@/app/actions";
import { demoUsers } from "@/lib/queries";
import { flashFrom, type SearchParams } from "@/components/ui";

export const dynamic = "force-dynamic";

export default async function Login({ searchParams }: { searchParams: SearchParams }) {
  const flash = await flashFrom(searchParams);
  const demo = process.env.DEMO_LOGIN === "1";
  const users = demo ? await demoUsers() : [];
  return (
    <main style={{ maxWidth: 560 }}>
      <h1>Sign in</h1>
      {flash.error && <div className="flash error">{flash.error}</div>}
      {demo ? (
        <>
          <p className="sub">Demo sign-in: pick a person to see the system as them. Company sign-in replaces this before launch.</p>
          <form action={login} className="stack">
            <label>Person
              <select name="userId" required>
                {users.map((u) => <option key={u.id} value={u.id}>{u.name} ({u.roles || "no role"})</option>)}
              </select>
            </label>
            <button className="primary">Sign in</button>
          </form>
        </>
      ) : <p className="sub">Company sign-in is not configured yet. Set DEMO_LOGIN=1 to use the demo picker.</p>}
    </main>
  );
}
