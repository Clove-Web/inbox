export interface Env {
  MAILBOX_KV: KVNamespace;
  ASSETS: Fetcher;
}

let current: Env | null = null;

export function setEnv(e: Env): void {
  current = e;
}

export function env(): Env {
  if (!current) throw new Error("Worker env not initialised");
  return current;
}

export function kv(): KVNamespace {
  return env().MAILBOX_KV;
}

export async function hashKey(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export async function listNames(prefix: string): Promise<string[]> {
  const out: string[] = [];
  let cursor: string | undefined;
  do {
    const res: KVNamespaceListResult<unknown> = await kv().list({ prefix, cursor, limit: 1000 });
    for (const k of res.keys) out.push(k.name);
    cursor = res.list_complete ? undefined : res.cursor;
  } while (cursor);
  return out;
}
