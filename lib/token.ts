/**
 * Capability tokens for a single drawing.
 *
 * A token is HMAC-SHA256 over the drawing id, keyed by DRAWING_ACCESS_SECRET.
 * Nothing is stored in the database: the server can always recompute a token
 * from an id, and knowing an id alone is not enough to open a drawing.
 */
import "server-only";
import { createHmac, timingSafeEqual } from "node:crypto";
import { serverEnv } from "./env";

export function deriveToken(drawingId: string): string {
  return createHmac("sha256", serverEnv.drawingAccessSecret)
    .update(drawingId)
    .digest("base64url");
}

export function isValidToken(drawingId: string, supplied: string | null): boolean {
  if (!supplied) return false;
  const expected = Buffer.from(deriveToken(drawingId), "utf8");
  const given = Buffer.from(supplied, "utf8");
  // timingSafeEqual throws on a length mismatch, so check length first. Token
  // length is fixed and public, so leaking it tells an attacker nothing.
  if (expected.length !== given.length) return false;
  return timingSafeEqual(expected, given);
}

/** Absolute URL of the editor page for a drawing. */
export function editorUrl(origin: string, drawingId: string): string {
  return `${origin}/d/${drawingId}?token=${deriveToken(drawingId)}`;
}

/** Absolute URL to paste into a Notion /embed block. */
export function embedUrl(origin: string, drawingId: string): string {
  return `${editorUrl(origin, drawingId)}&embed=1`;
}
