import "server-only";
import { readFile } from "node:fs/promises";
import path from "node:path";
import type { Browser, LaunchOptions } from "playwright-core";
import type { PreviewImage } from "../render/preview";
import { DrawingProblem, type Scene } from "./scene";

const rendererOrigin = "https://preview.enrikdraw.invalid";
const rendererScript = "build/preview/renderer.js";
const fontRoot = "node_modules/@excalidraw/excalidraw/dist/prod/fonts";
const previewDocument = '<!doctype html><meta charset="utf-8"><script src="/renderer.js"></script>';
let running = 0;
let bundledExecutable: Promise<string> | undefined;

function browserEnv() {
  // The renderer only needs OS paths. It must not inherit server credentials.
  return Object.fromEntries(["PATH", "Path", "SystemRoot", "WINDIR", "TEMP", "TMP", "TMPDIR",
    "USERPROFILE", "LOCALAPPDATA", "HOME", "LD_LIBRARY_PATH", "FONTCONFIG_PATH"].flatMap((key) =>
    process.env[key] ? [[key, process.env[key]]] : []));
}

async function launchOptions(): Promise<LaunchOptions> {
  const override = process.env.ENRIKDRAW_PREVIEW_BROWSER;
  if (override) return { executablePath: override };
  if (process.platform === "win32") return { channel: "msedge" };
  if (process.platform === "darwin") return { channel: "chrome" };
  const { default: chromium } = await import("@sparticuz/chromium");
  chromium.setGraphicsMode = false;
  bundledExecutable ??= chromium.executablePath().catch((error: unknown) => {
    bundledExecutable = undefined;
    throw error;
  });
  return { executablePath: await bundledExecutable, args: chromium.args };
}

export async function renderPreview(scene: Scene): Promise<PreviewImage> {
  if (running >= 2) throw new DrawingProblem("preview_busy", "The preview renderer is busy. Retry in a moment.");
  running++;
  let browser: Browser | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const [{ chromium }, options, script] = await Promise.all([
      import("playwright-core"), launchOptions(), readFile(rendererScript),
    ]);
    browser = await chromium.launch({ ...options, env: browserEnv(), headless: true, timeout: 12_000 });
    const context = await browser.newContext({ serviceWorkers: "block" });
    // Every browser request is fulfilled locally or blocked. No drawing URL,
    // access token, user cookie or network connection is needed to render.
    await context.route("**/*", async (route) => {
      const { origin, pathname } = new URL(route.request().url());
      if (origin === rendererOrigin && route.request().method() === "GET") {
        if (pathname === "/") return route.fulfill({
          contentType: "text/html",
          headers: {
            "Content-Security-Policy": "default-src 'none'; script-src 'self'; connect-src 'self'; font-src 'self'; img-src data:; style-src 'unsafe-inline'",
          },
          body: previewDocument,
        });
        if (pathname === "/renderer.js") return route.fulfill({ contentType: "application/javascript", body: script });
        if (/^\/fonts\/[\w-]+\/[\w.-]+\.woff2$/.test(pathname)) {
          const body = await readFile(path.join(fontRoot, pathname.slice("/fonts/".length))).catch(() => null);
          if (body) return route.fulfill({ contentType: "font/woff2", body });
        }
      }
      return route.abort();
    });
    const page = await context.newPage();
    await page.goto(rendererOrigin, { waitUntil: "load", timeout: 8_000 });
    return await Promise.race([
      page.evaluate((input) => window.renderEnrikDraw(input), scene),
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("Preview timed out")), 10_000); }),
    ]);
  } catch {
    console.error("[enrikdraw] preview renderer failed");
    throw new DrawingProblem("preview_failed", "EnrikDraw could not render this preview. Try again, or inspect the scene geometry instead.");
  } finally {
    clearTimeout(timer);
    await browser?.close().catch(() => undefined);
    running--;
  }
}
