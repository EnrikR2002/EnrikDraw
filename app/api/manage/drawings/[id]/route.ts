/** Owner-only rename and delete for one drawing. */
import { NextResponse } from "next/server";
import { isOwnerRequest, unauthorized } from "@/lib/basic-auth";
import { supabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

const MAX_TITLE_LENGTH = 200;
const noStore = { "Cache-Control": "no-store" };

type Context = { params: Promise<{ id: string }> };

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

  const { data, error } = await supabase()
    .from("drawings")
    .update({ title, updated_at: new Date().toISOString() })
    .eq("id", id)
    .select("id, title, updated_at")
    .maybeSingle();

  if (error) {
    console.error("[enrikdraw] rename drawing failed:", error.message);
    return NextResponse.json({ error: "Could not rename the drawing." }, { status: 500, headers: noStore });
  }
  if (!data) {
    return NextResponse.json({ error: "That drawing does not exist." }, { status: 404, headers: noStore });
  }

  return NextResponse.json({ drawing: data }, { headers: noStore });
}

export async function DELETE(request: Request, { params }: Context) {
  if (!isOwnerRequest(request)) return unauthorized();

  const { id } = await params;

  const { error } = await supabase().from("drawings").delete().eq("id", id);
  if (error) {
    console.error("[enrikdraw] delete drawing failed:", error.message);
    return NextResponse.json({ error: "Could not delete the drawing." }, { status: 500, headers: noStore });
  }

  return NextResponse.json({ ok: true }, { headers: noStore });
}
