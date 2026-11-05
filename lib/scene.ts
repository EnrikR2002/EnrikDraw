import type { ExcalidrawElement } from "@excalidraw/excalidraw/element/types";

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
