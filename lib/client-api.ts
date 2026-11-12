/**
 * Browser-side calls to this app's own API routes.
 *
 * `credentials: "same-origin"` makes the browser attach the cached HTTP Basic
 * credentials it collected when it loaded /manage.
 */

import { MAX_SAVE_REQUEST_BYTES, MAX_SCENE_BYTES, SAVE_PART_BYTES } from "./scene";

type DrawingSummary = {
  id: string;
  title: string;
  created_at: string;
  updated_at: string;
  revision: string;
  editorUrl: string;
  embedUrl: string;
};

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, {
    ...init,
    credentials: "same-origin",
    cache: "no-store",
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });

  if (response.status === 401) {
    throw new Error("Sign in again: reload this page and re-enter your username and password.");
  }

  let payload: { error?: string } | null = null;
  try {
    payload = (await response.json()) as { error?: string };
  } catch {
    payload = null;
  }

  if (!response.ok) {
    throw new Error(payload?.error ?? `Request failed with status ${response.status}.`);
  }
  return payload as T;
}

export function createDrawing(title: string) {
  return call<{ drawing: DrawingSummary }>("/api/manage/drawings", {
    method: "POST",
    body: JSON.stringify({ title }),
  });
}

export function renameDrawing(id: string, revision: string, title: string) {
  return call<{ drawing: { id: string; title: string; updated_at: string } }>(
    `/api/manage/drawings/${id}`,
    { method: "PATCH", headers: { "If-Match": `"${revision}"` }, body: JSON.stringify({ title }) },
  );
}

export function deleteDrawing(id: string, revision: string) {
  return call<{ ok: true }>(`/api/manage/drawings/${id}`, {
    method: "DELETE",
    headers: { "If-Match": `"${revision}"` },
  });
}

function drawingApi(id: string, token: string) {
  return `/api/drawings/${id}?token=${encodeURIComponent(token)}`;
}

export class StaleDrawing extends Error {}
export class DrawingTooLarge extends Error {}

function newUploadId() {
  // getRandomValues is also available when an iframe's ancestors make it an
  // insecure context, where randomUUID is unavailable.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function fetchRevision(id: string, token: string, signal: AbortSignal) {
  const response = await fetch(`${drawingApi(id, token)}&metadata=1`, { cache: "no-store", signal });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Revision check failed: HTTP ${response.status}`);
  const { drawing } = await response.json() as { drawing: DrawingSummary };
  return drawing.revision;
}

export async function saveScene(id: string, token: string, scene: string, revision: string) {
  if (scene.length > MAX_SCENE_BYTES) throw new DrawingTooLarge();
  const url = drawingApi(id, token);
  if (scene.length < MAX_SAVE_REQUEST_BYTES) {
    const body = new Blob([JSON.stringify({ scene, revision })]);
    if (body.size <= MAX_SAVE_REQUEST_BYTES) {
      const response = await putSave(url, body, "application/json");
      return (await response.json() as { revision: string }).revision;
    }
  }

  const file = new Blob([scene]);
  if (file.size > MAX_SCENE_BYTES) throw new DrawingTooLarge();
  const uploadId = newUploadId();
  const decoder = new TextDecoder("utf-8", { ignoreBOM: true });
  const partCount = Math.ceil(file.size / SAVE_PART_BYTES);
  for (let part = 0; part < partCount; part++) {
    const bytes = await file.slice(part * SAVE_PART_BYTES, (part + 1) * SAVE_PART_BYTES).arrayBuffer();
    const text = decoder.decode(bytes, { stream: part + 1 < partCount });
    const query = new URLSearchParams({ uploadId, part: String(part), revision });
    await putSave(`${url}&${query}`, new Blob([text]), "text/plain;charset=UTF-8");
  }
  const commit = new Blob([JSON.stringify({ revision, uploadId, partCount })]);
  const response = await putSave(url, commit, "application/json");
  return (await response.json() as { revision: string }).revision;
}

async function putSave(url: string, body: Blob, contentType: string) {
  const response = await fetch(url, {
    method: "PUT",
    cache: "no-store",
    headers: { "Content-Type": contentType },
    body,
    keepalive: body.size < 60_000,
  });

  if (response.status === 413) throw new DrawingTooLarge();
  if ([404, 409, 428].includes(response.status)) throw new StaleDrawing();
  if (!response.ok) {
    // The token is in the URL, so never include the URL in the message.
    throw new Error(`Save failed: HTTP ${response.status}`);
  }
  return response;
}
