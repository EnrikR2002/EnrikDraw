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
import { saveScene } from "@/lib/client-api";
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
  const unmounted = useRef(false);
  const [api, setApi] = useState<ExcalidrawImperativeAPI | null>(null);

  const setStatus = useCallback(
    (status: SaveStatus) => {
      if (!unmounted.current) onStatusChange(status);
    },
    [onStatusChange],
  );

  const save = useCallback(async (): Promise<void> => {
    // Only ever one save in the air. This is what stops an older save from
    // landing after, and overwriting, a newer one.
    if (saving.current) return;
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
          await saveScene(id, token, json);
        } catch (error) {
          // No token and no scene content in the log, just what went wrong.
          console.error("[enrikdraw] autosave failed for drawing", id, error);
          setStatus("error");
          // Leave the canvas untouched. The next edit starts another attempt.
          break;
        }

        savedHash.current = hash;
        // A debounce is already queued, so let that fire instead of writing
        // again right now.
        if (timer.current !== null) break;
      }
    } finally {
      saving.current = false;
    }
  }, [id, token, setStatus]);

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

      setStatus("saving");
      scheduleSave();
    },
    [scheduleSave, setStatus],
  );

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
    <Excalidraw
      initialData={initialData}
      onChange={onChange}
      excalidrawAPI={setApi}
      // Used as the file name by Excalidraw's own export and save menus.
      name={title}
    />
  );
}
