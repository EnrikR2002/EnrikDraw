import "server-only";
import { z } from "zod";
import { databaseError, getDrawing } from "./agent-drawings";
import { DrawingProblem } from "./scene";
import { supabase } from "./supabase";
import { embedUrl } from "./token";

const destinationsInput = z.record(z.string().trim().min(1).max(100), z.uuid());
const listResponse = z.object({
  results: z.array(z.object({ id: z.uuid(), type: z.string(), embed: z.object({ url: z.string() }).optional() })),
  next_cursor: z.string().nullable(),
});

export function notionConfig() {
  const token = process.env.ENRIKDRAW_NOTION_TOKEN;
  if (!token) return null;
  try {
    const pages = new Map(Object.entries(destinationsInput.parse(JSON.parse(process.env.ENRIKDRAW_NOTION_PAGES ?? "{}"))));
    return pages.size && pages.size <= 50 ? { token, pages } : null;
  } catch {
    console.error("[enrikdraw] invalid Notion destination configuration");
    return null;
  }
}

export async function embedInNotion(origin: string, config: NonNullable<ReturnType<typeof notionConfig>>, id: string, destination: string) {
  const pageId = config.pages.get(destination);
  if (!pageId) throw new DrawingProblem("unknown_destination", "Choose an exact name from enrikdraw_list_notion_destinations.");
  const drawing = await getDrawing(id, false);
  const url = embedUrl(origin, drawing.id);
  const endpoint = `https://api.notion.com/v1/blocks/${pageId}/children`;
  const headers = { Authorization: `Bearer ${config.token}`, "Notion-Version": "2026-03-11", "Content-Type": "application/json" };
  const match = { drawing_id: drawing.id, page_id: pageId };
  const result = (blockId: string, existing: boolean) => ({ drawingId: drawing.id, pageId, blockId, embedUrl: url, existing });

  const claim = await supabase().from("notion_embeds").insert(match);
  const reserved = !claim.error;
  if (claim.error && claim.error.code !== "23505") databaseError("reserve Notion embed", claim.error);
  if (!reserved) {
    const { data, error } = await supabase().from("notion_embeds").select("block_id").match(match).maybeSingle();
    if (error) databaseError("read Notion embed", error);
    if (data?.block_id) return result(data.block_id, true);
  }

  async function release() {
    const { error } = await supabase().from("notion_embeds").delete().match(match).is("block_id", null);
    if (error) console.error("[enrikdraw] could not release Notion embed reservation", error.code);
  }

  async function record(blockId: string, existing: boolean) {
    const { error } = await supabase().from("notion_embeds").update({ block_id: blockId }).match(match);
    if (error) console.error("[enrikdraw] could not record Notion embed", error.code);
    return result(blockId, existing);
  }

  let cursor: string | null = null;
  try {
    // Detect manually inserted blocks and recover an append whose response was lost.
    const scanTimeout = AbortSignal.timeout(18_000);
    for (let page = 0; page < 20; page++) {
      const query = new URLSearchParams({ page_size: "100" });
      if (cursor) query.set("start_cursor", cursor);
      const signal = AbortSignal.any([scanTimeout, AbortSignal.timeout(4000)]);
      const response = await fetch(`${endpoint}?${query}`, { headers, signal, redirect: "error" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const blocks = listResponse.parse(await response.json());
      const found = blocks.results.find((block) => block.type === "embed" && block.embed?.url === url);
      if (found) return await record(found.id, true);
      cursor = blocks.next_cursor;
      if (!cursor) break;
    }
  } catch {
    if (reserved) await release();
    throw new DrawingProblem("notion_read_failed", "Could not read the destination page. Check the Notion connection's access and try again.");
  }
  if (!reserved) throw new DrawingProblem("notion_embed_pending", "An embed is in progress or its result is uncertain. Retry to check the page before attempting another append.");
  if (cursor) {
    await release();
    throw new DrawingProblem("notion_page_too_large", "The page has more than 2,000 top-level blocks. Use the embed URL directly.");
  }

  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: "PATCH", headers, redirect: "error", signal: AbortSignal.timeout(8000),
      body: JSON.stringify({ children: [{ type: "embed", embed: { url } }] }),
    });
  } catch {
    throw new DrawingProblem("notion_embed_pending", "Notion did not confirm the append. Retry to check the page for the embed.");
  }
  if ([400, 401, 403, 404, 429].includes(response.status)) {
    await release();
    throw new DrawingProblem("notion_write_failed", `Notion rejected the append (HTTP ${response.status}). Check page access or retry if rate limited.`);
  }
  if (response.ok) {
    const parsed = await response.json().catch(() => null);
    const block = listResponse.safeParse(parsed);
    const created = block.success && block.data.results.find((item) => item.type === "embed");
    if (created) return record(created.id, false);
  }
  throw new DrawingProblem("notion_embed_pending", "Notion did not confirm the append. Retry to check the page for the embed.");
}
