import { build } from "esbuild";
import { fileURLToPath } from "node:url";

await build({
  absWorkingDir: fileURLToPath(new URL("../", import.meta.url)),
  entryPoints: ["render/preview.ts"],
  outfile: "build/preview/renderer.js",
  bundle: true,
  platform: "browser",
  target: "chrome130",
  minify: true,
  banner: { js: 'window.EXCALIDRAW_ASSET_PATH = "/";' },
  define: { "process.env.NODE_ENV": '"production"' },
});
