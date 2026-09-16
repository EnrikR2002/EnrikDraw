/**
 * HTTP Basic Authentication for the owner-only pages and APIs.
 *
 * Deliberately tiny: one username and one password, both from environment
 * variables. There are no user accounts in this app.
 *
 * This file is imported by proxy.ts as well as by route handlers, so it must
 * not use any Node-only API.
 */

const REALM = 'Basic realm="EnrikDraw", charset="UTF-8"';

/** Compares two strings without leaking where they differ, via their timing. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

export function isOwnerRequest(request: Request): boolean {
  const expectedUser = process.env.OWNER_USERNAME;
  const expectedPass = process.env.OWNER_PASSWORD;
  // Fail closed: with no credentials configured, nobody gets in.
  if (!expectedUser || !expectedPass) return false;

  const header = request.headers.get("authorization");
  if (!header?.startsWith("Basic ")) return false;

  let decoded: string;
  try {
    decoded = atob(header.slice("Basic ".length).trim());
  } catch {
    return false;
  }

  const separator = decoded.indexOf(":");
  if (separator === -1) return false;

  const user = decoded.slice(0, separator);
  const pass = decoded.slice(separator + 1);
  // Both comparisons always run, so a wrong username costs the same as a wrong
  // password.
  const userOk = safeEqual(user, expectedUser);
  const passOk = safeEqual(pass, expectedPass);
  return userOk && passOk;
}

export function unauthorized(): Response {
  return new Response("Authentication required.", {
    status: 401,
    headers: {
      "WWW-Authenticate": REALM,
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}
