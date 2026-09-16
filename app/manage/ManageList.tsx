"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { createDrawing, deleteDrawing, renameDrawing } from "@/lib/client-api";

export type DrawingItem = {
  id: string;
  title: string;
  /** Already formatted on the server, to keep server and browser in step. */
  updatedAt: string;
  editorUrl: string;
  embedUrl: string;
};

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : "Something went wrong.";
}

export default function ManageList({ drawings }: { drawings: DrawingItem[] }) {
  const router = useRouter();
  const [refreshing, startRefresh] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [newTitle, setNewTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);

  /** Asks the server component above to run again and send a fresh list. */
  function refresh() {
    startRefresh(() => router.refresh());
  }

  async function run(work: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await work();
      refresh();
    } catch (err) {
      setError(messageOf(err));
    } finally {
      setBusy(false);
    }
  }

  async function onCreate(event: React.FormEvent) {
    event.preventDefault();
    const title = newTitle.trim();
    if (!title || busy) return;
    await run(async () => {
      await createDrawing(title);
      setNewTitle("");
    });
  }

  async function onRename(drawing: DrawingItem) {
    const title = window.prompt("New title", drawing.title);
    if (title === null || !title.trim()) return;
    await run(() => renameDrawing(drawing.id, title.trim()));
  }

  async function onDelete(drawing: DrawingItem) {
    const confirmed = window.confirm(
      `Delete "${drawing.title}"? This cannot be undone, and any Notion embed of it stops working.`,
    );
    if (!confirmed) return;
    await run(() => deleteDrawing(drawing.id));
  }

  async function onCopyEmbed(drawing: DrawingItem) {
    try {
      await navigator.clipboard.writeText(drawing.embedUrl);
      setCopiedId(drawing.id);
      window.setTimeout(() => setCopiedId(null), 1500);
    } catch {
      // The browser can refuse clipboard access. Show the URL to copy by hand.
      window.prompt("Copy this URL into a Notion /embed block:", drawing.embedUrl);
    }
  }

  return (
    <main className="manage">
      <h1>EnrikDraw</h1>

      <form className="new-row" onSubmit={onCreate}>
        <input
          value={newTitle}
          onChange={(event) => setNewTitle(event.target.value)}
          placeholder="Drawing title"
          aria-label="Drawing title"
        />
        <button type="submit" disabled={busy || refreshing || !newTitle.trim()}>
          + New Drawing
        </button>
      </form>

      {error && <p className="error-banner">{error}</p>}

      {drawings.length === 0 ? (
        <p className="note">No drawings yet. Create one above.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th>Title</th>
              <th>Last updated (UTC)</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {drawings.map((drawing) => (
              <tr key={drawing.id}>
                <td className="title-cell">{drawing.title}</td>
                <td className="stamp">{drawing.updatedAt}</td>
                <td className="actions">
                  <a href={drawing.editorUrl} target="_blank" rel="noreferrer">
                    Open
                  </a>
                  <button type="button" onClick={() => void onCopyEmbed(drawing)}>
                    {copiedId === drawing.id ? "Copied" : "Copy Notion Embed URL"}
                  </button>
                  <button type="button" disabled={busy} onClick={() => void onRename(drawing)}>
                    Rename
                  </button>
                  <button type="button" disabled={busy} onClick={() => void onDelete(drawing)}>
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
