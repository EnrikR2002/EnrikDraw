"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Excalidraw, hashElementsVersion, restore, serializeAsJSON } from "@excalidraw/excalidraw";
import type {
  AppState,
  BinaryFiles,
  ExcalidrawInitialDataState,
} from "@excalidraw/excalidraw/types";
import type { ExcalidrawImperativeAPI } from "@excalidraw/excalidraw/types";
import type { OrderedExcalidrawElement } from "@excalidraw/excalidraw/element/types";
import { fetchRevision, saveScene, StaleDrawing } from "@/lib/client-api";
import type { SaveStatus } from "./types";

/**
 * How long to wait after the last edit before writing to the database.
 * Long enough that one stroke is one save, short enough to feel instant.
 */
const DEBOUNCE_MS = 900;

type Snapshot = {
  elements: readonly OrderedExcalidrawElement[];
  appState: AppState;
  files: BinaryFiles;
};

type Props = {
  id: string;
  title: string;
  token: string;
  initialScene: string | null;
  initialRevision: string;
  onStatusChange: (status: SaveStatus) => void;
};

function buildInitialData(scene: string | null): ExcalidrawInitialDataState {
  if (!scene) {
    // A brand new drawing. restore() fills in every default for us.
    return { ...restore(null, null, null), scrollToContent: true };
  }

  // Throws on damaged text, which the caller turns into an error screen.
  const parsed = JSON.parse(scene) as ExcalidrawInitialDataState;

  // restore() drops transient state and repairs anything written by an older
  // Excalidraw version, so nothing broken reaches the canvas.
  return { ...restore(parsed, null, null), scrollToContent: true };
}

export default function ExcalidrawCanvas({
  id,
  title,
  token,
  initialScene,
  initialRevision,
  onStatusChange,
}: Props) {
  // Computed once per document. A different drawing is a different component
  // instance, because DrawingEditor passes key={id}.
  const initialData = useMemo(() => {
    try {
      return buildInitialData(initialScene);
    } catch (error) {
      console.error("[enrikdraw] could not read the saved scene for", id, error);
      return null;
    }
  }, [id, initialScene]);

  const initialHash = useMemo(
    () => (initialData ? hashElementsVersion(initialData.elements ?? []) : null),
    [initialData],
  );

  /** The most recent scene Excalidraw has told us about. */
  const latest = useRef<Snapshot | null>(null);
  /** Element hash of what the database already holds. */
  const savedHash = useRef<number | null>(initialHash);
  /** Element hash of the last onChange we looked at. */
  const seenHash = useRef<number | null>(initialHash);
  const timer = useRef<number | null>(null);
  const saving = useRef(false);
  const revision = useRef(initialRevision);
  const stale = useRef(false);
  const reloading = useRef(false);
  const unmounted = useRef(false);
  const [remoteChange, setRemoteChange] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [confirmDiscard, setConfirmDiscard] = useState(false);
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);

  const setStatus = useCallback(
    (status: SaveStatus) => {
      if (!unmounted.current) onStatusChange(status);
    },
    [onStatusChange],
  );

  const markStale = useCallback(() => {
    if (unmounted.current) return;
    stale.current = true;
    setRemoteChange(true);
    setStatus("stale");
  }, [setStatus]);

  const hasDraft = useCallback(() => seenHash.current !== savedHash.current, []);

  const save = useCallback(async (): Promise<void> => {
    // Only ever one save in the air. This is what stops an older save from
    // landing after, and overwriting, a newer one.
    if (saving.current || stale.current) return;
    saving.current = true;

    try {
      // Loop, so a change that arrives while a request is in flight still gets
      // written even though its debounce timer has already fired.
      for (;;) {
        const snapshot = latest.current;
        if (!snapshot) break;

        const hash = hashElementsVersion(snapshot.elements);
        if (hash === savedHash.current) {
          setStatus("saved");
          break;
        }

        setStatus("saving");
        // "local" writes exactly the .excalidraw file format, so the stored
        // text can be downloaded and opened anywhere.
        const json = serializeAsJSON(
          snapshot.elements,
          snapshot.appState,
          snapshot.files,
          "local",
        );

        try {
          revision.current = await saveScene(id, token, json, revision.current);
        } catch (error) {
          if (error instanceof StaleDrawing) {
            markStale();
            break;
          }
          // No token and no scene content in the log, just what went wrong.
          console.error("[enrikdraw] autosave failed for drawing", id, error);
          setStatus("error");
          // Leave the canvas untouched. The next edit starts another attempt.
          break;
        }

        savedHash.current = hash;
        if (!unmounted.current) setDirty(hasDraft());
        // A debounce is already queued, so let that fire instead of writing
        // again right now.
        if (timer.current !== null) break;
      }
    } finally {
      saving.current = false;
    }
  }, [id, token, setStatus, markStale, hasDraft]);

  const scheduleSave = useCallback(() => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      timer.current = null;
      void save();
    }, DEBOUNCE_MS);
  }, [save]);

  const onChange = useCallback(
    (elements: readonly OrderedExcalidrawElement[], appState: AppState, files: BinaryFiles) => {
      latest.current = { elements, appState, files };

      // Excalidraw also fires onChange for panning, zooming and selecting.
      // Hashing the elements keeps those from causing a pointless save.
      const hash = hashElementsVersion(elements);
      if (hash === seenHash.current) return;
      seenHash.current = hash;
      setDirty(hasDraft());

      if (stale.current) {
        setConfirmDiscard(false);
        return;
      }
      setStatus("saving");
      scheduleSave();
    },
    [scheduleSave, setStatus, hasDraft],
  );

  useEffect(() => {
    const controller = new AbortController();
    let checking = false;
    const check = async () => {
      if (checking || saving.current || stale.current || document.hidden) return;
      checking = true;
      const previous = revision.current;
      try {
        const current = await fetchRevision(id, token, controller.signal);
        if (!controller.signal.aborted && !saving.current && revision.current === previous && current !== previous) {
          markStale();
        }
      } catch {
        // A failed poll leaves autosave responsible for reporting connection errors.
      } finally {
        checking = false;
      }
    };
    const interval = window.setInterval(() => void check(), 15_000);
    window.addEventListener("focus", check);
    document.addEventListener("visibilitychange", check);
    return () => {
      controller.abort();
      window.clearInterval(interval);
      window.removeEventListener("focus", check);
      document.removeEventListener("visibilitychange", check);
    };
  }, [id, token, markStale]);

  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => {
      if (reloading.current || !hasDraft()) return;
      event.preventDefault();
      event.returnValue = true;
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty, hasDraft]);

  function downloadDraft() {
    const snapshot = latest.current;
    if (!snapshot) return;
    const json = serializeAsJSON(snapshot.elements, snapshot.appState, snapshot.files, "local");
    const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `${title} (local draft).excalidraw`;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  function reloadDrawing() {
    if (hasDraft() && !confirmDiscard) {
      setConfirmDiscard(true);
      return;
    }
    reloading.current = true;
    window.location.reload();
  }

  // Frame the drawing once the canvas knows its real size.
  //
  // initialData.scrollToContent runs while Excalidraw is still measuring
  // itself, which lands in the wrong place inside a short Notion block. This
  // second pass zooms out far enough to fit, and never zooms in past 100%.
  useEffect(() => {
    if (!api) return;
    const frame = window.requestAnimationFrame(() => {
      const elements = api.getSceneElements();
      if (elements.length === 0) return;
      api.scrollToContent(elements, { fitToContent: true, maxZoom: 1 });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [api]);

  // Write straight away when the tab is hidden or closed, rather than losing
  // whatever the debounce is still holding.
  useEffect(() => {
    const flush = () => {
      if (timer.current !== null) {
        window.clearTimeout(timer.current);
        timer.current = null;
      }
      void save();
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };

    document.addEventListener("visibilitychange", onVisibility);
    window.addEventListener("pagehide", flush);
    return () => {
      document.removeEventListener("visibilitychange", onVisibility);
      window.removeEventListener("pagehide", flush);
    };
  }, [save]);

  useEffect(() => {
    const pending = timer;
    unmounted.current = false;
    return () => {
      unmounted.current = true;
      if (pending.current !== null) window.clearTimeout(pending.current);
    };
  }, []);

  if (!initialData) {
    return (
      <div className="centred">
        <div>
          <h1>This drawing could not be opened</h1>
          <p>
            The saved scene is damaged, so the canvas has not been started. Nothing has been
            overwritten.
          </p>
        </div>
      </div>
    );
  }

  return (
    <>
      {remoteChange && (
        <div className="drawing-conflict">
          <span role="status">{dirty ? "Drawing changed elsewhere. Your draft is unsaved." : "Drawing changed elsewhere."}</span>
          {dirty && <button type="button" onClick={downloadDraft}>Download draft</button>}
          <button type="button" onClick={reloadDrawing}>
            {dirty && confirmDiscard ? "Discard draft and reload" : "Reload drawing"}
          </button>
          {dirty && confirmDiscard && (
            <button type="button" onClick={() => setConfirmDiscard(false)}>Cancel</button>
          )}
        </div>
      )}
      <Excalidraw
        initialData={initialData}
        onChange={onChange}
        excalidrawAPI={setApi}
        // Used as the file name by Excalidraw's own export and save menus.
        name={title}
      />
    </>
  );
}
