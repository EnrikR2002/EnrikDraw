/**
 * Read and write one drawing, using the capability token in the URL.
 *
 * There is no login here on purpose: a login prompt inside a Notion iframe is
 * unreliable. The token is an HMAC of the drawing id, so an id on its own
 * cannot open anything.
 */
import { NextResponse } from "next/server";
import { supabase, type DrawingRow } from "@/lib/supabase";
import { isValidToken } from "@/lib/token";

export const dynamic = "force-dynamic";

/**
 * Replies to any origin.
 *
 * This gives nothing away. The only key to a drawing is the token in the URL,
 * and these routes use no cookies and no session, so a caller from another
 * site gains nothing it did not already have. It is here because an iframe
 * sandboxed without allow-same-origin has an opaque origin, and its requests
 * would otherwise be refused, which would stop autosave inside an embed.
 */
const noStore = {
  "Cache-Control": "no-store",
  "Access-Control-Allow-Origin": "*",
};
/** Roughly 25 MB of JSON. Enough for a drawing with several pasted images. */
const MAX_SCENE_CHARS = 25_000_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Context = { params: Promise<{ id: string }> };

/** Answers the preflight that a browser sends before a cross-origin PUT. */
export async function OPTIONS() {
  return new Response(null, {
    status: 204,
    headers: {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "86400",
    },
  });
}

/**
 * Returns an error response when the caller may not touch this drawing.
 * Never logs the token itself.
 */
function checkAccess(request: Request, id: string): NextResponse | null {
  if (!UUID.test(id)) {
    return NextResponse.json({ error: "not_found" }, { status: 404, headers: noStore });
  }
  const token = new URL(request.url).searchParams.get("token");
  if (!isValidToken(id, token)) {
    return NextResponse.json({ error: "invalid_token" }, { status: 403, headers: noStore });
  }
  return null;
}

export async function GET(request: Request, { params }: Context) {
  const { id } = await params;
  const denied = checkAccess(request, id);
  if (denied) return denied;

  const { data, error } = await supabase()
    .from("drawings")
    .select("id, title, scene, updated_at")
    .eq("id", id)
    .maybeSingle();

  if (error) {
    console.error("[enrikdraw] load drawing failed:", id, error.message);
    return NextResponse.json({ error: "server_error" }, { status: 500, headers: noStore });
  }
  if (!data) {
    return NextResponse.json({ error: "not_found" }, { status: 404, headers: noStore });
  }

  const row = data as Pick<DrawingRow, "id" | "title" | "scene" | "updated_at">;
  return NextResponse.json({ drawing: row }, { headers: noStore });
}

export async function PUT(request: Request, { params }: Context) {
  const { id } = await params;
  const denied = checkAccess(request, id);
  if (denied) return denied;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400, headers: noStore });
  }

  const scene = (body as { scene?: unknown } | null)?.scene;
  if (typeof scene !== "string" || scene.length === 0) {
    return NextResponse.json({ error: "bad_request" }, { status: 400, headers: noStore });
  }
  if (scene.length > MAX_SCENE_CHARS) {
    console.error("[enrikdraw] scene too large:", id, scene.length, "characters");
    return NextResponse.json({ error: "too_large" }, { status: 413, headers: noStore });
  }

  const { data, error } = await supabase()
    .from("drawings")
    .update({ scene, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select("id, updated_at")
    .maybeSingle();

  if (error) {
    console.error("[enrikdraw] save drawing failed:", id, error.message);
    return NextResponse.json({ error: "server_error" }, { status: 500, headers: noStore });
  }
  if (!data) {
    return NextResponse.json({ error: "not_found" }, { status: 404, headers: noStore });
  }

  return NextResponse.json({ ok: true, updated_at: data.updated_at }, { headers: noStore });
}
