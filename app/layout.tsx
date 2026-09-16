import type { Metadata } from "next";
import "@excalidraw/excalidraw/index.css";
import "./globals.css";

export const metadata: Metadata = {
  title: "EnrikDraw",
  description: "Cloud-saved Excalidraw drawings.",
  robots: { index: false, follow: false },
};

/**
 * Tells Excalidraw to load its hand-drawn fonts from this app rather than from
 * a public CDN. scripts/copy-excalidraw-assets.mjs puts them in place on
 * install. It has to run before the Excalidraw bundle does, so it is inline.
 */
const assetPathScript = `window.EXCALIDRAW_ASSET_PATH = "/excalidraw-assets/";`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <head>
        <script dangerouslySetInnerHTML={{ __html: assetPathScript }} />
      </head>
      <body>{children}</body>
    </html>
  );
}
