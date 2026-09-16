/**
 * Owner-only list and create endpoints.
 *
 * Guarded twice: once by proxy.ts, and once here, so the data stays private
 * even if the proxy matcher is ever changed by mistake.
 */
import { NextResponse } from "next/server";
import { isOwnerRequest, unauthorized } from "@/lib/basic-auth";
import { supabase, type DrawingRow } from "@/lib/supabase";
import { editorUrl, embedUrl } from "@/lib/token";
import { originFromHeaders } from "@/lib/origin";

export const dynamic = "force-dynamic";

const MAX_TITLE_LENGTH = 200;
const noStore = { "Cache-Control": "no-store" };

function cleanTitle(raw: unknown): string {
  const title = typeof raw === "string" ? raw.trim() : "";
  return (title || "Untitled").slice(0, MAX_TITLE_LENGTH);
}

export async function GET(request: Request) {
  if (!isOwnerRequest(request)) return unauthorized();

  const { data, error } = await supabase()
    .from("drawings")
    .select("id, title, created_at, updated_at")
    .order("updated_at", { ascending: false });

  if (error) {
    console.error("[enrikdraw] list drawings failed:", error.message);
    return NextResponse.json({ error: "Could not load drawings." }, { status: 500, headers: noStore });
  }

  const origin = originFromHeaders(request.headers);
  const drawings = (data as Pick<DrawingRow, "id" | "title" | "created_at" | "updated_at">[]).map(
    (row) => ({
      ...row,
      editorUrl: editorUrl(origin, row.id),
      embedUrl: embedUrl(origin, row.id),
    }),
  );

  return NextResponse.json({ drawings }, { headers: noStore });
}

export async function POST(request: Request) {
  if (!isOwnerRequest(request)) return unauthorized();

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Expected a JSON body." }, { status: 400, headers: noStore });
  }

  const title = cleanTitle((body as { title?: unknown } | null)?.title);

  // scene stays null until the first autosave writes a real Excalidraw scene.
  const { data, error } = await supabase()
    .from("drawings")
    .insert({ title })
    .select("id, title, created_at, updated_at")
    .single();

  if (error || !data) {
    console.error("[enrikdraw] create drawing failed:", error?.message);
    return NextResponse.json({ error: "Could not create the drawing." }, { status: 500, headers: noStore });
  }

  const origin = originFromHeaders(request.headers);
  return NextResponse.json(
    {
      drawing: {
        ...data,
        editorUrl: editorUrl(origin, data.id),
        embedUrl: embedUrl(origin, data.id),
      },
    },
    { status: 201, headers: noStore },
  );
}
