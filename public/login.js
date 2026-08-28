/* mailbox/public/login.js
 * Copyright (c) 2026 Clove Nytrix Doughmination Twilight
 * Licensed under the DASL-1.0 Licence.
 * See LICENCE.md in the project root for full licence information.
 */
const form = document.getElementById("loginForm");
const errorEl = document.getElementById("loginError");

form.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  errorEl.classList.add("hidden");

  const formData = new FormData(form);

  const res = await fetch("/api/login", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      username: formData.get("username"),
      password: formData.get("password"),
      // Turnstile injects this hidden field into the widget's container div
      // once a challenge is solved.
      turnstileToken: formData.get("cf-turnstile-response"),
      // Honeypot — should always be empty for a real visitor.
      website: formData.get("website"),
    }),
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    errorEl.textContent = err.error ?? "Sign in failed.";
    errorEl.classList.remove("hidden");
    // Turnstile tokens are single-use — get a fresh one for the next attempt.
    if (window.turnstile) window.turnstile.reset();
    return;
  }

  window.location.href = "/";
});