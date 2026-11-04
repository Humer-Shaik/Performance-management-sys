// Session: a signed cookie holding the user id. Sign-in itself is the demo
// picker for now (DEMO_LOGIN=1); company SSO plugs in at /login later.
import { createHmac, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { loadActor, type Actor } from "@/src/server/policy";
import { one } from "@/src/server/db";
import { appPool } from "./pool";

const COOKIE = "pms_session";

function secret() {
  const s = process.env.SESSION_SECRET;
  if (!s || s.length < 32) throw new Error("SESSION_SECRET must be at least 32 characters");
  return s;
}

const sign = (v: string) => createHmac("sha256", secret()).update(v).digest("base64url");

export async function setSession(userId: string) {
  (await cookies()).set(COOKIE, `${userId}.${sign(userId)}`, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", maxAge: 60 * 60 * 12 });
}

export async function clearSession() {
  (await cookies()).delete(COOKIE);
}

async function sessionUserId(): Promise<string | null> {
  const raw = (await cookies()).get(COOKIE)?.value;
  if (!raw) return null;
  const [id, mac] = raw.split(".");
  if (!id || !mac) return null;
  const expected = Buffer.from(sign(id));
  const given = Buffer.from(mac);
  return expected.length === given.length && timingSafeEqual(expected, given) ? id : null;
}

export interface Me extends Actor { name: string; email: string }

export async function requireMe(): Promise<Me> {
  const id = await sessionUserId();
  if (!id) redirect("/login");
  const user = await one(appPool(), "SELECT name, email FROM users WHERE id = $1", [id]);
  if (!user) redirect("/login");
  const actor = await loadActor(appPool(), id);
  return { ...actor, name: user!.name, email: user!.email };
}
