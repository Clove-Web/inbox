/* mailbox/public/settings.js
 * Copyright (c) 2026 Clove Nytrix Doughmination Twilight
 * Licensed under the DASL-1.0 Licence.
 * See LICENCE.md in the project root for full licence information.
 */
// --- Settings page logic: send-from addresses + Web Push enrolment ---

const fromListEl = document.getElementById("fromList");

// Admin reservations panel
const ownersCard = document.getElementById("ownersCard");
const ownersListEl = document.getElementById("ownersList");
const assignForm = document.getElementById("assignForm");
const assignUser = document.getElementById("assignUser");
const assignAddr = document.getElementById("assignAddr");
const ownersError = document.getElementById("ownersError");

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

// --- Address reservations (admin only) ---

function showOwnersError(msg) {
  ownersError.textContent = msg;
  ownersError.classList.remove("hidden");
}

function renderOwners(state) {
  const users = state.users || [];
  ownersListEl.innerHTML = users
    .map((u) => {
      const auto = `<span class="from-addr" title="Automatic — can't be removed">${escapeHtml(u.auto)}</span>`;
      const extras = (u.reserved || [])
        .map(
          (addr) => `
            <span class="from-addr">
              ${escapeHtml(addr)}
              <button class="btn-ghost owner-remove" data-user="${escapeHtml(u.username)}" data-addr="${escapeHtml(addr)}">✕</button>
            </span>`,
        )
        .join("");
      const badge = u.isAdmin ? ' <span class="muted">(admin — sees all)</span>' : "";
      return `
        <div class="from-row" style="flex-direction:column;align-items:flex-start;gap:4px">
          <strong>${escapeHtml(u.username)}${badge}</strong>
          <div style="display:flex;flex-wrap:wrap;gap:6px">${auto}${extras}</div>
        </div>`;
    })
    .join("");

  ownersListEl.querySelectorAll(".owner-remove").forEach((btn) => {
    btn.addEventListener("click", () => unassign(btn.dataset.user, btn.dataset.addr));
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
  renderOwners(data);
  assignUser.value = "";
  assignAddr.value = "";
}

async function unassign(username, address) {
  const res = await fetch("/api/owners/unassign", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ username, address }),
  });
  if (res.ok) renderOwners(await res.json());
}

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
