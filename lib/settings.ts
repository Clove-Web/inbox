import { kv } from "./kv";

export type Settings = {
  fromAddresses: string[];
  defaultFrom: string | null;
};

export function bareAddress(input: string | undefined | null): string {
  if (!input) return "";
  const match = input.match(/<([^>]+)>/);
  return (match?.[1] ? match[1] : input).trim().toLowerCase();
}

export function isValidAddress(input: string): boolean {
  const bare = bareAddress(input);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(bare);
}

export function parseAddressList(raw: string | undefined | null): string[] {
  if (!raw) return [];
  return raw
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function dedupe(list: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const a of list) {
    const key = bareAddress(a);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(a);
  }
  return out;
}

function seedFromEnv(): Settings {
  const seeded = dedupe(parseAddressList(process.env.SEND_FROM));
  return {
    fromAddresses: seeded,
    defaultFrom: seeded[0] ?? null,
  };
}

function normalize(raw: unknown): Settings {
  const r = (raw ?? {}) as Record<string, unknown>;
  const fromAddresses = Array.isArray(r.fromAddresses)
    ? dedupe(r.fromAddresses.filter((x): x is string => typeof x === "string"))
    : [];

  let defaultFrom = typeof r.defaultFrom === "string" ? r.defaultFrom : null;
  const df = defaultFrom;
  if (df && !fromAddresses.some((a) => bareAddress(a) === bareAddress(df))) {
    defaultFrom = null;
  }
  if (!defaultFrom && fromAddresses.length) defaultFrom = fromAddresses[0] ?? null;

  return { fromAddresses, defaultFrom };
}

export async function getSettings(): Promise<Settings> {
  const raw = await kv().get("settings", "json");
  return raw ? normalize(raw) : seedFromEnv();
}

async function mutate(fn: (s: Settings) => void): Promise<Settings> {
  const s = await getSettings();
  fn(s);
  const next = normalize(s);
  await kv().put("settings", JSON.stringify(next));
  return next;
}

export function addFromAddress(address: string): Promise<Settings> {
  const clean = address.trim();
  if (!isValidAddress(clean)) return Promise.reject(new Error("Invalid email address"));
  return mutate((s) => {
    if (!s.fromAddresses.some((a) => bareAddress(a) === bareAddress(clean))) {
      s.fromAddresses.push(clean);
    }
    if (!s.defaultFrom) s.defaultFrom = s.fromAddresses[0] ?? null;
  });
}

export function removeFromAddress(address: string): Promise<Settings> {
  const key = bareAddress(address);
  return mutate((s) => {
    s.fromAddresses = s.fromAddresses.filter((a) => bareAddress(a) !== key);
    if (s.defaultFrom && bareAddress(s.defaultFrom) === key) {
      s.defaultFrom = s.fromAddresses[0] ?? null;
    }
  });
}

export function setDefaultFrom(address: string): Promise<Settings> {
  return mutate((s) => {
    const match = s.fromAddresses.find((a) => bareAddress(a) === bareAddress(address));
    if (!match) throw new Error("Address is not in the list");
    s.defaultFrom = match;
  });
}

export async function resolveFrom(requested?: string | null): Promise<string> {
  const s = await getSettings();
  if (requested) {
    const match = s.fromAddresses.find((a) => bareAddress(a) === bareAddress(requested));
    if (match) return match;
  }
  if (s.defaultFrom) return s.defaultFrom;
  if (s.fromAddresses[0]) return s.fromAddresses[0];
  return parseAddressList(process.env.SEND_FROM)[0] ?? "";
}

export async function getMyAddresses(): Promise<string[]> {
  const s = await getSettings();
  const set = new Set<string>();
  for (const a of [...s.fromAddresses, ...parseAddressList(process.env.SEND_FROM)]) {
    const bare = bareAddress(a);
    if (bare) set.add(bare);
  }
  return [...set];
}
