import "server-only";
import { createHash, timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";

export const scopes = ["drawings:read", "drawings:write", "drawings:delete", "notion:embed"] as const;
export type Scope = (typeof scopes)[number];

const keyConfig = z.array(z.strictObject({
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  scopes: z.array(z.enum(scopes)).min(1),
})).max(20);

export function mcpOrigin() {
  const value = process.env.NEXT_PUBLIC_APP_URL;
  if (!value) return null;
  try {
    const url = new URL(value);
    if ((url.protocol === "https:" || (url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) &&
      url.pathname === "/" && !url.search && !url.hash && !url.username && !url.password) return url.origin;
  } catch {
    // Invalid configuration disables the MCP endpoint.
  }
  return null;
}

let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;
let jwksUrl: string | undefined;

export function oauthConfig() {
  const issuer = process.env.ENRIKDRAW_OAUTH_ISSUER;
  const keys = process.env.ENRIKDRAW_OAUTH_JWKS_URL;
  const subject = process.env.ENRIKDRAW_OAUTH_SUBJECT;
  const clientId = process.env.ENRIKDRAW_OAUTH_CLIENT_ID;
  if (!issuer || !keys || !subject || !clientId) return null;
  try {
    for (const value of [issuer, keys]) {
      const url = new URL(value);
      if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search) return null;
    }
  } catch {
    return null;
  }
  return { issuer, keys, subject, clientId };
}

export async function agentScopes(request: Request, origin: string): Promise<Scope[] | null> {
  const token = request.headers.get("Authorization")?.match(/^Bearer ([A-Za-z0-9_.-]{1,8192})$/i)?.[1];
  if (!token) return null;

  if (/^ed_[A-Za-z0-9_-]{43}$/.test(token)) {
    try {
      const keys = keyConfig.parse(JSON.parse(process.env.ENRIKDRAW_AGENT_KEYS ?? "[]"));
      const digest = createHash("sha256").update(token).digest();
      return keys.find((key) => timingSafeEqual(digest, Buffer.from(key.sha256, "hex")))?.scopes ?? null;
    } catch {
      console.error("[enrikdraw] invalid agent key configuration");
      return null;
    }
  }

  const oauth = oauthConfig();
  if (!oauth) return null;
  try {
    if (!jwks || jwksUrl !== oauth.keys) {
      jwks = createRemoteJWKSet(new URL(oauth.keys));
      jwksUrl = oauth.keys;
    }
    const { payload } = await jwtVerify(token, jwks, {
      algorithms: ["RS256"], issuer: oauth.issuer, audience: `${origin}/mcp`, subject: oauth.subject,
      requiredClaims: ["exp", "iat"], maxTokenAge: "1h",
    });
    if ((payload.azp ?? payload.client_id) !== oauth.clientId || typeof payload.scope !== "string") return null;
    const granted = new Set(payload.scope.split(/\s+/));
    const allowed = scopes.filter((scope) => granted.has(scope));
    return allowed.length ? allowed : null;
  } catch {
    return null;
  }
}
