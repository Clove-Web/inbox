import { kv } from "./kv";
import { bareAddress } from "./settings";
import ownersSeed from "../owners.json";

interface OwnersConfig {
  domain: string;
  admins: string[];
  catchAll: string;
  owners: Record<string, string[]>;
}

function normalize(raw: Partial<OwnersConfig>): OwnersConfig {
  const domain = (raw.domain || "").toLowerCase();
  const owners: Record<string, string[]> = {};
  for (const [user, entries] of Object.entries(raw.owners || {})) {
    owners[user.toLowerCase()] = Array.from(
      new Set((entries || []).map((e) => e.trim().toLowerCase()).filter(Boolean)),
    );
  }
  return {
    domain,
    admins: (raw.admins || []).map((a) => a.toLowerCase()),
    catchAll: (raw.catchAll || "").toLowerCase(),
    owners,
  };
}

function loadSeed(): OwnersConfig {
  return normalize(ownersSeed as Partial<OwnersConfig>);
}

let cfg: OwnersConfig | null = null;

function state(): OwnersConfig {
  if (!cfg) cfg = loadSeed();
  return cfg;
}

async function save(): Promise<void> {
  const s = state();
  await kv().put("owners:config", JSON.stringify(s));
}

export async function initOwners(): Promise<void> {
  const stored = (await kv().get("owners:config", "json")) as Partial<OwnersConfig> | null;
  if (stored) {
    cfg = normalize(stored);
    return;
  }
  cfg = loadSeed();
  await kv().put("owners:config", JSON.stringify(cfg));
}

function expand(entry: string): string {
  const e = entry.trim().toLowerCase();
  if (!e) return "";
  return e.includes("@") ? e : `${e}@${state().domain}`;
}

function autoAddress(username: string): string {
  return `${username.toLowerCase()}@${state().domain}`;
}

function knownUsers(): string[] {
  const s = state();
  return Array.from(new Set([...Object.keys(s.owners), ...s.admins, s.catchAll].filter(Boolean)));
}

function ownerIndex(): Map<string, string> {
  const s = state();
  const map = new Map<string, string>();
  for (const user of knownUsers()) {
    map.set(bareAddress(autoAddress(user)), user);
  }
  for (const [user, entries] of Object.entries(s.owners)) {
    for (const entry of entries) map.set(bareAddress(expand(entry)), user);
  }
  return map;
}

export function isAdmin(username: string): boolean {
  return state().admins.includes(username.toLowerCase());
}

export function ownerOf(address: string): string {
  return ownerIndex().get(bareAddress(address)) ?? state().catchAll;
}

export function ownerForRecipients(recipients: string[]): string {
  const idx = ownerIndex();
  for (const r of recipients) {
    const owner = idx.get(bareAddress(r));
    if (owner) return owner;
  }
  return state().catchAll;
}

export function addressesFor(username: string): string[] {
  const s = state();
  const u = username.toLowerCase();
  if (s.admins.includes(u)) return allAddresses();
  const extras = (s.owners[u] ?? []).map(expand);
  return Array.from(new Set([autoAddress(u), ...extras].filter(Boolean)));
}

export function allAddresses(): string[] {
  return Array.from(new Set(ownerIndex().keys()));
}

export function canSendAs(username: string, address: string): boolean {
  const bare = bareAddress(address);
  return addressesFor(username).some((a) => bareAddress(a) === bare);
}

export function canAccessOwner(username: string, owner: string): boolean {
  const u = username.toLowerCase();
  return isAdmin(u) || u === (owner || "").toLowerCase();
}

export function resolveFromFor(username: string, requested?: string | null): string {
  const owned = addressesFor(username);
  if (requested) {
    const bare = bareAddress(requested);
    const match = owned.find((a) => bareAddress(a) === bare);
    if (match) return match;
  }
  return owned[0] ?? "";
}

export async function ensureUser(username: string): Promise<void> {
  const s = state();
  const u = username.toLowerCase();
  if (!u) return;
  if (s.admins.includes(u) || u === s.catchAll || u in s.owners) return;
  s.owners[u] = [];
  await save();
}

export async function assignAddress(username: string, address: string): Promise<OwnersState> {
  const s = state();
  const u = username.toLowerCase();
  const full = expand(address);
  if (!full || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(full)) {
    throw new Error("Invalid email address");
  }
  if (!(u in s.owners) && !s.admins.includes(u) && u !== s.catchAll) {
    s.owners[u] = [];
  }
  for (const key of Object.keys(s.owners)) {
    s.owners[key] = (s.owners[key] ?? []).filter(
      (e) => bareAddress(expand(e)) !== bareAddress(full),
    );
  }
  if (bareAddress(full) !== bareAddress(autoAddress(u))) {
    (s.owners[u] ??= []).push(full);
  }
  await save();
  return dashboardState();
}

export async function unassignAddress(username: string, address: string): Promise<OwnersState> {
  const s = state();
  const u = username.toLowerCase();
  const bare = bareAddress(expand(address));
  const list = s.owners[u];
  if (list) {
    s.owners[u] = list.filter((e) => bareAddress(expand(e)) !== bare);
  }
  await save();
  return dashboardState();
}

export interface OwnersUser {
  username: string;
  isAdmin: boolean;
  auto: string;
  reserved: string[];
  addresses: string[];
}
export interface OwnersState {
  domain: string;
  catchAll: string;
  users: OwnersUser[];
}

export function dashboardState(): OwnersState {
  const s = state();
  const users = knownUsers().map((u) => ({
    username: u,
    isAdmin: s.admins.includes(u),
    auto: autoAddress(u),
    reserved: (s.owners[u] ?? []).map(expand),
    addresses: addressesFor(u),
  }));
  return { domain: s.domain, catchAll: s.catchAll, users };
}
