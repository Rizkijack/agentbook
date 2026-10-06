/**
 * Browser session cookie for the external-agent gateway.
 *
 * Why this exists: the chat UI used to demand a bearer token on every send, which
 * meant the token had to live in JavaScript (localStorage/sessionStorage or an
 * input box) where any script on the page — including anything injected by a
 * third-party embed or an XSS payload — can read it. An `HttpOnly` cookie is
 * invisible to `document.cookie`, so the credential never enters the JS heap:
 * the browser attaches it to the request and the page cannot exfiltrate it.
 *
 * The cookie value IS the agent token. No server-side session store is needed:
 * `verifyToken()` already hashes the presented value and compares it in
 * constant time against the stored sha256, so the cookie is a capability with
 * exactly the same lifetime and revocation as the header token. Rotating the
 * token therefore logs the browser out for free.
 *
 * Deliberately dependency-free and side-effect-free (express 4 ships no cookie
 * parser and the repo may not add one): `req.headers.cookie` is hand-parsed
 * here, and every function is a pure string transform, so the whole module is
 * unit-testable without a server.
 */

/** Cookie name. Kept in one place so the router and the tests cannot drift. */
export const SESSION_COOKIE = "sabk_session";

/** 30 days, in seconds — the value goes out as `Max-Age`. */
export const SESSION_MAX_AGE = 2_592_000;

/**
 * Decode a cookie value without ever throwing. A malformed `%` sequence is
 * returned raw rather than raising: this function runs inside the auth
 * middleware, and a garbage cookie must degrade to "no session" (401), never to
 * a 500 that would take the whole gateway down.
 */
function safeDecode(value: string): string {
  if (!value.includes("%")) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Parse a `Cookie:` request header into a name → value map.
 *
 * - A missing/empty header yields `{}` (not an error): most requests carry no
 *   cookies at all, and that is a normal "not logged in" answer.
 * - The value is everything after the FIRST `=`, so base64/JWT-ish values that
 *   contain `=` survive intact.
 * - On a duplicated name the FIRST occurrence wins. That is the defensive
 *   choice against cookie tossing: when a hostile sibling host plants a cookie
 *   for our name, the browser sends the genuine host-only cookie first, so
 *   first-wins keeps the victim's real session in play.
 */
export function parseCookies(header?: string | null): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 1) continue; // no `=`, or an empty name: not a cookie pair
    const name = part.slice(0, eq).trim();
    if (!name || Object.prototype.hasOwnProperty.call(out, name)) continue;
    out[name] = safeDecode(part.slice(eq + 1).trim());
  }
  return out;
}

export interface SessionCookieOptions {
  /** Append the `Secure` attribute. Defaults to true; false only under NODE_ENV=test. */
  secure?: boolean;
}

/**
 * Build the `Set-Cookie` value that logs an agent in.
 *
 * `Path=/` so the cookie covers `/api/agent/*` from anywhere under the app; the
 * `Max-Age` is the session length. The value is percent-encoded on the way out:
 * the token arrives from a request body, and an unescaped `;` or newline would
 * let a caller append attributes or split the response header. Encoding keeps
 * `encode -> parse` an exact round trip (see parseCookies/safeDecode).
 */
export function serializeSessionCookie(value: string, opts: SessionCookieOptions = {}): string {
  const { secure = true } = opts;
  const parts = [
    `${SESSION_COOKIE}=${encodeURIComponent(value)}`,
    "HttpOnly",
    "SameSite=Lax",
    "Path=/",
    `Max-Age=${SESSION_MAX_AGE}`,
  ];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

/**
 * Build the `Set-Cookie` value that logs an agent out. Same name, path and
 * attributes — a browser only overwrites a cookie when those match — with
 * `Max-Age=0`, which expires it immediately. A mismatched Path would leave the
 * original cookie alive and the "logout" would silently do nothing.
 */
export function clearSessionCookie(opts: SessionCookieOptions = {}): string {
  const { secure = true } = opts;
  const parts = [`${SESSION_COOKIE}=`, "HttpOnly", "SameSite=Lax", "Path=/", "Max-Age=0"];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}

/** Minimal request shape this module needs — keeps it testable without express. */
export interface CookieCarrier {
  headers?: { [key: string]: string | string[] | undefined } | undefined;
}

/**
 * The session token carried by a request, or null when there is none.
 *
 * Returns null (never throws, never a partial value) for a missing header, a
 * missing cookie, or an empty value, so the caller can treat "no cookie" and
 * "bad cookie" identically: not authenticated.
 */
export function sessionCookieFrom(req: CookieCarrier): string | null {
  const header = req.headers?.cookie;
  const raw = Array.isArray(header) ? header[0] : header;
  const value = parseCookies(raw)[SESSION_COOKIE];
  return value && value.length > 0 ? value : null;
}
