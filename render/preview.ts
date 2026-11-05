import { exportToCanvas, restore } from "@excalidraw/excalidraw";
import type { AppState, BinaryFiles } from "@excalidraw/excalidraw/types";
import type { Scene } from "../lib/scene";

export type PreviewImage = { png: string; width: number; height: number };
const MAX_PNG_BASE64 = 640_000;

declare global {
  interface Window {
    renderEnrikDraw: (scene: Scene) => Promise<PreviewImage>;
  }
}

window.renderEnrikDraw = async (scene) => {
  const background = scene.appState?.viewBackgroundColor;
  const appState: Partial<AppState> = {
    viewBackgroundColor: typeof background === "string" && CSS.supports("color", background) && background !== "transparent"
      ? background : "#ffffff",
    exportBackground: true,
    exportWithDarkMode: false,
  };
  const restored = restore({ elements: scene.elements, appState, files: scene.files as BinaryFiles }, null, null);
  let canvas = await exportToCanvas({
    elements: restored.elements.filter((element) => !element.isDeleted),
    appState,
    files: restored.files,
    exportPadding: 20,
    maxWidthOrHeight: 1440,
  });
  for (;;) {
    const png = canvas.toDataURL("image/png").slice("data:image/png;base64,".length);
    if (png && png.length <= MAX_PNG_BASE64) return { png, width: canvas.width, height: canvas.height };
    if (!png || Math.max(canvas.width, canvas.height) <= 360) throw new Error("Preview is outside the image budget");
    const reduced = document.createElement("canvas");
    reduced.width = Math.max(1, Math.floor(canvas.width * 0.75));
    reduced.height = Math.max(1, Math.floor(canvas.height * 0.75));
    reduced.getContext("2d")!.drawImage(canvas, 0, 0, reduced.width, reduced.height);
    canvas = reduced;
  }
};
