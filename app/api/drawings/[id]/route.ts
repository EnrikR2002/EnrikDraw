/**
 * Read and write one drawing, using the capability token in the URL.
 *
 * There is no login here on purpose: a login prompt inside a Notion iframe is
 * unreliable. The token is an HMAC of the drawing id, so an id on its own
 * cannot open anything.
 */
import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";
import { isValidToken } from "@/lib/token";
import { activeDrawings, updateDrawing, UUID } from "@/lib/drawing-store";
import { DrawingProblem, MAX_SAVE_PARTS, MAX_SAVE_REQUEST_BYTES, MAX_SCENE_BYTES, readScene } from "@/lib/scene";

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
const saveParts = "drawing_save_parts";

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

  const metadataOnly = new URL(request.url).searchParams.get("metadata") === "1";
  const { data, error } = await (metadataOnly
    ? activeDrawings()
    : supabase().from("drawings").select("id, title, scene, updated_at, revision").is("deleted_at", null))
    .eq("id", id).maybeSingle();

  if (error) {
    console.error("[enrikdraw] load drawing failed:", id, error.message);
    return NextResponse.json({ error: "server_error" }, { status: 500, headers: noStore });
  }
  if (!data) {
    return NextResponse.json({ error: "not_found" }, { status: 404, headers: noStore });
  }

  if (metadataOnly) return NextResponse.json({ drawing: data }, { headers: noStore });

  // Stream full reads so drawings above Vercel's buffered limit can be opened.
  const body = new Blob([JSON.stringify({ drawing: data })], { type: "application/json" });
  return new Response(body.stream(), { headers: { ...noStore, "Content-Type": body.type } });
}

async function readSaveBody(request: Request) {
  const reader = request.body?.getReader();
  if (!reader) throw new DrawingProblem("bad_request", "Missing save body.");

  try {
    const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
    let bytes = 0;
    let text = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_SAVE_REQUEST_BYTES) {
        throw new DrawingProblem("too_large", "Save request exceeds the request size limit.");
      }
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally {
    void reader.cancel().catch(() => undefined);
  }
}

function saveError(error: string, status: number) {
  return NextResponse.json({ error }, { status, headers: noStore });
}

async function stagePart(id: string, query: URLSearchParams, chunk: string) {
  const uploadId = query.get("uploadId");
  const revision = query.get("revision");
  const part = Number(query.get("part"));
  if (!uploadId || !UUID.test(uploadId) || !revision || !UUID.test(revision) ||
      String(part) !== query.get("part") || !Number.isInteger(part) || part < 0 || part >= MAX_SAVE_PARTS || !chunk) {
    return saveError("bad_request", 400);
  }

  const { data, error } = await supabase().rpc("stage_drawing_save_part", {
    p_drawing_id: id,
    p_revision: revision,
    p_upload_id: uploadId,
    p_part: part,
    p_chunk: chunk,
  });
  if (data === "revision_conflict") return saveError(data, 409);
  if (data === "upload_incomplete") return saveError(data, 422);
  if (error || data !== "staged") {
    console.error("[enrikdraw] stage drawing part failed:", error?.code);
    return saveError("server_error", 500);
  }
  return new Response(null, { status: 204, headers: noStore });
}

export async function PUT(request: Request, { params }: Context) {
  const { id } = await params;
  const denied = checkAccess(request, id);
  if (denied) return denied;

  const query = new URL(request.url).searchParams;
  let body: unknown;
  try {
    const text = await readSaveBody(request);
    if (query.has("part")) return stagePart(id, query, text);
    body = JSON.parse(text);
  } catch (error) {
    if (error instanceof DrawingProblem && error.code === "too_large") return saveError("too_large", 413);
    return saveError("bad_request", 400);
  }

  const { scene: inlineScene, revision, uploadId, partCount } = (body ?? {}) as {
    scene?: unknown; revision?: unknown; uploadId?: unknown; partCount?: unknown;
  };
  if (typeof revision !== "string" || !UUID.test(revision)) {
    return saveError("revision_required", 428);
  }

  let scene = inlineScene;
  if (uploadId !== undefined) {
    if (inlineScene !== undefined || typeof uploadId !== "string" || !UUID.test(uploadId) ||
        typeof partCount !== "number" || !Number.isInteger(partCount) || partCount < 1 || partCount > MAX_SAVE_PARTS) {
      return saveError("bad_request", 400);
    }
    const { data: parts, error } = await supabase().from(saveParts).select("part, chunk")
      .eq("drawing_id", id).eq("upload_id", uploadId).eq("revision", revision)
      .gt("expires_at", new Date().toISOString()).order("part");
    if (error) {
      console.error("[enrikdraw] read drawing parts failed:", error.code);
      return saveError("server_error", 500);
    }
    if (parts.length !== partCount || parts.some((item, index) => item.part !== index)) {
      return saveError("upload_incomplete", 422);
    }
    scene = parts.map((item) => item.chunk).join("");
  }
  if (typeof scene !== "string" || scene.length === 0) {
    return saveError("bad_request", 400);
  }
  if (Buffer.byteLength(scene) > MAX_SCENE_BYTES) return saveError("too_large", 413);
  try {
    readScene(scene);
  } catch {
    return saveError("invalid_scene", 400);
  }

  const { data, error } = await updateDrawing(id, revision, { scene });

  if (error) {
    console.error("[enrikdraw] save drawing failed:", id, error.code);
    return saveError("server_error", 500);
  }
  if (!data) {
    return saveError("revision_conflict", 409);
  }

  if (typeof uploadId === "string") {
    const cleanup = await supabase().from(saveParts).delete()
      .eq("drawing_id", id).eq("upload_id", uploadId).eq("revision", revision);
    if (cleanup.error) console.error("[enrikdraw] remove saved parts failed:", cleanup.error.code);
  }

  return NextResponse.json({ ok: true, updated_at: data.updated_at, revision: data.revision }, { headers: noStore });
}
