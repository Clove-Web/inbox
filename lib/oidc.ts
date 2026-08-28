import { createRemoteJWKSet, jwtVerify } from "jose";

const OIDC = {
  issuer: (process.env.OIDC_ISSUER || "").replace(/\/+$/, ""),
  clientId: process.env.OIDC_CLIENT_ID || "",
  clientSecret: process.env.OIDC_CLIENT_SECRET || "",
  redirectUri: process.env.OIDC_REDIRECT_URI || "",
  scope: process.env.OIDC_SCOPE || "openid profile email",
  postLogoutRedirectUri: process.env.OIDC_POST_LOGOUT_REDIRECT_URI || "",
};

interface Discovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  end_session_endpoint?: string;
}

let discovery: Discovery | null = null;
let jwks: ReturnType<typeof createRemoteJWKSet> | null = null;

async function getDiscovery(): Promise<Discovery> {
  if (discovery && jwks) return discovery;

  const url = `${OIDC.issuer}/.well-known/openid-configuration`;
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`OIDC discovery failed (${res.status}) at ${url}`);
  }

  discovery = (await res.json()) as Discovery;
  jwks = createRemoteJWKSet(new URL(discovery.jwks_uri));
  return discovery;
}

export async function initOidc(): Promise<void> {
  const missing = [
    ["OIDC_ISSUER", OIDC.issuer],
    ["OIDC_CLIENT_ID", OIDC.clientId],
    ["OIDC_CLIENT_SECRET", OIDC.clientSecret],
    ["OIDC_REDIRECT_URI", OIDC.redirectUri],
  ]
    .filter(([, v]) => !v)
    .map(([k]) => k);

  if (missing.length) {
    throw new Error(`Missing OIDC env vars: ${missing.join(", ")}`);
  }

  await getDiscovery();
  console.log(`OIDC ready - issuer ${OIDC.issuer}`);
}

function b64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function randomToken(bytes = 32): string {
  return b64url(crypto.getRandomValues(new Uint8Array(bytes)));
}

async function sha256(input: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input)));
}

function sanitizeUsername(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9._-]/g, "-")
    .replace(/^-+|-+$/g, "");
}

function pickUsername(claims: Record<string, unknown>): string {
  const email = typeof claims.email === "string" ? claims.email.split("@")[0] : "";
  const raw =
    (typeof claims.preferred_username === "string" && claims.preferred_username) ||
    email ||
    (typeof claims.sub === "string" && claims.sub) ||
    "";
  return sanitizeUsername(String(raw));
}

export interface Pending {
  state: string;
  nonce: string;
  codeVerifier: string;
  returnTo: string;
}

export async function buildAuthUrl(returnTo: string): Promise<{ url: string; pending: Pending }> {
  const d = await getDiscovery();

  const state = randomToken();
  const nonce = randomToken();
  const codeVerifier = randomToken(32);
  const codeChallenge = b64url(await sha256(codeVerifier));

  const url = new URL(d.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", OIDC.clientId);
  url.searchParams.set("redirect_uri", OIDC.redirectUri);
  url.searchParams.set("scope", OIDC.scope);
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("code_challenge", codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");

  return {
    url: url.toString(),
    pending: { state, nonce, codeVerifier, returnTo: returnTo.startsWith("/") ? returnTo : "/inbox" },
  };
}

export async function completeLogin(
  code: string,
  pending: Pending,
): Promise<{ username: string; sub: string }> {
  const d = await getDiscovery();

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: OIDC.redirectUri,
    client_id: OIDC.clientId,
    client_secret: OIDC.clientSecret,
    code_verifier: pending.codeVerifier,
  });

  const tokenRes = await fetch(d.token_endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!tokenRes.ok) {
    const text = await tokenRes.text();
    throw new Error(`token exchange failed (${tokenRes.status}): ${text}`);
  }

  const tokens = (await tokenRes.json()) as { id_token?: string };
  if (!tokens.id_token) throw new Error("no id_token returned");

  const { payload } = await jwtVerify(tokens.id_token, jwks!, {
    issuer: d.issuer,
    audience: OIDC.clientId,
  });

  if (payload.nonce !== pending.nonce) throw new Error("nonce mismatch");

  const username = pickUsername(payload as Record<string, unknown>);
  if (!username) throw new Error("no usable username in token");

  return { username, sub: String(payload.sub || "") };
}

export function endSessionUrl(): string | null {
  if (!discovery?.end_session_endpoint || !OIDC.postLogoutRedirectUri) return null;
  const url = new URL(discovery.end_session_endpoint);
  url.searchParams.set("post_logout_redirect_uri", OIDC.postLogoutRedirectUri);
  url.searchParams.set("client_id", OIDC.clientId);
  return url.toString();
}
