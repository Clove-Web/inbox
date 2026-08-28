import { kv } from "./kv";
import type { Pending } from "./oidc";

const SESSION_TTL_S = 60 * 60 * 24 * 7;
const PENDING_TTL_S = 60 * 10;

export async function createSession(username: string): Promise<string> {
  const token = crypto.randomUUID();
  await kv().put(`session:${token}`, username, { expirationTtl: SESSION_TTL_S });
  return token;
}

export async function isValidSession(token: string | undefined): Promise<boolean> {
  return (await sessionUser(token)) !== null;
}

export async function sessionUser(token: string | undefined): Promise<string | null> {
  if (!token) return null;
  return (await kv().get(`session:${token}`)) ?? null;
}

export async function destroySession(token: string | undefined): Promise<void> {
  if (token) await kv().delete(`session:${token}`);
}

export async function savePending(p: Pending): Promise<string> {
  const id = crypto.randomUUID();
  await kv().put(`pending:${id}`, JSON.stringify(p), { expirationTtl: PENDING_TTL_S });
  return id;
}

export async function takePending(id: string | undefined): Promise<Pending | null> {
  if (!id) return null;
  const raw = await kv().get(`pending:${id}`, "json");
  if (!raw) return null;
  await kv().delete(`pending:${id}`);
  return raw as Pending;
}
