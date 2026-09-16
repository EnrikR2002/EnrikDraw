/**
 * Locks the drawing manager behind HTTP Basic Authentication.
 *
 * Only /manage and /api/manage/* are covered. The drawing editor at /d/[id]
 * and its API stay open on purpose: they are protected by the capability token
 * in the URL instead, because a login prompt breaks embedding in Notion.
 *
 * `proxy.ts` is the Next.js 16 name for what used to be `middleware.ts`.
 */
import { NextResponse, type NextRequest } from "next/server";
import { isOwnerRequest, unauthorized } from "@/lib/basic-auth";

export function proxy(request: NextRequest) {
  if (isOwnerRequest(request)) {
    return NextResponse.next();
  }
  return unauthorized();
}

export const config = {
  matcher: ["/manage/:path*", "/api/manage/:path*"],
};
