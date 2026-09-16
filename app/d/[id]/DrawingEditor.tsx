"use client";

import dynamic from "next/dynamic";
import { useCallback, useState } from "react";
import type { SaveStatus } from "./types";

/**
 * Excalidraw reads `window` while it loads, so it can never be rendered on the
 * server. `ssr: false` keeps it out of the server build entirely.
 */
const ExcalidrawCanvas = dynamic(() => import("./ExcalidrawCanvas"), {
  ssr: false,
  loading: () => <div className="centred">Loading the canvas…</div>,
});

const STATUS_LABEL: Record<SaveStatus, string> = {
  idle: "Saved",
  saving: "Saving…",
  saved: "Saved",
  error: "Save failed",
};

type Props = {
  id: string;
  title: string;
  token: string;
  initialScene: string | null;
  embed: boolean;
};

export default function DrawingEditor({ id, title, token, initialScene, embed }: Props) {
  const [status, setStatus] = useState<SaveStatus>("idle");
  const [copied, setCopied] = useState(false);

  const onCopyEmbed = useCallback(async () => {
    const url = `${window.location.origin}${window.location.pathname}?token=${encodeURIComponent(
      token,
    )}&embed=1`;
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      window.prompt("Copy this URL into a Notion /embed block:", url);
    }
  }, [token]);

  return (
    <div className={embed ? "editor embed" : "editor"}>
      {/* In embed mode there is no EnrikDraw chrome at all: the iframe is all canvas. */}
      {!embed && (
        <header className="editor-header">
          <span className="drawing-title">{title}</span>
          <span className="spacer" />
          <span className={status === "error" ? "status error" : "status"}>
            {STATUS_LABEL[status]}
          </span>
          <button type="button" onClick={() => void onCopyEmbed()}>
            {copied ? "Copied" : "Copy Embed URL"}
          </button>
          <a href="/manage">Manage</a>
        </header>
      )}

      <div className="canvas-area">
        <div className="canvas-inner">
          {/* key={id} guarantees a fresh canvas per document. */}
          <ExcalidrawCanvas
            key={id}
            id={id}
            title={title}
            token={token}
            initialScene={initialScene}
            onStatusChange={setStatus}
          />
        </div>
      </div>
    </div>
  );
}
