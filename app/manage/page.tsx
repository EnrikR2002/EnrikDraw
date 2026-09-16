/**
 * The drawing manager. HTTP Basic Authentication is applied by proxy.ts.
 *
 * The list is read here on the server so the page is correct the moment it
 * loads. Creating, renaming and deleting go through /api/manage/drawings from
 * the browser, and then ask this page to render again.
 */
import { headers } from "next/headers";
import { supabase, type DrawingRow } from "@/lib/supabase";
import { editorUrl, embedUrl } from "@/lib/token";
import { originFromHeaders } from "@/lib/origin";
import ManageList, { type DrawingItem } from "./ManageList";

export const dynamic = "force-dynamic";

/**
 * Formats a timestamp in UTC.
 *
 * Deliberately not the viewer's local time: this string is produced on the
 * server, and a server and a browser in different time zones would disagree
 * and break hydration.
 */
function formatStamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "-";
  return new Intl.DateTimeFormat("en-GB", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(date);
}

export default async function ManagePage() {
  const requestHeaders = await headers();
  const origin = originFromHeaders(requestHeaders);

  const { data, error } = await supabase()
    .from("drawings")
    .select("id, title, created_at, updated_at")
    .order("updated_at", { ascending: false });

  if (error) {
    console.error("[enrikdraw] could not list drawings:", error.message);
    return (
      <main className="manage">
        <h1>EnrikDraw</h1>
        <p className="error-banner">
          Could not reach the database. Check SUPABASE_URL and
          SUPABASE_SERVICE_ROLE_KEY, then reload this page.
        </p>
      </main>
    );
  }

  const rows = (data ?? []) as Pick<DrawingRow, "id" | "title" | "created_at" | "updated_at">[];
  const drawings: DrawingItem[] = rows.map((row) => ({
    id: row.id,
    title: row.title,
    updatedAt: formatStamp(row.updated_at),
    editorUrl: editorUrl(origin, row.id),
    embedUrl: embedUrl(origin, row.id),
  }));

  return <ManageList drawings={drawings} />;
}
