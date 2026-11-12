/**
 * Stops Supabase from pausing the project.
 *
 * Supabase pauses a free project after a week of low database activity, and a
 * paused project breaks every Notion embed until someone restores it. Vercel
 * Cron calls this route four times a day (see vercel.json), and each call reads
 * one row. The Hobby plan runs each cron job at most once a day, which is why
 * vercel.json lists four daily jobs instead of one.
 *
 * The same job removes expired temporary uploads. The route takes no input,
 * touches no saved drawings and answers only whether maintenance succeeded.
 */
import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };

export async function GET() {
  const [activity, cleanup] = await Promise.all([
    supabase().from("drawings").select("id").limit(1),
    supabase().from("drawing_save_parts").delete().lt("expires_at", new Date().toISOString()),
  ]);
  const error = activity.error ?? cleanup.error;

  if (error) {
    console.error("[enrikdraw] database maintenance failed:", error.code);
    return NextResponse.json({ ok: false }, { status: 500, headers: noStore });
  }

  return NextResponse.json({ ok: true }, { headers: noStore });
}
