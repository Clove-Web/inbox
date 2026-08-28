/* mailbox/public/app.js
 * Copyright (c) 2026 Clove Nytrix Doughmination Twilight
 * Licensed under the DASL-1.0 Licence.
 * See LICENCE.md in the project root for full licence information.
 */
const listEl = document.getElementById("list");
const detailEl = document.getElementById("detailContent");
const backBtn = document.getElementById("backBtn");
const layoutEl = document.querySelector(".layout");
const composeModal = document.getElementById("composeModal");
const composeForm = document.getElementById("composeForm");
const composeError = document.getElementById("composeError");
const composeTitle = composeForm.querySelector("h2");
const messageLabel = composeForm.html.closest("label");
const attachmentsInput = composeForm.attachments;
const attachmentListEl = document.getElementById("attachmentList");
const attachmentWarning = document.getElementById("attachmentWarning");
const saveDraftBtn = document.getElementById("saveDraftBtn");
const deleteDraftBtn = document.getElementById("deleteDraftBtn");
const folderNav = document.getElementById("folderNav");
const lightbox = document.getElementById("lightbox");
const lightboxImg = document.getElementById("lightboxImg");
const fromRow = document.getElementById("fromRow");
const fromSelect = composeForm.from;
const toastHost = document.getElementById("toastHost");

let emails = [];
let activeId = null;
let activeFolder = "inbox";
// Messages of the thread currently open in the detail pane, so a per-message
// delete can figure out whether anything is left to keep showing.
let currentThread = [];
// Configured send-from addresses, fetched once at startup for the compose picker.
let fromOptions = { fromAddresses: [], defaultFrom: null };
// Ids optimistically hidden while an undo toast is still up. Nothing is deleted
// on the server until the toast expires, so these are just visually suppressed.
const pendingDeleteIds = new Set();
const UNDO_MS = 6000;
// Resend rejects emails whose total size (all attachments) tops ~40 MB.
const RESEND_LIMIT = 40 * 1024 * 1024;

function bareAddr(s) {
  if (!s) return "";
  const m = String(s).match(/<([^>]+)>/);
  return (m ? m[1] : s).trim().toLowerCase();
}

// The compose modal is reused for "new message", "reply", "forward", and
// "edit draft". This holds whatever async submit logic applies right now.
let currentSubmitHandler = null;
// Set only while editing an existing draft, so Save/Delete know what to act on.
let editingDraftId = null;
// Attachments staged for the message currently open in the compose modal.
let stagedAttachments = [];

function fmtTime(iso) {
  const d = new Date(iso);
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtSize(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

function isImageAttachment(a) {
  return !!a.id && typeof a.contentType === "string" && a.contentType.startsWith("image/");
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      // dataURL looks like "data:<type>;base64,<content>" — we only want the payload
      const result = reader.result;
      const comma = result.indexOf(",");
      resolve(comma === -1 ? result : result.slice(comma + 1));
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

// Shrinks large photos in the browser before they're uploaded: downscale to a
// sane max dimension and re-encode as JPEG. Keeps the result a normal, openable
// image (unlike gzip, which would give the recipient a file they can't read).
// Non-images, small images, and GIFs/HEIC that won't decode are left as-is.
function compressImageFile(file, { maxDim = 2000, quality = 0.82, minBytes = 800 * 1024 } = {}) {
  return new Promise((resolve) => {
    if (!file.type.startsWith("image/") || file.type === "image/gif" || file.size <= minBytes) {
      resolve(file);
      return;
    }
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const width = Math.round(img.width * scale);
      const height = Math.round(img.height * scale);
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      canvas.getContext("2d").drawImage(img, 0, 0, width, height);
      canvas.toBlob(
        (blob) => {
          // If re-encoding didn't actually help, keep the original.
          if (!blob || blob.size >= file.size) {
            resolve(file);
            return;
          }
          const name = file.name.replace(/\.[^.]+$/, "") + ".jpg";
          resolve(new File([blob], name, { type: "image/jpeg" }));
        },
        "image/jpeg",
        quality
      );
    };
    img.onerror = () => {
      // Formats the browser can't decode (often HEIC) — send them untouched.
      URL.revokeObjectURL(url);
      resolve(file);
    };
    img.src = url;
  });
}

// Best-effort size of everything staged: uploaded refs carry a real `size`,
// while inline-fallback items only have base64 (~4/3 of the real bytes).
function stagedTotalBytes() {
  return stagedAttachments.reduce((sum, a) => {
    if (typeof a.size === "number") return sum + a.size;
    if (typeof a.content === "string") return sum + Math.floor(a.content.length * 0.75);
    return sum;
  }, 0);
}

function updateAttachmentWarning() {
  if (!attachmentWarning) return;
  const total = stagedTotalBytes();
  if (total > RESEND_LIMIT) {
    attachmentWarning.textContent = `Attachments total ${fmtSize(total)} — over the 40 MB email limit, so this will likely bounce. Remove a file or split it across two emails.`;
    attachmentWarning.classList.remove("hidden");
  } else if (total > RESEND_LIMIT * 0.6) {
    attachmentWarning.textContent = `Attachments total ${fmtSize(total)} — getting close to the 40 MB email limit.`;
    attachmentWarning.classList.remove("hidden");
  } else {
    attachmentWarning.classList.add("hidden");
  }
}

function pathForFolder(folder) {
  return `/${folder}`;
}

function folderForPath(pathname) {
  const clean = pathname.replace(/\/+$/, "");
  if (clean === "/sent") return "sent";
  if (clean === "/drafts") return "drafts";
  return "inbox"; // covers "/" and "/inbox"
}

function setActiveFolderButton(folder) {
  folderNav.querySelectorAll(".folder-item").forEach((b) => {
    b.classList.toggle("active", b.dataset.folder === folder);
  });
}

function goToFolder(folder, { push = true } = {}) {
  setActiveFolderButton(folder);
  activeId = null;
  detailEl.innerHTML = '<p class="muted">Select an email to read it.</p>';
  layoutEl.classList.remove("show-detail");
  if (push) history.pushState(null, "", pathForFolder(folder));
  loadEmails(folder);
}

async function loadEmails(folder = activeFolder) {
  activeFolder = folder;
  const res = await fetch(`/api/emails?folder=${encodeURIComponent(folder)}`);
  emails = await res.json();
  renderList();
}

function renderList() {
  const visible = emails.filter((e) => !pendingDeleteIds.has(e.id));
  if (visible.length === 0) {
    listEl.innerHTML = '<p class="muted">Nothing here.</p>';
    return;
  }

  listEl.innerHTML = visible
    .map(
      (e) => `
      <div class="list-item ${e.id === activeId ? "active" : ""}" data-id="${e.id}">
        <div class="list-item-main">
          <div class="from">${escapeHtml(activeFolder === "drafts" ? (e.to || []).join(", ") || "(no recipient)" : e.from)}</div>
          <div class="subject">${escapeHtml(e.subject || "(no subject)")}</div>
          <div class="time">${fmtTime(e.receivedAt)}</div>
        </div>
        <button class="row-delete" data-id="${e.id}" title="Delete" aria-label="Delete">✕</button>
      </div>
    `
    )
    .join("");

  listEl.querySelectorAll(".list-item").forEach((el) => {
    el.addEventListener("click", () => {
      if (activeFolder === "drafts") {
        openDraft(el.dataset.id);
      } else {
        openEmail(el.dataset.id);
      }
    });
  });

  listEl.querySelectorAll(".row-delete").forEach((btn) => {
    btn.addEventListener("click", (ev) => {
      ev.stopPropagation(); // don't also open the email
      deleteMessage(btn.dataset.id);
    });
  });
}

function attachmentsHtml(email) {
  if (!email.attachments || email.attachments.length === 0) return "";

  // Images the server already stitched into the body (cid: inline) are flagged
  // `inline` — don't repeat them here.
  const shown = email.attachments.filter((a) => !a.inline);
  const images = shown.filter(isImageAttachment);
  const files = shown.filter((a) => !isImageAttachment(a));

  let html = "";

  if (images.length) {
    const thumbs = images
      .map((a) => {
        const url = `/api/emails/${email.id}/attachments/${a.id}?inline=1`;
        return `<a class="image-thumb" href="${url}" data-full="${url}" title="${escapeHtml(a.filename)}">
          <img src="${url}" alt="${escapeHtml(a.filename)}" loading="lazy" />
        </a>`;
      })
      .join("");
    html += `<div class="image-grid">${thumbs}</div>`;
  }

  if (files.length) {
    const items = files
      .map((a) =>
        a.id
          ? `<li><a class="file-download" href="/api/emails/${email.id}/attachments/${a.id}" data-url="/api/emails/${email.id}/attachments/${a.id}" data-name="${escapeHtml(a.filename)}" download="${escapeHtml(a.filename)}">${escapeHtml(a.filename)}</a> <span class="muted-inline">(${fmtSize(a.size)})</span></li>`
          : `<li>${escapeHtml(a.filename)} <span class="muted-inline">(unavailable)</span></li>`
      )
      .join("");
    html += `<ul class="attachment-list">${items}</ul>`;
  }

  return html;
}

async function openEmail(id) {
  activeId = id;
  renderList();
  layoutEl.classList.add("show-detail");

  const res = await fetch(`/api/emails/${id}/thread`);
  if (!res.ok) {
    detailEl.innerHTML = '<p class="muted">Could not load this email.</p>';
    return;
  }
  const thread = await res.json();
  currentThread = thread;
  const last = thread[thread.length - 1];

  const messagesHtml = thread
    .map(
      (email) => `
      <article class="message">
        <div class="msg-head">
          <span class="dir-badge ${email.direction}">${email.direction === "inbound" ? "received" : "sent"}</span>
          <strong>${escapeHtml(email.from)}</strong>
          <span class="muted-inline">to ${escapeHtml((email.to || []).join(", "))}</span>
          <button class="msg-delete" data-id="${email.id}" title="Delete this message" aria-label="Delete this message">🗑</button>
        </div>
        <div class="meta">${fmtTime(email.receivedAt)}</div>
        <div class="body">
          ${email.html ?? `<pre style="white-space: pre-wrap;">${escapeHtml(email.text ?? "(empty message)")}</pre>`}
        </div>
        ${attachmentsHtml(email)}
      </article>
    `
    )
    .join("");

  detailEl.innerHTML = `
    ${messagesHtml}
    <div class="thread-actions">
      <button class="btn-accent" id="replyBtn">Reply</button>
      <button class="btn-ghost" id="forwardBtn">Forward</button>
      <button class="btn-danger" id="deleteThreadBtn">Delete conversation</button>
    </div>
  `;

  document.getElementById("replyBtn").addEventListener("click", () => openReply(last));
  document.getElementById("forwardBtn").addEventListener("click", () => openForward(last));
  document.getElementById("deleteThreadBtn").addEventListener("click", () => deleteThread(id));

  detailEl.querySelectorAll(".msg-delete").forEach((btn) => {
    btn.addEventListener("click", () => deleteMessage(btn.dataset.id));
  });

  detailEl.querySelectorAll(".image-thumb").forEach((thumb) => {
    thumb.addEventListener("click", (ev) => {
      ev.preventDefault();
      openLightbox(thumb.dataset.full);
    });
  });

  detailEl.querySelectorAll(".file-download").forEach((link) => {
    link.addEventListener("click", (ev) => {
      ev.preventDefault();
      downloadFile(link.dataset.url, link.dataset.name);
    });
  });
}

// iOS and installed (standalone) PWAs ignore the <a download> attribute — a tap
// just does nothing. So fetch the bytes ourselves and trigger the save via an
// object URL; if that's blocked, fall back to opening the file in a new tab so
// the OS viewer's share/save sheet can take over.
async function downloadFile(url, filename) {
  try {
    const res = await fetch(url, { credentials: "same-origin" });
    if (!res.ok) throw new Error("download failed");
    const blob = await res.blob();
    const objUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objUrl;
    a.download = filename || "download";
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(objUrl), 10000);
  } catch (_) {
    window.open(url, "_blank");
  }
}

async function openDraft(id) {
  activeId = id;
  renderList();
  layoutEl.classList.add("show-detail");

  const draft = emails.find((e) => e.id === id);
  if (!draft) return;

  // Draft list items omit html/text (list endpoint strips bodies), so fetch the full record.
  const res = await fetch(`/api/emails/${id}/thread`).catch(() => null);
  // Drafts aren't part of a real thread; fall back to what we already have if this 404s.
  const full = res && res.ok ? (await res.json())[0] : draft;

  editingDraftId = id;
  stagedAttachments = full.attachments ?? [];
  openComposeModal({
    title: "Edit draft",
    toValue: (full.to || []).join(", "),
    subjectValue: full.subject ?? "",
    htmlValue: full.html ?? "",
    fromPreferred: full.from || null,
    subjectReadOnly: false,
    showMessage: true,
    showDeleteDraft: true,
    submitHandler: (fields) => sendDraft(id, fields),
  });
}

function renderAttachmentList() {
  updateAttachmentWarning();
  if (stagedAttachments.length === 0) {
    attachmentListEl.innerHTML = "";
    return;
  }
  attachmentListEl.innerHTML = stagedAttachments
    .map((a, i) => `<li>${escapeHtml(a.filename)} <span class="muted-inline">(${fmtSize(a.size ?? a.content?.length ?? 0)})</span> <button type="button" data-idx="${i}" class="btn-ghost remove-attachment">Remove</button></li>`)
    .join("");
  attachmentListEl.querySelectorAll(".remove-attachment").forEach((btn) => {
    btn.addEventListener("click", () => {
      stagedAttachments.splice(Number(btn.dataset.idx), 1);
      renderAttachmentList();
    });
  });
}

attachmentsInput.addEventListener("change", async () => {
  const files = Array.from(attachmentsInput.files ?? []);
  for (const rawFile of files) {
    // Shrink big photos before doing anything else with them.
    const file = await compressImageFile(rawFile);
    const content = await fileToBase64(file);
    // Upload each file on its own right away, so the eventual send/draft
    // request only carries a small reference (id) instead of every file's
    // base64 at once. That keeps requests under the proxy's size limit — the
    // reason attaching several files used to fail while a single one worked.
    try {
      const res = await fetch("/api/uploads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ filename: file.name, contentType: file.type, content }),
      });
      if (res.ok) {
        stagedAttachments.push(await res.json());
        continue;
      }
    } catch (_) {
      /* fall through to inline content below */
    }
    // Fallback: keep the bytes inline so send still works if upload failed.
    stagedAttachments.push({
      filename: file.name,
      contentType: file.type,
      content,
      size: file.size,
    });
  }
  attachmentsInput.value = "";
  renderAttachmentList();
});

// Fills the From <select> from the configured addresses. Hides the whole row
// when nothing is configured (the server then falls back to its default/env).
function populateFromSelect(preferred) {
  if (!fromSelect) return;
  const list = fromOptions.fromAddresses || [];
  if (list.length === 0) {
    fromSelect.innerHTML = "";
    fromRow.style.display = "none";
    return;
  }
  fromRow.style.display = "";
  const match = preferred && list.find((a) => bareAddr(a) === bareAddr(preferred));
  const selected = match || fromOptions.defaultFrom || list[0];
  fromSelect.innerHTML = list
    .map(
      (a) =>
        `<option value="${escapeHtml(a)}"${bareAddr(a) === bareAddr(selected) ? " selected" : ""}>${escapeHtml(a)}</option>`
    )
    .join("");
}

// For replies/forwards, prefer sending from whichever of our addresses the
// original message actually involved.
function preferredFromFor(email) {
  const list = fromOptions.fromAddresses || [];
  const candidates = email.direction === "inbound" ? email.to || [] : [email.from];
  for (const c of candidates) {
    const m = list.find((a) => bareAddr(a) === bareAddr(c));
    if (m) return m;
  }
  return null;
}

function openComposeModal({
  title,
  toValue,
  subjectValue,
  htmlValue,
  fromPreferred,
  subjectReadOnly,
  showMessage,
  showDeleteDraft,
  submitHandler,
}) {
  composeError.classList.add("hidden");
  composeForm.reset();
  composeTitle.textContent = title;
  composeForm.to.value = toValue ?? "";
  composeForm.subject.value = subjectValue ?? "";
  composeForm.html.value = htmlValue ?? "";
  composeForm.subject.readOnly = !!subjectReadOnly;
  messageLabel.style.display = showMessage ? "" : "none";
  composeForm.html.required = showMessage;
  deleteDraftBtn.classList.toggle("hidden", !showDeleteDraft);
  currentSubmitHandler = submitHandler;
  if (!showDeleteDraft) editingDraftId = null;
  populateFromSelect(fromPreferred);
  renderAttachmentList();
  composeModal.classList.remove("hidden");
}

function currentFields() {
  return {
    to: composeForm.to.value,
    subject: composeForm.subject.value,
    html: composeForm.html.value,
    from: fromSelect && fromRow.style.display !== "none" ? fromSelect.value : undefined,
    attachments: stagedAttachments,
  };
}

function openNewMessage() {
  editingDraftId = null;
  stagedAttachments = [];
  openComposeModal({
    title: "New message",
    toValue: "",
    subjectValue: "",
    htmlValue: "",
    subjectReadOnly: false,
    showMessage: true,
    submitHandler: (fields) =>
      fetch("/api/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to: fields.to,
          from: fields.from,
          subject: fields.subject,
          html: `<p>${escapeHtml(fields.html).replace(/\n/g, "<br>")}</p>`,
          attachments: fields.attachments,
        }),
      }),
  });
}

function openReply(email) {
  const replyTo = email.direction === "inbound" ? email.from : (email.to || [])[0] ?? "";
  editingDraftId = null;
  stagedAttachments = [];
  openComposeModal({
    title: "Reply",
    toValue: replyTo,
    subjectValue: /^\s*re\s*:/i.test(email.subject) ? email.subject : `Re: ${email.subject}`,
    htmlValue: "",
    fromPreferred: preferredFromFor(email),
    subjectReadOnly: false,
    showMessage: true,
    submitHandler: (fields) =>
      fetch(`/api/emails/${email.id}/reply`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          to: fields.to,
          from: fields.from,
          html: `<p>${escapeHtml(fields.html).replace(/\n/g, "<br>")}</p>`,
          attachments: fields.attachments,
        }),
      }),
  });
}

function openForward(email) {
  editingDraftId = null;
  stagedAttachments = [];
  openComposeModal({
    title: "Forward",
    toValue: "",
    subjectValue: /^\s*fwd?\s*:/i.test(email.subject) ? email.subject : `Fwd: ${email.subject}`,
    htmlValue: "",
    fromPreferred: preferredFromFor(email),
    subjectReadOnly: true,
    showMessage: false,
    submitHandler: (fields) =>
      fetch(`/api/emails/${email.id}/forward`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: composeForm.to.value, from: fields.from }),
      }),
  });
}

async function sendDraft(id, fields) {
  // Make sure any edits (including attachments just added) are persisted
  // before asking the server to send — /api/drafts/:id/send uses whatever
  // is already saved, it doesn't take a body.
  await fetch(`/api/drafts/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      to: fields.to,
      from: fields.from,
      subject: fields.subject,
      html: `<p>${escapeHtml(fields.html).replace(/\n/g, "<br>")}</p>`,
      attachments: fields.attachments,
    }),
  });

  return fetch(`/api/drafts/${id}/send`, { method: "POST" });
}

async function saveDraft() {
  const fields = currentFields();
  const payload = JSON.stringify({
    to: fields.to,
    from: fields.from,
    subject: fields.subject,
    html: fields.html,
    attachments: fields.attachments,
  });

  const res = editingDraftId
    ? await fetch(`/api/drafts/${editingDraftId}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: payload,
      })
    : await fetch("/api/drafts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: payload,
      });

  if (!res.ok) {
    composeError.textContent = "Couldn't save draft.";
    composeError.classList.remove("hidden");
    return;
  }

  composeModal.classList.add("hidden");
  if (activeFolder === "drafts") loadEmails();
}

async function deleteDraftAndClose() {
  if (!editingDraftId) return;
  await fetch(`/api/drafts/${editingDraftId}`, { method: "DELETE" });
  composeModal.classList.add("hidden");
  closeDetail();
  loadEmails();
}

function closeDetail() {
  activeId = null;
  currentThread = [];
  layoutEl.classList.remove("show-detail");
  detailEl.innerHTML = '<p class="muted">Select an email to read it.</p>';
}

// Delete is optimistic + undoable: we hide the affected rows immediately and
// only hit the server once the toast times out. Undo just cancels — so nothing
// is actually removed on the server during the grace window.
function deleteMessage(id) {
  performUndoableDelete([id], "Message deleted", () =>
    fetch(`/api/emails/${id}`, { method: "DELETE" })
  );
}

function deleteThread(id) {
  const ids = currentThread.length ? currentThread.map((m) => m.id) : [id];
  performUndoableDelete(ids, "Conversation deleted", () =>
    fetch(`/api/emails/${id}/thread`, { method: "DELETE" })
  );
}

function performUndoableDelete(ids, message, commit) {
  ids.forEach((x) => pendingDeleteIds.add(x));

  // If the open detail shows anything we're removing, close it for now.
  if (ids.includes(activeId) || currentThread.some((m) => ids.includes(m.id))) {
    closeDetail();
  }
  renderList();
  showUndoToast(message, ids, commit);
}

function showUndoToast(message, ids, commit) {
  const el = document.createElement("div");
  el.className = "toast";

  const span = document.createElement("span");
  span.textContent = message;

  const undoBtn = document.createElement("button");
  undoBtn.className = "toast-undo";
  undoBtn.textContent = "Undo";

  el.append(span, undoBtn);
  toastHost.appendChild(el);

  let settled = false;
  const settle = async (undo) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    el.classList.add("leaving");
    setTimeout(() => el.remove(), 200);

    if (undo) {
      ids.forEach((x) => pendingDeleteIds.delete(x));
      await loadEmails();
    } else {
      try {
        await commit();
      } catch (_) {
        /* If the real delete fails, the next poll will just show it again. */
      }
      ids.forEach((x) => pendingDeleteIds.delete(x));
      await loadEmails();
    }
  };

  undoBtn.addEventListener("click", () => settle(true));
  const timer = setTimeout(() => settle(false), UNDO_MS);
}

function openLightbox(src) {
  if (!src) return;
  lightboxImg.src = src;
  lightbox.classList.remove("hidden");
}

function closeLightbox() {
  lightbox.classList.add("hidden");
  lightboxImg.src = "";
}

document.getElementById("composeBtn").addEventListener("click", openNewMessage);

backBtn.addEventListener("click", () => {
  layoutEl.classList.remove("show-detail");
});

document.getElementById("logoutBtn").addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST" });
  window.location.href = "/login";
});

document.getElementById("cancelBtn").addEventListener("click", () => {
  composeModal.classList.add("hidden");
});

saveDraftBtn.addEventListener("click", saveDraft);
deleteDraftBtn.addEventListener("click", deleteDraftAndClose);

lightbox.addEventListener("click", closeLightbox);
document.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape" && !lightbox.classList.contains("hidden")) closeLightbox();
});

folderNav.querySelectorAll(".folder-item").forEach((btn) => {
  btn.addEventListener("click", () => goToFolder(btn.dataset.folder));
});

window.addEventListener("popstate", () => {
  goToFolder(folderForPath(location.pathname), { push: false });
});

composeForm.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  if (!currentSubmitHandler) return;

  const fields = currentFields();
  const res = await currentSubmitHandler(fields);

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    composeError.textContent = err.error ?? "That didn't go through.";
    composeError.classList.remove("hidden");
    return;
  }

  // Sending a draft removes it from disk server-side; make sure we don't
  // try to resave it as a draft if the modal gets reopened before a reload.
  if (editingDraftId) editingDraftId = null;

  composeModal.classList.add("hidden");
  loadEmails();
  if (activeId && activeFolder !== "drafts") openEmail(activeId);
});

// Load the configured send-from addresses for the compose picker.
async function loadFromOptions() {
  try {
    const res = await fetch("/api/settings");
    if (res.ok) fromOptions = await res.json();
  } catch (_) {
    /* Leave defaults; compose just hides the From row. */
  }
}

// Register the push service worker so notifications work once the user opts in
// from Settings. Registration itself is silent and permission-free.
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}

const initialFolder = folderForPath(location.pathname);
setActiveFolderButton(initialFolder);
// Normalize "/" to "/inbox" in the address bar without adding a history entry.
history.replaceState(null, "", pathForFolder(initialFolder));
loadFromOptions();
loadEmails(initialFolder);
// Poll for new mail every 15s — simple and good enough for a personal inbox
setInterval(() => loadEmails(), 15000);