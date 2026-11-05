import "server-only";
import { z } from "zod";
import { drawingId, getDrawingSnapshot } from "./agent-drawings";
import { editScene, elementInput, operationInput } from "./agent-elements";
import { renderPreview } from "./preview-renderer";
import { DrawingProblem, readScene, type Scene } from "./scene";

export const previewInput = z.strictObject({
  id: drawingId.optional().describe("Saved drawing ID. Omit for a new draft."),
  revision: z.uuid().optional().describe("Saved revision to check. Required with proposed operations."),
  elements: z.array(elementInput).max(200).optional().describe("Elements for an unsaved new draft. Same format as create drawing."),
  operations: z.array(operationInput).min(1).max(200).optional().describe("Proposed changes to a saved drawing. Same format as edit drawing."),
});

export async function previewDrawing({ id, revision, elements, operations }: z.infer<typeof previewInput>) {
  let scene: Scene;
  let savedRevision: string | null = null;
  if (id && elements === undefined && (!operations || revision)) {
    const snapshot = await getDrawingSnapshot(id, revision);
    savedRevision = snapshot.row.revision;
    scene = operations ? editScene(snapshot.scene, operations) : snapshot.scene;
  } else if (elements !== undefined && !id && !revision && !operations) {
    scene = editScene(readScene(null), elements.map((element) => ({ op: "add", element })));
  } else {
    throw new DrawingProblem("invalid_preview",
      "Supply draft elements alone, a saved drawing ID with optional revision, or an ID and revision with proposed operations.");
  }

  const visible = scene.elements.filter((element) => !element.isDeleted);
  if (scene.elements.length > 3000) throw new DrawingProblem("preview_too_large", "This drawing has too many elements for a preview. Inspect its elements or open it in the editor.");

  // Carry only the inline images actually used by the drawing. Never fetch
  // external URLs or include unrelated saved files in a preview.
  const files: NonNullable<Scene["files"]> = Object.create(null);
  let unavailableImages = 0;
  for (const element of visible) {
    if (element.type !== "image") continue;
    const fileId = element.fileId;
    const file = fileId && Object.hasOwn(scene.files ?? {}, fileId) ? scene.files?.[fileId] : null;
    const dataURL = file && typeof file === "object" && "dataURL" in file ? file.dataURL : null;
    const mimeType = typeof dataURL === "string" &&
      /^data:(image\/(?:png|jpeg|webp|gif|bmp|svg\+xml|avif));base64,/i.exec(dataURL)?.[1];
    if (fileId && mimeType) {
      files[fileId] = { id: fileId, dataURL, mimeType: mimeType.toLowerCase(), created: 0 };
    } else {
      unavailableImages++;
    }
  }
  // Keep deleted elements for Excalidraw's binding restoration; export skips them.
  const { png, width, height } = await renderPreview({
    ...scene, appState: { viewBackgroundColor: scene.appState?.viewBackgroundColor }, files,
  });
  return {
    png,
    details: {
      mode: id ? (operations ? "proposed_edit" : "saved_drawing") : "new_draft",
      id: id ?? null,
      revision: savedRevision,
      width, height,
      elementCount: visible.length,
      ...(unavailableImages > 0 && { unavailableImages }),
    },
  };
}
