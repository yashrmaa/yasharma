// Stateless sessions: no database and no credential in browser storage.
const COOKIE = "__Host-notebook";
const MAX_AGE = 30 * 24 * 60 * 60;
const encoder = new TextEncoder();

async function key(secret) {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

function signatureInput(payload, origin) {
  return encoder.encode(`notebook-session-v1:${origin}:${payload}`);
}

export function cookie(value, age = MAX_AGE) {
  return `${COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${age}`;
}

export async function newSession(secret, origin, now) {
  const issued = Math.floor(now.getTime() / 1000);
  const payload = `${issued}.${issued + MAX_AGE}.${crypto.randomUUID()}`;
  const signature = new Uint8Array(await crypto.subtle.sign("HMAC", await key(secret), signatureInput(payload, origin)));
  return cookie(`${payload}.${Array.from(signature, byte => byte.toString(16).padStart(2, "0")).join("")}`);
}

export async function hasSession(request, secret, now) {
  const value = (request.headers.get("Cookie") || "").split(";").map(part => part.trim()).find(part => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
  if (!value || !/^\d{10}\.\d{10}\.[a-f0-9-]{36}\.[a-f0-9]{64}$/.test(value)) return false;
  const [issued, expires, nonce, signature] = value.split(".");
  const seconds = Math.floor(now.getTime() / 1000);
  if (+expires <= seconds || +issued > seconds + 60 || +expires - +issued !== MAX_AGE) return false;
  const bytes = Uint8Array.from(signature.match(/../g), byte => parseInt(byte, 16));
  return crypto.subtle.verify("HMAC", await key(secret), bytes, signatureInput(`${issued}.${expires}.${nonce}`, new URL(request.url).origin));
}

export function sameOrigin(request) {
  return request.headers.get("Origin") === new URL(request.url).origin;
}

export const SECURITY_HEADERS = {
  "Content-Security-Policy": "default-src 'none'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:; manifest-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; object-src 'none'",
  "Referrer-Policy": "no-referrer",
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Cross-Origin-Resource-Policy": "same-origin",
  "X-Robots-Tag": "noindex, nofollow",
  "Cache-Control": "no-store",
};
