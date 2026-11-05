import "server-only";
import { supabase, type DrawingRow } from "./supabase";

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const MAX_SCENE_CHARS = 25_000_000;
export const summaryColumns = "id, title, created_at, updated_at, revision";
export type DrawingSummary = Pick<DrawingRow, "id" | "title" | "created_at" | "updated_at" | "revision">;

export function activeDrawings() {
  return supabase().from("drawings").select(summaryColumns).is("deleted_at", null);
}

export function updateDrawing(
  id: string,
  revision: string,
  changes: Partial<Pick<DrawingRow, "scene" | "title" | "deleted_at">>,
) {
  return supabase().from("drawings").update(changes)
    .eq("id", id).eq("revision", revision).is("deleted_at", null)
    .select(summaryColumns).maybeSingle();
}
