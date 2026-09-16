/**
 * Copies Excalidraw's hand-drawn fonts out of node_modules into
 * public/excalidraw-assets so the app serves them itself.
 *
 * Excalidraw loads these fonts at runtime from `window.EXCALIDRAW_ASSET_PATH`
 * (set in app/layout.tsx). Without this copy it falls back to a public CDN,
 * which we do not want an embedded canvas to depend on.
 *
 * Runs automatically on `npm install` (postinstall), including on Vercel.
 */
import { cp, mkdir, access } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const from = resolve(root, "node_modules/@excalidraw/excalidraw/dist/prod/fonts");
const to = resolve(root, "public/excalidraw-assets/fonts");

try {
  await access(from);
} catch {
  console.warn("[enrikdraw] Excalidraw fonts not found at", from, "- skipping copy.");
  process.exit(0);
}

await mkdir(dirname(to), { recursive: true });
await cp(from, to, { recursive: true });
console.log("[enrikdraw] Copied Excalidraw fonts to public/excalidraw-assets/fonts");
