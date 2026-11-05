/** Owner-only rename and delete for one drawing. */
import { NextResponse } from "next/server";
import { isOwnerRequest, unauthorized } from "@/lib/basic-auth";
import { updateDrawing, UUID } from "@/lib/drawing-store";

export const dynamic = "force-dynamic";

const MAX_TITLE_LENGTH = 200;
const noStore = { "Cache-Control": "no-store" };

type Context = { params: Promise<{ id: string }> };

async function change(request: Request, id: string, changes: Parameters<typeof updateDrawing>[2]) {
  const revision = request.headers.get("If-Match")?.match(/^"([^"]+)"$/)?.[1];
  if (!revision || !UUID.test(revision) || !UUID.test(id)) {
    return NextResponse.json({ error: "Reload the manager to get the drawing's revision." }, { status: 428, headers: noStore });
  }

  const { data, error } = await updateDrawing(id, revision, changes);
  if (error) {
    console.error("[enrikdraw] manager update failed:", error.code);
    return NextResponse.json({ error: "Could not update the drawing." }, { status: 500, headers: noStore });
  }
  if (!data) {
    return NextResponse.json({ error: "The drawing changed. Reload the manager and try again." }, { status: 409, headers: noStore });
  }
  return NextResponse.json(changes.deleted_at ? { ok: true } : { drawing: data }, { headers: noStore });
}

export async function PATCH(request: Request, { params }: Context) {
  if (!isOwnerRequest(request)) return unauthorized();

  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400, headers: noStore });
  }

  const raw = (body as { title?: unknown } | null)?.title;
  const title = typeof raw === "string" ? raw.trim().slice(0, MAX_TITLE_LENGTH) : "";
  if (!title) {
    return NextResponse.json({ error: "A title is required." }, { status: 400, headers: noStore });
  }

  return change(request, id, { title });
}

export async function DELETE(request: Request, { params }: Context) {
  if (!isOwnerRequest(request)) return unauthorized();

  const { id } = await params;

  return change(request, id, { deleted_at: new Date().toISOString() });
}
