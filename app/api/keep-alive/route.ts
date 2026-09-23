/**
 * Stops Supabase from pausing the project.
 *
 * Supabase pauses a free project after a week of low database activity, and a
 * paused project breaks every Notion embed until someone restores it. Vercel
 * Cron calls this route four times a day (see vercel.json), and each call reads
 * one row. The Hobby plan runs each cron job at most once a day, which is why
 * vercel.json lists four daily jobs instead of one.
 *
 * There is no authentication, on purpose. The route reads one id and answers
 * only {"ok":true} or {"ok":false}, so a caller learns nothing and changes
 * nothing. A CRON_SECRET check would add a setting that, if it went missing,
 * would make every run fail without anyone noticing.
 */
import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabase";

export const dynamic = "force-dynamic";

const noStore = { "Cache-Control": "no-store" };

export async function GET() {
  const { error } = await supabase().from("drawings").select("id").limit(1);

  if (error) {
    console.error("[enrikdraw] keep-alive read failed:", error.message);
    return NextResponse.json({ ok: false }, { status: 500, headers: noStore });
  }

  return NextResponse.json({ ok: true }, { headers: noStore });
}
