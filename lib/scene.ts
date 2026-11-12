import type { AppState } from "@excalidraw/excalidraw/types";
import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";

// Leave room below Vercel's 4.5 MB limit on each request.
export const MAX_SAVE_REQUEST_BYTES = 4_000_000;
export const MAX_SCENE_BYTES = 25_000_000;
// A UTF-8 character can carry up to three bytes over from the previous slice.
export const SAVE_PART_BYTES = MAX_SAVE_REQUEST_BYTES - 3;
export const MAX_SAVE_PARTS = Math.ceil(MAX_SCENE_BYTES / SAVE_PART_BYTES);

export function sceneSaveKey(elementHash: number, appState: Partial<AppState> | null | undefined) {
  // These are the canvas settings Excalidraw includes in a local export.
  return JSON.stringify([elementHash, appState?.viewBackgroundColor, appState?.gridSize,
    appState?.gridStep, appState?.gridModeEnabled]);
}

export type Scene = {
  type: "excalidraw";
  version: number;
  source: string;
  elements: ExcalidrawElement[];
  appState?: Record<string, unknown>;
  files?: Record<string, unknown>;
};

export class DrawingProblem extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

export function readScene(saved: string | null): Scene {
  if (saved === null) {
    return { type: "excalidraw", version: 2, source: "EnrikDraw", elements: [], appState: {}, files: {} };
  }
  const value: unknown = JSON.parse(saved);
  if (!isRecord(value) || value.type !== "excalidraw" || !Array.isArray(value.elements) ||
    (value.appState != null && !isRecord(value.appState)) || (value.files != null && !isRecord(value.files))) {
    throw new DrawingProblem("invalid_scene", "The drawing does not contain a readable Excalidraw scene.");
  }
  const ids = new Set<string>();
  for (const element of value.elements) {
    if (!isRecord(element) || typeof element.id !== "string" || !element.id || ids.has(element.id) ||
      typeof element.type !== "string") {
      throw new DrawingProblem("invalid_scene", "The drawing contains an invalid or duplicate element ID.");
    }
    ids.add(element.id);
  }
  return value as Scene;
}
