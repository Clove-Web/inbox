import { kv, hashKey, listNames } from "./kv";
import { deleteAttachment } from "./attachments";

export type StoredAttachment = {
  id: string;
  filename: string;
  contentType: string;
  size: number;
  contentId?: string | null;
};

export type Folder = "inbox" | "sent" | "drafts";

export type StoredEmail = {
  id: string;
  from: string;
  to: string[];
  subject: string;
  html: string | null;
  text: string | null;
  receivedAt: string;
  attachments: StoredAttachment[];
  direction: "inbound" | "outbound";
  status: "sent" | "draft";
  messageId: string | null;
  inReplyTo: string | null;
  references: string | null;
  threadKey: string;
  owner: string;
};

export type DraftInput = {
  to: string[];
  subject: string;
  html: string;
  attachments: StoredAttachment[];
  from?: string;
  inReplyTo?: string | null;
  references?: string | null;
  threadKey?: string | null;
  owner: string;
};

type Rec = StoredEmail & { _seq: string; _inv: string };

const EPOCH_CAP = 10_000_000_000_000;

export function folderOf(email: Pick<StoredEmail, "direction" | "status">): Folder {
  if (email.status === "draft") return "drafts";
  return email.direction === "inbound" ? "inbox" : "sent";
}

function newOrder(): { seq: string; inv: string } {
  const ms = Date.now();
  const rand = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  return {
    seq: `${String(ms).padStart(13, "0")}-${rand}`,
    inv: `${String(EPOCH_CAP - ms).padStart(13, "0")}-${rand}`,
  };
}

function toEmail(rec: Rec): StoredEmail {
  const { _seq, _inv, ...rest } = rec;
  return rest;
}

async function readRecord(id: string): Promise<Rec | null> {
  return (await kv().get(`email:${id}`, "json")) as Rec | null;
}

async function writeIndexes(rec: Rec): Promise<void> {
  const jobs: Promise<unknown>[] = [
    kv().put(`ix:f:${folderOf(rec)}:${rec._inv}:${rec.id}`, ""),
    hashKey(rec.threadKey).then((h) => kv().put(`ix:t:${h}:${rec._seq}:${rec.id}`, "")),
  ];
  if (rec.messageId) {
    jobs.push(hashKey(rec.messageId).then((h) => kv().put(`ix:m:${h}`, rec.id)));
  }
  await Promise.all(jobs);
}

async function deleteIndexes(rec: Rec): Promise<void> {
  const jobs: Promise<unknown>[] = [
    kv().delete(`ix:f:${folderOf(rec)}:${rec._inv}:${rec.id}`),
    hashKey(rec.threadKey).then((h) => kv().delete(`ix:t:${h}:${rec._seq}:${rec.id}`)),
  ];
  if (rec.messageId) {
    jobs.push(hashKey(rec.messageId).then((h) => kv().delete(`ix:m:${h}`)));
  }
  await Promise.all(jobs);
}

function idFromKey(name: string): string {
  return name.slice(name.lastIndexOf(":") + 1);
}

export async function addEmail(email: StoredEmail): Promise<StoredEmail> {
  const existing = await readRecord(email.id);
  if (existing) return toEmail(existing);

  const { seq, inv } = newOrder();
  const rec: Rec = { ...email, _seq: seq, _inv: inv };
  await kv().put(`email:${email.id}`, JSON.stringify(rec));
  await writeIndexes(rec);
  return email;
}

export async function listEmails(folder?: Folder, owner?: string) {
  const prefixes = folder
    ? [`ix:f:${folder}:`]
    : ["ix:f:inbox:", "ix:f:sent:", "ix:f:drafts:"];

  const names: string[] = [];
  for (const p of prefixes) names.push(...(await listNames(p)));
  names.sort();

  const key = owner?.toLowerCase() ?? null;
  const records = await Promise.all(names.map((n) => readRecord(idFromKey(n))));

  const out = [];
  for (const rec of records) {
    if (!rec) continue;
    if (key && rec.owner.toLowerCase() !== key) continue;
    const { html, text, _seq, _inv, ...meta } = rec;
    out.push(meta);
  }
  return out;
}

export async function getEmail(id: string): Promise<StoredEmail | null> {
  const rec = await readRecord(id);
  return rec ? toEmail(rec) : null;
}

export async function findByMessageId(messageId: string): Promise<StoredEmail | null> {
  const id = await kv().get(`ix:m:${await hashKey(messageId)}`);
  return id ? getEmail(id) : null;
}

export async function listByThreadKey(threadKey: string, owner?: string): Promise<StoredEmail[]> {
  const names = await listNames(`ix:t:${await hashKey(threadKey)}:`);
  const ids = [...new Set(names.map(idFromKey))];
  const key = owner?.toLowerCase() ?? null;
  const records = await Promise.all(ids.map(readRecord));

  return records
    .filter((rec): rec is Rec => !!rec && (!key || rec.owner.toLowerCase() === key))
    .sort((a, b) => a.receivedAt.localeCompare(b.receivedAt))
    .map(toEmail);
}

export async function createDraft(input: DraftInput): Promise<StoredEmail> {
  const draft: StoredEmail = {
    id: crypto.randomUUID(),
    from: input.from ?? "",
    to: input.to,
    subject: input.subject,
    html: input.html,
    text: null,
    receivedAt: new Date().toISOString(),
    attachments: input.attachments,
    direction: "outbound",
    status: "draft",
    messageId: null,
    inReplyTo: input.inReplyTo ?? null,
    references: input.references ?? null,
    threadKey: input.threadKey ?? `draft::${crypto.randomUUID()}`,
    owner: input.owner,
  };
  await addEmail(draft);
  return draft;
}

export async function updateDraft(id: string, input: DraftInput): Promise<StoredEmail | null> {
  const rec = await readRecord(id);
  if (!rec || rec.status !== "draft") return null;

  const keep = new Set(input.attachments.map((a) => a.id).filter(Boolean));
  await Promise.all(
    rec.attachments
      .filter((a) => a.id && !keep.has(a.id))
      .map((a) => deleteAttachment(a.id)),
  );

  const updated: Rec = {
    ...rec,
    from: input.from ?? rec.from,
    to: input.to,
    subject: input.subject,
    html: input.html,
    attachments: input.attachments,
    receivedAt: new Date().toISOString(),
  };
  await kv().put(`email:${id}`, JSON.stringify(updated));
  return toEmail(updated);
}

export async function deleteDraft(id: string): Promise<boolean> {
  const rec = await readRecord(id);
  if (!rec || rec.status !== "draft") return false;
  await deleteIndexes(rec);
  await kv().delete(`email:${id}`);
  return true;
}

export async function deleteEmail(id: string): Promise<StoredEmail | null> {
  const rec = await readRecord(id);
  if (!rec) return null;
  await deleteIndexes(rec);
  await kv().delete(`email:${id}`);
  return toEmail(rec);
}

export async function deleteByThreadKey(threadKey: string): Promise<StoredEmail[]> {
  const names = await listNames(`ix:t:${await hashKey(threadKey)}:`);
  const ids = [...new Set(names.map(idFromKey))];
  const records = (await Promise.all(ids.map(readRecord))).filter((rec): rec is Rec => !!rec);
  if (records.length === 0) return [];

  await Promise.all(
    records.flatMap((rec) => [deleteIndexes(rec), kv().delete(`email:${rec.id}`)]),
  );
  return records.map(toEmail);
}

// Every message (inbox, sent, drafts) belonging to one mailbox user. Used by the
// admin "delete user" flow, which wipes a user's mail before removing the user.
export async function deleteByOwner(owner: string): Promise<StoredEmail[]> {
  const metas = await listEmails(undefined, owner);
  const removed = await Promise.all(metas.map((m) => deleteEmail(m.id)));
  return removed.filter((r): r is StoredEmail => r !== null);
}
