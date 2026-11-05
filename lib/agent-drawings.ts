import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { activeDrawings, MAX_SCENE_CHARS, summaryColumns, updateDrawing, type DrawingSummary } from "./drawing-store";
import { elementInput, operationInput, editScene } from "./agent-elements";
import { DrawingProblem, readScene } from "./scene";
import { supabase, type DrawingRow } from "./supabase";
import { editorUrl, embedUrl } from "./token";

export const drawingId = z.uuid();
const title = z.string().trim().min(1).max(200).regex(/^[^\x00-\x1f\x7f]+$/);
export const createInput = z.strictObject({
  requestId: z.uuidv4().describe("A fresh random UUID for this drawing. Reuse the same UUID and inputs when retrying."),
  title,
  elements: z.array(elementInput).max(200),
});
export const editInput = z.strictObject({
  id: drawingId,
  revision: z.uuid().describe("Exact revision from the latest inspection of the drawing."),
  title: title.optional(),
  operations: z.array(operationInput).max(200).optional(),
});

export function databaseError(operation: string, error?: { code?: string } | null): never {
  console.error(`[enrikdraw] ${operation} failed`, error?.code);
  throw new DrawingProblem("database_error", "The drawing database did not complete the request.");
}

function describeDrawing(row: DrawingSummary, origin: string) {
  return { id: row.id, title: row.title, revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at,
    editorUrl: editorUrl(origin, row.id), embedUrl: embedUrl(origin, row.id) };
}

function sceneString(scene: ReturnType<typeof readScene>) {
  const serialized = JSON.stringify(scene);
  if (serialized.length > MAX_SCENE_CHARS) throw new DrawingProblem("scene_too_large", "The resulting scene exceeds the drawing size limit.");
  return serialized;
}

function storedScene(value: string | null) {
  try {
    return readScene(value);
  } catch {
    throw new DrawingProblem("invalid_scene", "This drawing has an unreadable scene. Open it in EnrikDraw before editing.");
  }
}

export async function listDrawings(offset: number, limit: number) {
  const { data, error } = await activeDrawings().order("updated_at", { ascending: false }).order("id")
    .range(offset, offset + limit);
  if (error || !data) databaseError("list drawings", error);
  // Issue editable URLs only when a client requests a specific drawing.
  return { drawings: data.slice(0, limit).map(({ id, title, revision, updated_at }) => ({ id, title, revision, updatedAt: updated_at })),
    nextOffset: data.length > limit ? offset + limit : null };
}

export async function getDrawing(id: string, includeScene: boolean) {
  const { data, error } = await supabase().from("drawings")
    .select(includeScene ? `${summaryColumns}, scene` : summaryColumns)
    .eq("id", id).is("deleted_at", null).maybeSingle()
    .overrideTypes<DrawingSummary & Partial<Pick<DrawingRow, "scene">>, { merge: false }>();
  if (error) databaseError("get drawing", error);
  if (!data) throw new DrawingProblem("not_found", "The drawing does not exist or was deleted.");
  return data;
}

export async function inspectDrawing(origin: string, id: string, offset: number, limit: number, revision: string | undefined, includeLinks: boolean) {
  const row = await getDrawing(id, true);
  if (revision) checkRevision(row, revision);
  const scene = storedScene(row.scene ?? null);
  const elements = scene.elements.filter((element) => !element.isDeleted);
  // Bound the response for agent context windows. Omit binary and custom content.
  const summaries = [];
  let size = 0;
  for (const element of elements.slice(offset, offset + limit)) {
    const { id, type, x, y, width, height, angle, groupIds, frameId, locked, boundElements,
      strokeColor, backgroundColor, fillStyle, strokeStyle, strokeWidth, roughness, opacity } = element;
    const summary = { id, type, x, y, width, height, angle, groupIds, frameId, locked, boundElements,
      strokeColor, backgroundColor, fillStyle, strokeStyle, strokeWidth, roughness, opacity,
      ...(type === "text" && { text: (element.originalText ?? element.text)?.slice(0, 4000), fontSize: element.fontSize, containerId: element.containerId }),
      ...((type === "line" || type === "arrow") && { points: element.points?.slice(0, 64).map(([dx, dy]) => [x + dx, y + dy]),
        pointsTruncated: element.points?.length > 64, startBinding: element.startBinding, endBinding: element.endBinding }),
      ...((type === "frame" || type === "magicframe") && { name: element.name }),
    };
    size += JSON.stringify(summary).length;
    if (summaries.length && size > 24_000) break;
    summaries.push(summary);
  }
  const drawing = includeLinks ? describeDrawing(row, origin) : {
    id: row.id, title: row.title, revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at,
  };
  return { drawing, elements: summaries, totalElements: elements.length,
    nextOffset: offset + summaries.length < elements.length ? offset + summaries.length : null };
}

export async function createDrawing(origin: string, input: z.infer<typeof createInput>) {
  const { requestId, title, elements } = input;
  // Schema parsing gives a consistent property order for equivalent inputs.
  const fingerprint = createHash("sha256").update(JSON.stringify({ title, elements })).digest("hex");
  const scene = sceneString(editScene(readScene(null), elements.map((element) => ({ op: "add", element }))));
  const { data, error } = await supabase().from("drawings")
    .insert({ id: requestId, title, scene, creation_fingerprint: fingerprint }).select(summaryColumns).single();
  if (data && !error) return { drawing: describeDrawing(data, origin), replayed: false };
  if (error?.code !== "23505") databaseError("create drawing", error);

  const existing = await supabase().from("drawings").select(`${summaryColumns}, creation_fingerprint, deleted_at`)
    .eq("id", requestId).maybeSingle();
  if (existing.error) databaseError("check create retry", existing.error);
  if (existing.data?.creation_fingerprint !== fingerprint) {
    throw new DrawingProblem("request_id_conflict", "That request ID has already been used with different inputs.");
  }
  if (existing.data.deleted_at) throw new DrawingProblem("not_found", "The original drawing was deleted.");
  return { drawing: describeDrawing(existing.data, origin), replayed: true };
}

function checkRevision(row: DrawingSummary, revision: string) {
  if (row.revision !== revision.toLowerCase()) conflict();
}

function conflict(): never {
  throw new DrawingProblem("revision_conflict", "The drawing changed. Inspect it again and reconcile your intended edit before retrying.");
}

export async function editDrawing(origin: string, { id, revision, title, operations }: z.infer<typeof editInput>) {
  if (title === undefined && !operations?.length) throw new DrawingProblem("invalid_edit", "Supply a title or at least one element operation.");
  const row = await getDrawing(id, !!operations?.length);
  checkRevision(row, revision);
  const changes = {
    ...(title !== undefined && { title }),
    ...(operations?.length && { scene: sceneString(editScene(storedScene(row.scene ?? null), operations)) }),
  };
  const { data, error } = await updateDrawing(id, revision, changes);
  if (error) databaseError("edit drawing", error);
  if (!data) conflict();
  return { drawing: describeDrawing(data, origin) };
}

export async function deleteDrawing(id: string, revision: string, confirmedTitle: string) {
  const row = await getDrawing(id, false);
  checkRevision(row, revision);
  if (row.title !== confirmedTitle) throw new DrawingProblem("title_mismatch", "Supply the exact title of the drawing you intend to delete.");
  const { data, error } = await updateDrawing(id, revision, { deleted_at: new Date().toISOString() });
  if (error) databaseError("delete drawing", error);
  if (!data) conflict();
  return { id: row.id, deleted: true };
}
