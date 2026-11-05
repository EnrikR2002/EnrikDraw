import { randomInt } from "node:crypto";
import type { ExcalidrawElement, ExcalidrawLinearElement, ExcalidrawTextElement } from "@excalidraw/excalidraw/element/types";
import { z } from "zod";
import { DrawingProblem, type Scene } from "./scene";

const coord = z.number().min(-1_000_000).max(1_000_000);
const dimension = z.number().min(1).max(100_000);
const text = z.string().min(1).max(4000).regex(/\S/);
const color = z.string().regex(/^(#[0-9a-fA-F]{6}|transparent)$/);
const elementId = z.string().min(1).max(128);
const newId = elementId.regex(/^[A-Za-z0-9_-]+$/);
const points = z.array(z.tuple([coord, coord])).min(2).max(64)
  .describe("Absolute canvas coordinates, starting at the first endpoint.");
const style = {
  strokeColor: color.optional(),
  backgroundColor: color.optional(),
  strokeWidth: z.number().min(1).max(12).optional(),
  strokeStyle: z.enum(["solid", "dashed", "dotted"]).optional(),
  fillStyle: z.enum(["solid", "hachure", "cross-hatch", "zigzag"]).optional(),
  roughness: z.number().min(0).max(2).optional(),
  opacity: z.number().min(0).max(100).optional(),
};
const position = { x: coord, y: coord };
const dimensions = { width: dimension, height: dimension };
const base = { id: newId, ...style };

export const elementInput = z.union([
  z.strictObject({ ...base, type: z.enum(["rectangle", "diamond", "ellipse"]), ...position, ...dimensions }),
  z.strictObject({ ...base, type: z.literal("text"), ...position, text, fontSize: z.number().min(8).max(144).optional() }),
  z.strictObject({ ...base, type: z.enum(["line", "arrow"]), points }),
]);

const changesInput = z.strictObject({
  ...style,
  x: coord.optional(), y: coord.optional(), width: dimension.optional(), height: dimension.optional(),
  text: text.optional(), fontSize: z.number().min(8).max(144).optional(), points: points.optional(),
});

export const operationInput = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("add"), element: elementInput }),
  z.strictObject({ op: z.literal("update"), id: elementId, changes: changesInput }),
  z.strictObject({ op: z.literal("remove"), id: elementId }),
]);

type ElementInput = z.infer<typeof elementInput>;
type Operation = z.infer<typeof operationInput>;
type Changes = z.infer<typeof changesInput>;

function fail(message: string): never {
  throw new DrawingProblem("invalid_edit", message);
}

function nonce() {
  return randomInt(1, 2 ** 31);
}

function lineGeometry(path: z.infer<typeof points>) {
  const [x, y] = path[0];
  const xs = path.map(([px]) => px);
  const ys = path.map(([, py]) => py);
  const width = Math.max(...xs) - Math.min(...xs);
  const height = Math.max(...ys) - Math.min(...ys);
  if (width === 0 && height === 0) fail("Line and arrow points must span a nonzero distance.");
  return { x, y, width, height, points: path.map(([px, py]) => [px - x, py - y]) as ExcalidrawLinearElement["points"] };
}

function textGeometry(input: string, fontSize: number, lineHeight: number) {
  const text = input.replace(/\r\n?/g, "\n").replace(/\t/g, "        ");
  const lines = text.split("\n");
  const longest = Math.max(...lines.map((line) => Array.from(line).length));
  return { text, originalText: text, width: longest * fontSize * 0.6, height: lines.length * fontSize * lineHeight };
}

function makeElement(input: ElementInput): ExcalidrawElement {
  const common = {
    id: input.id, seed: nonce(), version: 1, versionNonce: nonce(), index: null,
    isDeleted: false, updated: Date.now(), groupIds: [], frameId: null, boundElements: null,
    link: null, locked: false, angle: 0 as ExcalidrawElement["angle"], roundness: null,
    strokeColor: input.strokeColor ?? "#1e1e1e", backgroundColor: input.backgroundColor ?? "transparent",
    strokeWidth: input.strokeWidth ?? 2, strokeStyle: input.strokeStyle ?? "solid" as const,
    fillStyle: input.fillStyle ?? "solid" as const, roughness: input.roughness ?? 1, opacity: input.opacity ?? 100,
  };
  if (input.type === "text") {
    const fontSize = input.fontSize ?? 20;
    // Cascadia is the editor's bundled monospaced font.
    const lineHeight = 1.2 as ExcalidrawTextElement["lineHeight"];
    return {
      ...common, ...textGeometry(input.text, fontSize, lineHeight), type: "text", x: input.x, y: input.y,
      fontFamily: 3, fontSize, lineHeight, textAlign: "left", verticalAlign: "top", autoResize: true, containerId: null,
    };
  }
  if ("points" in input) {
    return {
      ...common, ...lineGeometry(input.points), type: input.type, lastCommittedPoint: null,
      startBinding: null, endBinding: null, startArrowhead: null,
      endArrowhead: input.type === "arrow" ? "arrow" : null, elbowed: false,
    };
  }
  const { type, x, y, width, height } = input;
  return { ...common, type, x, y, width, height };
}

function touch(element: ExcalidrawElement): ExcalidrawElement {
  return { ...element, version: (element.version ?? 0) + 1, versionNonce: nonce(), updated: Date.now() };
}

function patchElement(element: ExcalidrawElement, changes: Changes, hasChildren: boolean) {
  const { text, fontSize, points, ...rest } = changes;
  if (Object.keys(changes).length === 0) fail("Supply at least one property to update.");
  if (element.locked) fail(`Element ${element.id} is locked in the editor.`);
  if ((text !== undefined || fontSize !== undefined) && element.type !== "text") fail("Text properties require a text element.");
  const linear = element.type === "arrow" || element.type === "line";
  const boundLine = linear && (element.startBinding || element.endBinding || (element.type === "arrow" && "elbowed" in element && element.elbowed));
  if (points && (!linear || boundLine || element.angle || rest.x !== undefined || rest.y !== undefined)) {
    fail("Changing points requires an unbound, unrotated line or arrow. Supply absolute points without x or y.");
  }
  const resized = rest.width !== undefined || rest.height !== undefined;
  if (resized && (linear || element.type === "text" || element.type === "freedraw" || (element.type === "image" && element.crop))) {
    fail("Resize this element in the editor, or use points for an unbound line and fontSize for text.");
  }
  if ((resized || points || rest.x !== undefined || rest.y !== undefined) &&
    (boundLine || element.boundElements?.length || hasChildren || (element.type === "text" && element.containerId))) {
    fail("Geometry changes on linked elements require the editor to preserve their bindings.");
  }

  if (element.type === "text" && (text !== undefined || fontSize !== undefined)) {
    const size = fontSize ?? element.fontSize;
    const geometry = textGeometry(text ?? element.originalText ?? element.text, size, element.lineHeight || 1.25);
    return touch({ ...element, ...rest, ...geometry, width: element.autoResize === false ? element.width : geometry.width, fontSize: size });
  }
  return touch({ ...element, ...rest, ...(points && lineGeometry(points)) });
}

export function editScene(scene: Scene, operations: readonly Operation[]): Scene {
  const elements = new Map(scene.elements.map((element) => [element.id, element]));
  const removed = new Set<string>();
  const parents = new Set(scene.elements.filter((element) => !element.isDeleted).map((element) => element.frameId));
  for (const op of operations) {
    if (op.op === "add") {
      if (elements.has(op.element.id) || removed.has(op.element.id)) fail(`Element ${op.element.id} already exists in this scene or batch.`);
      elements.set(op.element.id, makeElement(op.element));
      continue;
    }
    const element = elements.get(op.id);
    if (!element || element.isDeleted) fail(`Element ${op.id} was not found.`);
    if (op.op === "update") {
      elements.set(op.id, patchElement(element, op.changes, parents.has(op.id)));
    } else {
      if (element.locked) fail(`Element ${op.id} is locked in the editor.`);
      elements.delete(op.id);
      removed.add(op.id);
    }
  }

  return { ...scene, elements: [...elements.values()].map((element) => {
    if (removed.size === 0) return element;
    const boundElements = element.boundElements?.filter(({ id }) => !removed.has(id));
    const lostFrame = element.frameId && removed.has(element.frameId);
    const lostLabelContainer = element.type === "text" && element.containerId && removed.has(element.containerId);
    const linear = element.type === "arrow" || element.type === "line";
    const lostStart = linear && element.startBinding && removed.has(element.startBinding.elementId);
    const lostEnd = linear && element.endBinding && removed.has(element.endBinding.elementId);
    if (!lostFrame && !lostLabelContainer && !lostStart && !lostEnd && boundElements?.length === element.boundElements?.length) return element;
    return touch({ ...element, ...(lostFrame && { frameId: null }), ...(lostLabelContainer && { containerId: null }),
      ...(lostStart && { startBinding: null }), ...(lostEnd && { endBinding: null }), ...(boundElements && { boundElements }) });
  }) };
}
