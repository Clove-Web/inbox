/* mailbox/public/settings.js
 * Copyright (c) 2026 Clove Nytrix Doughmination Twilight
 * Licensed under the DASL-1.0 Licence.
 * See LICENCE.md in the project root for full licence information.
 */
// --- Settings page logic: send-from addresses + Web Push enrolment ---

const fromListEl = document.getElementById("fromList");

// Admin user-management panel
const ownersCard = document.getElementById("ownersCard");
const ownersListEl = document.getElementById("ownersList");
const catchAllNameEl = document.getElementById("catchAllName");
const assignForm = document.getElementById("assignForm");
const assignUser = document.getElementById("assignUser");
const assignAddr = document.getElementById("assignAddr");
const ownersError = document.getElementById("ownersError");

// Delete-user confirm modal
const deleteUserModal = document.getElementById("deleteUserModal");
const deleteUserWarning = document.getElementById("deleteUserWarning");
const deleteUserNameEl = document.getElementById("deleteUserName");
const deleteUserInput = document.getElementById("deleteUserInput");
const deleteUserError = document.getElementById("deleteUserError");
const deleteUserConfirm = document.getElementById("deleteUserConfirm");
const deleteUserCancel = document.getElementById("deleteUserCancel");

const pushStatusEl = document.getElementById("pushStatus");
const pushToggleBtn = document.getElementById("pushToggleBtn");
const pushTestBtn = document.getElementById("pushTestBtn");
const pushError = document.getElementById("pushError");

function escapeHtml(str) {
  const div = document.createElement("div");
  div.textContent = str ?? "";
  return div.innerHTML;
}

function bareAddr(s) {
  if (!s) return "";
  const m = String(s).match(/<([^>]+)>/);
  return (m ? m[1] : s).trim().toLowerCase();
}

// --- Your addresses (read-only) ---

function renderFromList(settings) {
  const list = settings.fromAddresses || [];
  if (list.length === 0) {
    fromListEl.innerHTML = '<li class="muted">No addresses yet.</li>';
    return;
  }
  fromListEl.innerHTML = list
    .map(
      (addr) => `
        <li class="from-row">
          <span class="from-addr">${escapeHtml(addr)}</span>
        </li>`,
    )
    .join("");
}

async function loadSettings() {
  const res = await fetch("/api/settings");
  renderFromList(await res.json());
}

// --- User management (admin only) ---

// Which user cards are expanded, kept across re-renders.
const expandedUsers = new Set();
// The username the delete-confirm modal is currently armed for.
let deleteTarget = null;

function showOwnersError(msg) {
  ownersError.textContent = msg;
  ownersError.classList.remove("hidden");
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function summaryLine(u) {
  const addrs = plural((u.addresses || []).length, "address");
  const mail = plural(u.mailCount ?? 0, "message");
  return `${addrs} · ${mail}`;
}

function userCardHtml(u, me) {
  const isSelf = u.username === me;
  const open = expandedUsers.has(u.username);

  const badges = [
    u.isAdmin ? '<span class="tag tag-admin">admin</span>' : "",
    u.isCatchAll ? '<span class="tag tag-catchall">catch-all</span>' : "",
    isSelf ? '<span class="tag tag-you">you</span>' : "",
  ].join("");

  const reservedChips = (u.reserved || []).length
    ? (u.reserved || [])
        .map(
          (addr) => `
          <span class="addr-chip">
            <span class="mono">${escapeHtml(addr)}</span>
            <button class="chip-x owner-remove" data-user="${escapeHtml(u.username)}" data-addr="${escapeHtml(addr)}" title="Remove reservation" aria-label="Remove ${escapeHtml(addr)}">✕</button>
          </span>`,
        )
        .join("")
    : '<span class="muted-inline">No reserved addresses.</span>';

  // The catch-all owner and your own account can't be deleted.
  const deleteBtn =
    isSelf || u.isCatchAll
      ? `<span class="muted-inline">${
          isSelf ? "You can't delete your own account." : "The catch-all owner can't be deleted."
        }</span>`
      : `<button class="btn-danger user-delete" data-user="${escapeHtml(u.username)}">Delete user</button>`;

  return `
    <div class="user-card ${open ? "open" : ""}" data-user="${escapeHtml(u.username)}">
      <button class="user-head" data-toggle="${escapeHtml(u.username)}" aria-expanded="${open}">
        <span class="user-caret" aria-hidden="true">▸</span>
        <span class="user-name mono">${escapeHtml(u.username)}</span>
        <span class="user-badges">${badges}</span>
        <span class="user-summary">${summaryLine(u)}</span>
      </button>

      <div class="user-body">
        <dl class="user-info">
          <dt>Automatic address</dt>
          <dd><span class="mono">${escapeHtml(u.auto)}</span> <span class="muted-inline">(always owned)</span></dd>
          <dt>Can send as</dt>
          <dd>${(u.addresses || []).map((a) => `<span class="mono">${escapeHtml(a)}</span>`).join(", ")}</dd>
          <dt>Stored mail</dt>
          <dd>${plural(u.mailCount ?? 0, "message")}${u.isAdmin ? ' <span class="muted-inline">(admins also see every mailbox)</span>' : ""}</dd>
        </dl>

        <div class="user-section">
          <h4>Reserved addresses</h4>
          <div class="addr-chips">${reservedChips}</div>
          <form class="reserve-inline" data-user="${escapeHtml(u.username)}">
            <input type="text" class="reserve-addr" placeholder="address or local-part (e.g. ctf)" autocomplete="off" />
            <button type="submit" class="btn-ghost">Reserve</button>
          </form>
        </div>

        <div class="user-section user-danger">
          <h4>Danger zone</h4>
          <p class="muted-inline">
            Deleting a user permanently removes all their stored mail and clears
            their reservations and admin rights. They can sign in again and come
            back as an ordinary user.
          </p>
          ${deleteBtn}
        </div>
      </div>
    </div>`;
}

function renderOwners(state) {
  const users = state.users || [];
  const me = state.me || null;
  catchAllNameEl.textContent = state.catchAll || "—";

  ownersListEl.innerHTML = users.map((u) => userCardHtml(u, me)).join("");

  ownersListEl.querySelectorAll(".user-head").forEach((btn) => {
    btn.addEventListener("click", () => {
      const name = btn.dataset.toggle;
      if (expandedUsers.has(name)) expandedUsers.delete(name);
      else expandedUsers.add(name);
      const card = btn.closest(".user-card");
      const nowOpen = expandedUsers.has(name);
      card.classList.toggle("open", nowOpen);
      btn.setAttribute("aria-expanded", String(nowOpen));
    });
  });

  ownersListEl.querySelectorAll(".owner-remove").forEach((btn) => {
    btn.addEventListener("click", () => unassign(btn.dataset.user, btn.dataset.addr));
  });

  ownersListEl.querySelectorAll(".reserve-inline").forEach((form) => {
    form.addEventListener("submit", (ev) => {
      ev.preventDefault();
      const addr = form.querySelector(".reserve-addr").value.trim();
      if (addr) assign(form.dataset.user, addr);
    });
  });

  ownersListEl.querySelectorAll(".user-delete").forEach((btn) => {
    btn.addEventListener("click", () => {
      const u = users.find((x) => x.username === btn.dataset.user);
      openDeleteUser(btn.dataset.user, u ? u.mailCount ?? 0 : 0);
    });
  });
}

async function loadOwners() {
  const res = await fetch("/api/owners");
  if (!res.ok) return; // 403 for non-admins — leave the panel hidden
  ownersCard.classList.remove("hidden");
  renderOwners(await res.json());
}

async function assign(username, address) {
  ownersError.classList.add("hidden");
  const res = await fetch("/api/owners/assign", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, address }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    showOwnersError(data.error || "Couldn't reserve that address.");
    return;
  }
  // A freshly-reserved user is worth showing expanded.
  expandedUsers.add(username.toLowerCase());
  assignUser.value = "";
  assignAddr.value = "";
  await loadOwners();
}

async function unassign(username, address) {
  ownersError.classList.add("hidden");
  const res = await fetch("/api/owners/unassign", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, address }),
  });
  if (res.ok) await loadOwners();
}

// --- Delete user ---

function openDeleteUser(username, mailCount) {
  deleteTarget = username;
  deleteUserNameEl.textContent = username;
  deleteUserWarning.textContent =
    `This permanently deletes ${plural(mailCount, "stored message")} for ` +
    `“${username}” and clears their reservations and admin rights. This can't be undone.`;
  deleteUserError.classList.add("hidden");
  deleteUserInput.value = "";
  deleteUserConfirm.disabled = true;
  deleteUserModal.classList.remove("hidden");
  deleteUserInput.focus();
}

function closeDeleteUser() {
  deleteTarget = null;
  deleteUserModal.classList.add("hidden");
}

deleteUserInput.addEventListener("input", () => {
  deleteUserConfirm.disabled =
    deleteUserInput.value.trim().toLowerCase() !== (deleteTarget || "").toLowerCase();
});

deleteUserCancel.addEventListener("click", closeDeleteUser);

deleteUserModal.addEventListener("click", (ev) => {
  if (ev.target === deleteUserModal) closeDeleteUser();
});

deleteUserConfirm.addEventListener("click", async () => {
  if (!deleteTarget) return;
  deleteUserConfirm.disabled = true;
  const res = await fetch("/api/owners/delete-user", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username: deleteTarget }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    deleteUserError.textContent = data.error || "Couldn't delete that user.";
    deleteUserError.classList.remove("hidden");
    deleteUserConfirm.disabled = false;
    return;
  }
  expandedUsers.delete(deleteTarget);
  closeDeleteUser();
  await loadOwners();
});

assignForm.addEventListener("submit", (ev) => {
  ev.preventDefault();
  const u = assignUser.value.trim();
  const a = assignAddr.value.trim();
  if (u && a) assign(u, a);
});

document.getElementById("logoutBtn").addEventListener("click", async () => {
  await fetch("/api/logout", { method: "POST" });
  window.location.href = "/login";
});

// --- Web Push ---

function urlBase64ToUint8Array(base64String) {
  const padding = "=".repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const out = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

const pushSupported =
  "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;

// iOS only allows Web Push from an installed (Home Screen) PWA.
const isIos = /iphone|ipad|ipod/i.test(navigator.userAgent);
const isStandalone =
  window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;

let serverPush = { configured: false, publicKey: "", count: 0 };
let swReg = null;

function setPushStatus(msg, kind) {
  pushStatusEl.textContent = msg;
  pushStatusEl.className = "push-status" + (kind ? " " + kind : "");
}

function showPushError(msg) {
  pushError.textContent = msg;
  pushError.classList.remove("hidden");
}

async function initPush() {
  pushError.classList.add("hidden");

  if (!pushSupported) {
    setPushStatus("This browser doesn't support notifications.", "muted");
    pushToggleBtn.disabled = true;
    return;
  }

  if (isIos && !isStandalone) {
    setPushStatus(
      "Add this site to your Home Screen first (Share → Add to Home Screen), then open it from there to enable notifications.",
      "muted"
    );
    pushToggleBtn.disabled = true;
    return;
  }

  try {
    serverPush = await (await fetch("/api/push/status")).json();
  } catch (_) {
    setPushStatus("Couldn't reach the server.", "muted");
    return;
  }

  if (!serverPush.configured) {
    setPushStatus("Push isn't configured on the server (missing VAPID keys).", "muted");
    pushToggleBtn.disabled = true;
    return;
  }

  swReg = await navigator.serviceWorker.register("/sw.js");
  await navigator.serviceWorker.ready;

  const sub = await swReg.pushManager.getSubscription();
  reflectSubscription(!!sub);
}

function reflectSubscription(isSubscribed) {
  pushToggleBtn.disabled = false;
  if (isSubscribed) {
    setPushStatus("Notifications are on for this device.", "ok");
    pushToggleBtn.textContent = "Disable notifications";
    pushToggleBtn.classList.remove("btn-accent");
    pushToggleBtn.classList.add("btn-ghost");
    pushTestBtn.classList.remove("hidden");
  } else {
    setPushStatus("Notifications are off for this device.", "muted");
    pushToggleBtn.textContent = "Enable notifications";
    pushToggleBtn.classList.add("btn-accent");
    pushToggleBtn.classList.remove("btn-ghost");
    pushTestBtn.classList.add("hidden");
  }
}

async function enablePush() {
  pushError.classList.add("hidden");
  const permission = await Notification.requestPermission();
  if (permission !== "granted") {
    showPushError("Notification permission was not granted.");
    return;
  }

  const sub = await swReg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: urlBase64ToUint8Array(serverPush.publicKey),
  });

  const res = await fetch("/api/push/subscribe", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ subscription: sub }),
  });
  if (!res.ok) {
    showPushError("Couldn't save the subscription on the server.");
    return;
  }
  reflectSubscription(true);
}

async function disablePush() {
  const sub = await swReg.pushManager.getSubscription();
  if (sub) {
    await fetch("/api/push/unsubscribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ endpoint: sub.endpoint }),
    });
    await sub.unsubscribe();
  }
  reflectSubscription(false);
}

pushToggleBtn.addEventListener("click", async () => {
  pushToggleBtn.disabled = true;
  try {
    const sub = await swReg.pushManager.getSubscription();
    if (sub) await disablePush();
    else await enablePush();
  } catch (err) {
    showPushError("Something went wrong: " + (err && err.message ? err.message : err));
  } finally {
    pushToggleBtn.disabled = false;
  }
});

pushTestBtn.addEventListener("click", async () => {
  pushError.classList.add("hidden");
  pushTestBtn.disabled = true;
  try {
    const res = await fetch("/api/push/test", { method: "POST" });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) showPushError(data.error || "Test failed.");
    else setPushStatus(`Test sent to ${data.sent} device(s).`, "ok");
  } finally {
    pushTestBtn.disabled = false;
  }
});

loadSettings();
loadOwners();
initPush();
