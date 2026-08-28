export type PushSubscription = {
  endpoint: string;
  keys: { p256dh: string; auth: string };
};

export type VapidKeys = {
  public: string;
  private: string;
  subject: string;
};

const textEncoder = new TextEncoder();

function b64urlToBytes(input: string): Uint8Array {
  const normalized = input.replace(/-/g, "+").replace(/_/g, "/");
  const padded = normalized + "=".repeat((4 - (normalized.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function bytesToB64url(bytes: Uint8Array): string {
  let binary = "";
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey(
    "raw",
    key,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}

async function hkdf(
  salt: Uint8Array,
  ikm: Uint8Array,
  info: Uint8Array,
  length: number,
): Promise<Uint8Array> {
  const prk = await hmac(salt, ikm);
  const expanded = await hmac(prk, concat(info, new Uint8Array([1])));
  return expanded.slice(0, length);
}

async function vapidAuthorization(endpoint: string, vapid: VapidKeys): Promise<string> {
  const url = new URL(endpoint);
  const header = bytesToB64url(textEncoder.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const payload = bytesToB64url(
    textEncoder.encode(
      JSON.stringify({
        aud: `${url.protocol}//${url.host}`,
        exp: Math.floor(Date.now() / 1000) + 12 * 60 * 60,
        sub: vapid.subject,
      }),
    ),
  );
  const unsigned = `${header}.${payload}`;

  const pub = b64urlToBytes(vapid.public);
  const priv = b64urlToBytes(vapid.private);
  const jwk: JsonWebKey = {
    kty: "EC",
    crv: "P-256",
    x: bytesToB64url(pub.slice(1, 33)),
    y: bytesToB64url(pub.slice(33, 65)),
    d: bytesToB64url(priv),
    ext: true,
  };
  const key = await crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "ECDSA", namedCurve: "P-256" },
    false,
    ["sign"],
  );
  const signature = new Uint8Array(
    await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, textEncoder.encode(unsigned)),
  );

  return `vapid t=${unsigned}.${bytesToB64url(signature)}, k=${vapid.public}`;
}

async function encryptPayload(sub: PushSubscription, payload: string): Promise<Uint8Array> {
  const clientPublic = b64urlToBytes(sub.keys.p256dh);
  const authSecret = b64urlToBytes(sub.keys.auth);
  const plaintext = textEncoder.encode(payload);

  const ephemeral = (await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveBits"],
  )) as CryptoKeyPair;
  const ephemeralPublic = new Uint8Array(
    (await crypto.subtle.exportKey("raw", ephemeral.publicKey)) as ArrayBuffer,
  );

  const clientKey = await crypto.subtle.importKey(
    "raw",
    clientPublic,
    { name: "ECDH", namedCurve: "P-256" },
    false,
    [],
  );
  const sharedSecret = new Uint8Array(
    await crypto.subtle.deriveBits(
      { name: "ECDH", public: clientKey } as unknown as SubtleCryptoDeriveKeyAlgorithm,
      ephemeral.privateKey,
      256,
    ),
  );

  const keyInfo = concat(
    textEncoder.encode("WebPush: info\0"),
    clientPublic,
    ephemeralPublic,
  );
  const ikm = await hkdf(authSecret, sharedSecret, keyInfo, 32);

  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, textEncoder.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, textEncoder.encode("Content-Encoding: nonce\0"), 12);

  const aesKey = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["encrypt"]);
  const ciphertext = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv: nonce },
      aesKey,
      concat(plaintext, new Uint8Array([2])),
    ),
  );

  const recordSize = 4096;
  const header = concat(
    salt,
    new Uint8Array([
      (recordSize >>> 24) & 0xff,
      (recordSize >>> 16) & 0xff,
      (recordSize >>> 8) & 0xff,
      recordSize & 0xff,
    ]),
    new Uint8Array([ephemeralPublic.length]),
    ephemeralPublic,
  );

  return concat(header, ciphertext);
}

export async function sendWebPush(
  sub: PushSubscription,
  payload: string,
  vapid: VapidKeys,
): Promise<Response> {
  const body = await encryptPayload(sub, payload);
  const authorization = await vapidAuthorization(sub.endpoint, vapid);

  return fetch(sub.endpoint, {
    method: "POST",
    headers: {
      Authorization: authorization,
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      TTL: "2419200",
    },
    body,
  });
}
