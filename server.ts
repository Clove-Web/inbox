import { Hono } from "hono";
import { getCookie, setCookie, deleteCookie } from "hono/cookie";
import { Resend } from "resend";
import {
  addEmail,
  getEmail,
  listEmails,
  listByThreadKey,
  createDraft,
  updateDraft,
  deleteDraft,
  deleteEmail,
  deleteByThreadKey,
  type Folder,
  type StoredEmail,
  type StoredAttachment,
} from "./lib/store";
import {
  readAttachment,
  saveAttachment,
  deleteAttachment,
  toResendAttachment,
  persistInboundAttachments,
} from "./lib/attachments";
import {
  createSession,
  sessionUser,
  destroySession,
  savePending,
  takePending,
} from "./lib/auth";
import {
  initOidc,
  buildAuthUrl,
  completeLogin,
  endSessionUrl,
} from "./lib/oidc";
import {
  isAdmin,
  ensureUser,
  addressesFor,
  allAddresses,
  ownerForRecipients,
  canAccessOwner,
  resolveFromFor,
  dashboardState,
  assignAddress,
  unassignAddress,
  initOwners,
} from "./lib/owners";
import { bareAddress } from "./lib/settings";
import {
  pushConfigured,
  vapidPublicKey,
  addSubscription,
  removeSubscription,
  subscriptionCount,
  sendToAll,
} from "./lib/push";
import { setEnv, env, type Env } from "./lib/kv";
import type { PushSubscription } from "./lib/webpush";

type UploadedAttachment = { filename: string; contentType: string; content: string };

async function persistUploads(uploads: UploadedAttachment[] | undefined): Promise<StoredAttachment[]> {
  if (!uploads?.length) return [];
  return Promise.all(uploads.map((u) => saveAttachment(u.filename, u.contentType, u.content)));
}

type MixedAttachment =
  | { id: string; filename: string; contentType: string; size: number }
  | UploadedAttachment;

async function resolveAttachments(items: MixedAttachment[] | undefined): Promise<StoredAttachment[]> {
  if (!items?.length) return [];
  const resolved = await Promise.all(
    items.map((item) =>
      "id" in item && item.id
        ? Promise.resolve(item as StoredAttachment)
        : saveAttachment(
            (item as UploadedAttachment).filename,
            (item as UploadedAttachment).contentType,
            (item as UploadedAttachment).content,
          ),
    ),
  );
  return resolved;
}

async function toResendAttachments(attachments: StoredAttachment[]) {
  const resolved = await Promise.all(attachments.map(toResendAttachment));
  return resolved.filter((a): a is { filename: string; content: string } => a !== null);
}

function parseFolder(value: string | undefined): Folder | undefined {
  return value === "inbox" || value === "sent" || value === "drafts" ? value : undefined;
}

const resend = new Resend(process.env.RESEND_API_KEY);
const webhookSecret = process.env.RESEND_WEBHOOK_SECRET ?? "";
const sendFrom = (process.env.SEND_FROM ?? "").split(/[,\n]/)[0]?.trim() ?? "";
const cookieSecure = process.env.COOKIE_SECURE === "true";

function computeThreadKey(subject: string, from: string, to: string[], myAddresses: string[]): string {
  const cleanSubject = (subject || "")
    .replace(/^\s*(re|fwd?)\s*:\s*/i, "")
    .trim()
    .toLowerCase();

  const me = new Set(myAddresses);
  const participants = [bareAddress(from), ...to.map(bareAddress)]
    .filter((addr) => addr && !me.has(addr))
    .sort();

  const counterpart = participants[0] ?? bareAddress(from);
  return `${cleanSubject}::${counterpart}`;
}

function pickReplyFrom(user: string, original: StoredEmail, requested?: string | null): string {
  const owned = addressesFor(user);
  const inOwned = (addr: string | undefined | null) =>
    owned.find((a) => bareAddress(a) === bareAddress(addr));

  if (requested) {
    const match = inOwned(requested);
    if (match) return match;
  }
  const targets = original.direction === "inbound" ? original.to : [original.from];
  for (const t of targets) {
    const match = inOwned(t);
    if (match) return match;
  }
  return owned[0] ?? sendFrom;
}

function buildReferences(original: { references: string | null; messageId: string | null }): string {
  const prior = original.references ? original.references.split(/\s+/).filter(Boolean) : [];
  if (original.messageId) prior.push(original.messageId);
  return prior.join(" ");
}

async function purgeAttachmentFiles(emails: StoredEmail[]): Promise<void> {
  const ids = emails.flatMap((e) => e.attachments).map((a) => a.id).filter(Boolean);
  await Promise.all(ids.map((id) => deleteAttachment(id)));
}

type ServableAttachment = StoredAttachment & { inline?: boolean };
type ServableEmail = Omit<StoredEmail, "attachments"> & { attachments: ServableAttachment[] };

function inlineCidImages(email: StoredEmail): ServableEmail {
  const attachments: ServableAttachment[] = email.attachments.map((a) => ({ ...a }));

  const byContentId = new Map<string, StoredAttachment>();
  for (const a of email.attachments) {
    if (a.id && a.contentId) byContentId.set(a.contentId.toLowerCase(), a);
  }

  if (!email.html || !email.html.includes("cid:") || byContentId.size === 0) {
    return { ...email, attachments };
  }

  const usedIds = new Set<string>();
  const html = email.html.replace(/cid:([^"'\s>)]+)/gi, (whole, rawId: string) => {
    const key = rawId.replace(/^<|>$/g, "").trim().toLowerCase();
    const match = byContentId.get(key);
    if (!match) return whole;
    usedIds.add(match.id);
    return `/api/emails/${email.id}/attachments/${match.id}?inline=1`;
  });

  return {
    ...email,
    html,
    attachments: attachments.map((a) => (usedIds.has(a.id) ? { ...a, inline: true } : a)),
  };
}

function sendAsset(req: Request, file: string): Promise<Response> {
  return env().ASSETS.fetch(new Request(new URL(file, req.url)));
}

const app = new Hono<{ Variables: { user: string } }>();

const PUBLIC_PATHS = new Set([
  "/login",
  "/login.html",
  "/login.js",
  "/style.css",
  "/favicon.ico",
  "/apple-touch-icon.png",
  "/auth/login",
  "/auth/callback",
  "/sw.js",
  "/manifest.webmanifest",
]);

app.use("/*", async (c, next) => {
  const path = c.req.path;
  if (path === "/webhook/inbound" || PUBLIC_PATHS.has(path)) {
    return next();
  }

  const token = getCookie(c, "session");
  const user = await sessionUser(token);
  if (!user) {
    if (path.startsWith("/api/")) return c.json({ error: "Unauthorized" }, 401);
    return c.redirect("/login");
  }

  c.set("user", user);
  return next();
});

app.get("/login", (c) => sendAsset(c.req.raw, "/login.html"));

app.get("/auth/login", async (c) => {
  try {
    const from = c.req.query("from") || "/inbox";
    const { url, pending } = await buildAuthUrl(from);
    const id = await savePending(pending);
    setCookie(c, "login", id, {
      httpOnly: true,
      sameSite: "Lax",
      secure: cookieSecure,
      path: "/",
      maxAge: 600,
    });
    return c.redirect(url);
  } catch (err) {
    console.error("OIDC login start failed", err);
    return c.text("Login is temporarily unavailable.", 500);
  }
});

app.get("/auth/callback", async (c) => {
  const code = c.req.query("code");
  const stateParam = c.req.query("state");
  const err = c.req.query("error");
  if (err) return c.text(`Login failed: ${err}`, 401);

  const pending = await takePending(getCookie(c, "login"));
  deleteCookie(c, "login", { path: "/" });

  if (!pending || !code || !stateParam || stateParam !== pending.state) {
    return c.redirect("/login");
  }

  try {
    const { username } = await completeLogin(code, pending);
    await ensureUser(username);
    const token = await createSession(username);
    setCookie(c, "session", token, {
      httpOnly: true,
      sameSite: "Lax",
      secure: cookieSecure,
      path: "/",
      maxAge: 60 * 60 * 24 * 7,
    });
    return c.redirect(pending.returnTo);
  } catch (e) {
    console.error("OIDC callback error", e);
    return c.text("Login failed.", 401);
  }
});

app.get("/", (c) => sendAsset(c.req.raw, "/index.html"));
app.get("/inbox", (c) => sendAsset(c.req.raw, "/index.html"));
app.get("/sent", (c) => sendAsset(c.req.raw, "/index.html"));
app.get("/drafts", (c) => sendAsset(c.req.raw, "/index.html"));
app.get("/settings", (c) => sendAsset(c.req.raw, "/settings.html"));

app.post("/api/logout", async (c) => {
  await destroySession(getCookie(c, "session"));
  deleteCookie(c, "session", { path: "/" });
  return c.json({ ok: true, endSession: endSessionUrl() });
});

app.get("/api/me", (c) => {
  const user = c.get("user");
  return c.json({
    username: user,
    displayName: user,
    isAdmin: isAdmin(user),
    addresses: addressesFor(user),
  });
});

app.post("/webhook/inbound", async (c) => {
  const payload = await c.req.text();

  let event: any;
  try {
    event = resend.webhooks.verify({
      payload,
      headers: {
        id: c.req.header("svix-id") ?? "",
        timestamp: c.req.header("svix-timestamp") ?? "",
        signature: c.req.header("svix-signature") ?? "",
      },
      webhookSecret,
    });
  } catch (err) {
    console.error("Webhook signature verification failed", err);
    return c.text("Invalid signature", 401);
  }

  if (event.type !== "email.received") {
    return c.json({ ok: true, ignored: event.type });
  }

  const emailId = event.data.email_id;

  const { data: full, error } = await resend.emails.receiving.get(emailId);
  if (error || !full) {
    console.error("Failed to fetch received email content", error);
    return c.json({ ok: false }, 500);
  }

  const subject = full.subject ?? "(no subject)";
  const to = full.to ?? [];
  const inReplyTo = full.headers?.["in-reply-to"] ?? null;
  const references = full.headers?.["references"] ?? null;
  const attachments = await persistInboundAttachments(full.attachments ?? []);
  const myAddresses = allAddresses().map(bareAddress);
  const owner = ownerForRecipients(to);

  await addEmail({
    id: full.id,
    from: full.from,
    to,
    subject,
    html: full.html ?? null,
    text: full.text ?? null,
    receivedAt: full.created_at,
    attachments,
    direction: "inbound",
    status: "sent",
    messageId: full.message_id ?? null,
    inReplyTo,
    references,
    threadKey: computeThreadKey(subject, full.from, to, myAddresses),
    owner,
  });

  try {
    await sendToAll({
      title: full.from ? `New email from ${full.from}` : "New email",
      body: subject,
      url: "/inbox",
      tag: full.id,
    });
  } catch (err) {
    console.error("Push notification failed", err);
  }

  return c.json({ ok: true });
});

app.get("/api/emails", async (c) => {
  const user = c.get("user");
  const folder = parseFolder(c.req.query("folder"));
  const emails = await listEmails(folder, isAdmin(user) ? undefined : user);
  return c.json(emails);
});

app.get("/api/emails/:id/attachments/:attachmentId", async (c) => {
  const email = await getEmail(c.req.param("id"));
  if (!email || !canAccessOwner(c.get("user"), email.owner)) {
    return c.json({ error: "Not found" }, 404);
  }

  const attachmentId = c.req.param("attachmentId");
  const meta = email.attachments.find((a) => a.id === attachmentId);
  if (!meta || !meta.id) return c.json({ error: "Not found" }, 404);

  const bytes = await readAttachment(meta.id);
  if (!bytes) return c.json({ error: "Not found" }, 404);

  const disposition = c.req.query("inline") === "1" ? "inline" : "attachment";

  return new Response(bytes, {
    headers: {
      "Content-Type": meta.contentType,
      "Content-Disposition": `${disposition}; filename="${meta.filename.replace(/"/g, "")}"`,
      "Content-Length": String(meta.size),
    },
  });
});

app.get("/api/emails/:id", async (c) => {
  const email = await getEmail(c.req.param("id"));
  if (!email || !canAccessOwner(c.get("user"), email.owner)) {
    return c.json({ error: "Not found" }, 404);
  }
  return c.json(inlineCidImages(email));
});

app.delete("/api/emails/:id", async (c) => {
  const email = await getEmail(c.req.param("id"));
  if (!email || !canAccessOwner(c.get("user"), email.owner)) {
    return c.json({ error: "Not found" }, 404);
  }
  const removed = await deleteEmail(email.id);
  if (removed) await purgeAttachmentFiles([removed]);
  return c.json({ ok: true });
});

app.delete("/api/emails/:id/thread", async (c) => {
  const original = await getEmail(c.req.param("id"));
  if (!original || !canAccessOwner(c.get("user"), original.owner)) {
    return c.json({ error: "Not found" }, 404);
  }
  const removed = await deleteByThreadKey(original.threadKey);
  await purgeAttachmentFiles(removed);
  return c.json({ ok: true, count: removed.length });
});

app.post("/api/uploads", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body?.content || typeof body.content !== "string") {
    return c.json({ error: "content is required" }, 400);
  }
  const stored = await saveAttachment(
    typeof body.filename === "string" ? body.filename : "attachment",
    typeof body.contentType === "string" ? body.contentType : "application/octet-stream",
    body.content,
  );
  return c.json(stored);
});

app.post("/api/send", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body?.to || !body?.subject || !body?.html) {
    return c.json({ error: "to, subject, and html are required" }, 400);
  }

  const user = c.get("user");
  const from = resolveFromFor(user, body.from);
  if (!from) return c.json({ error: "You have no send-from address." }, 400);
  const stored = await resolveAttachments(body.attachments);
  const resendAttachments = await toResendAttachments(stored);

  const { data, error } = await resend.emails.send({
    from,
    to: body.to,
    subject: body.subject,
    html: body.html,
    attachments: resendAttachments.length ? resendAttachments : undefined,
  });

  if (error) return c.json({ error: error.message }, 400);

  const to = [body.to];
  const myAddresses = allAddresses().map(bareAddress);
  await addEmail({
    id: data.id,
    from,
    to,
    subject: body.subject,
    html: body.html,
    text: null,
    receivedAt: new Date().toISOString(),
    attachments: stored,
    direction: "outbound",
    status: "sent",
    messageId: null,
    inReplyTo: null,
    references: null,
    threadKey: computeThreadKey(body.subject, from, to, myAddresses),
    owner: user,
  });

  return c.json(data);
});

app.post("/api/emails/:id/reply", async (c) => {
  const user = c.get("user");
  const original = await getEmail(c.req.param("id"));
  if (!original || !canAccessOwner(user, original.owner)) {
    return c.json({ error: "Not found" }, 404);
  }

  const body = await c.req.json().catch(() => null);
  if (!body?.html) return c.json({ error: "html is required" }, 400);

  const to = body.to ?? original.from;
  const subject = /^\s*re\s*:/i.test(original.subject)
    ? original.subject
    : `Re: ${original.subject}`;

  const headers: Record<string, string> = {};
  if (original.messageId) {
    headers["In-Reply-To"] = original.messageId;
    headers["References"] = buildReferences(original);
  }

  const from = pickReplyFrom(user, original, body.from);
  const stored = await resolveAttachments(body.attachments);
  const resendAttachments = await toResendAttachments(stored);

  const { data, error } = await resend.emails.send({
    from,
    to,
    subject,
    html: body.html,
    headers,
    attachments: resendAttachments.length ? resendAttachments : undefined,
  });

  if (error) return c.json({ error: error.message }, 400);

  await addEmail({
    id: data.id,
    from,
    to: [to],
    subject,
    html: body.html,
    text: null,
    receivedAt: new Date().toISOString(),
    attachments: stored,
    direction: "outbound",
    status: "sent",
    messageId: null,
    inReplyTo: original.messageId,
    references: headers["References"] ?? null,
    threadKey: original.threadKey,
    owner: original.owner,
  });

  return c.json(data);
});

app.post("/api/emails/:id/forward", async (c) => {
  const user = c.get("user");
  const original = await getEmail(c.req.param("id"));
  if (!original || !canAccessOwner(user, original.owner)) {
    return c.json({ error: "Not found" }, 404);
  }

  const body = await c.req.json().catch(() => null);
  if (!body?.to) return c.json({ error: "to is required" }, 400);

  const from = pickReplyFrom(user, original, body.from);

  if (original.direction === "inbound") {
    const { data, error } = await resend.emails.receiving.forward({
      emailId: original.id,
      to: body.to,
      from,
    });
    if (error) return c.json({ error: error.message }, 400);
    return c.json(data);
  }

  const { data, error } = await resend.emails.send({
    from,
    to: body.to,
    subject: /^\s*fwd?\s*:/i.test(original.subject) ? original.subject : `Fwd: ${original.subject}`,
    html: original.html ?? `<pre>${original.text ?? ""}</pre>`,
  });
  if (error) return c.json({ error: error.message }, 400);
  return c.json(data);
});

app.get("/api/emails/:id/thread", async (c) => {
  const user = c.get("user");
  const original = await getEmail(c.req.param("id"));
  if (!original || !canAccessOwner(user, original.owner)) {
    return c.json({ error: "Not found" }, 404);
  }
  const thread = await listByThreadKey(original.threadKey, isAdmin(user) ? undefined : user);
  return c.json(thread.map(inlineCidImages));
});

app.post("/api/drafts", async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body?.subject && !body?.html && !body?.to) {
    return c.json({ error: "Nothing to save" }, 400);
  }

  const stored = await resolveAttachments(body.attachments);
  const draft = await createDraft({
    to: body.to ? [body.to].flat() : [],
    subject: body.subject ?? "",
    html: body.html ?? "",
    from: typeof body.from === "string" ? body.from : undefined,
    attachments: stored,
    owner: c.get("user"),
  });

  return c.json(draft);
});

app.put("/api/drafts/:id", async (c) => {
  const user = c.get("user");
  const body = await c.req.json().catch(() => null);
  if (!body) return c.json({ error: "Invalid body" }, 400);

  const existing = await getEmail(c.req.param("id"));
  if (!existing || existing.status !== "draft" || !canAccessOwner(user, existing.owner)) {
    return c.json({ error: "Not found" }, 404);
  }

  const stored = await resolveAttachments(body.attachments);
  const draft = await updateDraft(c.req.param("id"), {
    to: body.to ? [body.to].flat() : [],
    subject: body.subject ?? "",
    html: body.html ?? "",
    from: typeof body.from === "string" ? body.from : undefined,
    attachments: stored,
    owner: existing.owner,
  });

  if (!draft) return c.json({ error: "Not found" }, 404);
  return c.json(draft);
});

app.delete("/api/drafts/:id", async (c) => {
  const draft = await getEmail(c.req.param("id"));
  if (!draft || draft.status !== "draft" || !canAccessOwner(c.get("user"), draft.owner)) {
    return c.json({ error: "Not found" }, 404);
  }
  await deleteDraft(draft.id);
  await purgeAttachmentFiles([draft]);
  return c.json({ ok: true });
});

app.post("/api/drafts/:id/send", async (c) => {
  const user = c.get("user");
  const draft = await getEmail(c.req.param("id"));
  if (!draft || draft.status !== "draft" || !canAccessOwner(user, draft.owner)) {
    return c.json({ error: "Not found" }, 404);
  }
  if (!draft.to.length || !draft.subject || !draft.html) {
    return c.json({ error: "to, subject, and html are required" }, 400);
  }

  const from = resolveFromFor(draft.owner, draft.from || undefined);
  const resendAttachments = await toResendAttachments(draft.attachments);

  const { data, error } = await resend.emails.send({
    from,
    to: draft.to,
    subject: draft.subject,
    html: draft.html,
    attachments: resendAttachments.length ? resendAttachments : undefined,
  });

  if (error) return c.json({ error: error.message }, 400);

  const myAddresses = allAddresses().map(bareAddress);
  await deleteDraft(draft.id);
  await addEmail({
    id: data.id,
    from,
    to: draft.to,
    subject: draft.subject,
    html: draft.html,
    text: null,
    receivedAt: new Date().toISOString(),
    attachments: draft.attachments,
    direction: "outbound",
    status: "sent",
    messageId: null,
    inReplyTo: null,
    references: null,
    threadKey: computeThreadKey(draft.subject, from, draft.to, myAddresses),
    owner: draft.owner,
  });

  return c.json(data);
});

app.get("/api/settings", (c) => {
  const addrs = addressesFor(c.get("user"));
  return c.json({ fromAddresses: addrs, defaultFrom: addrs[0] ?? null });
});

app.get("/api/owners", (c) => {
  if (!isAdmin(c.get("user"))) return c.json({ error: "Forbidden" }, 403);
  return c.json(dashboardState());
});

app.post("/api/owners/assign", async (c) => {
  if (!isAdmin(c.get("user"))) return c.json({ error: "Forbidden" }, 403);
  const body = await c.req.json().catch(() => null);
  if (!body?.username || !body?.address) {
    return c.json({ error: "username and address are required" }, 400);
  }
  try {
    return c.json(await assignAddress(String(body.username), String(body.address)));
  } catch (err) {
    return c.json({ error: (err as Error).message }, 400);
  }
});

app.post("/api/owners/unassign", async (c) => {
  if (!isAdmin(c.get("user"))) return c.json({ error: "Forbidden" }, 403);
  const body = await c.req.json().catch(() => null);
  if (!body?.username || !body?.address) {
    return c.json({ error: "username and address are required" }, 400);
  }
  return c.json(await unassignAddress(String(body.username), String(body.address)));
});

app.get("/api/push/status", async (c) =>
  c.json({
    configured: pushConfigured(),
    publicKey: vapidPublicKey(),
    count: await subscriptionCount(),
  }),
);

app.post("/api/push/subscribe", async (c) => {
  const body = await c.req.json().catch(() => null);
  const sub = body?.subscription ?? body;
  if (!sub?.endpoint || !sub?.keys) return c.json({ error: "Invalid subscription" }, 400);
  await addSubscription(sub as PushSubscription);
  return c.json({ ok: true });
});

app.post("/api/push/unsubscribe", async (c) => {
  const body = await c.req.json().catch(() => null);
  const endpoint = body?.endpoint ?? body?.subscription?.endpoint;
  if (!endpoint || typeof endpoint !== "string") {
    return c.json({ error: "endpoint is required" }, 400);
  }
  await removeSubscription(endpoint);
  return c.json({ ok: true });
});

app.post("/api/push/test", async (c) => {
  if (!pushConfigured()) {
    return c.json({ error: "Push is not configured on the server." }, 400);
  }
  const result = await sendToAll({
    title: "Test notification",
    body: "Your inbox notifications are working.",
    url: "/inbox",
    tag: "mailbox-test",
  });
  return c.json(result);
});

app.get("/*", (c) => env().ASSETS.fetch(c.req.raw));

let ready: Promise<void> | null = null;
function init(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      await initOwners();
      await initOidc();
    })().catch((err) => {
      ready = null;
      throw err;
    });
  }
  return ready;
}

export default {
  async fetch(request: Request, binding: Env, ctx: ExecutionContext): Promise<Response> {
    setEnv(binding);
    await init();
    return app.fetch(request, binding, ctx);
  },
};
