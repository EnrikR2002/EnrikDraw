/**
 * Browser-side calls to this app's own API routes.
 *
 * `credentials: "same-origin"` makes the browser attach the cached HTTP Basic
 * credentials it collected when it loaded /manage.
 */

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

export async function fetchRevision(id: string, token: string, signal: AbortSignal) {
  const response = await fetch(`${drawingApi(id, token)}&metadata=1`, { cache: "no-store", signal });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Revision check failed: HTTP ${response.status}`);
  const { drawing } = await response.json() as { drawing: DrawingSummary };
  return drawing.revision;
}

export async function saveScene(id: string, token: string, scene: string, revision: string) {
  const body = JSON.stringify({ scene, revision });
  const response = await fetch(drawingApi(id, token), {
    method: "PUT",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body,
    keepalive: body.length < 60_000 && new Blob([body]).size < 60_000,
  });

  if ([404, 409, 428].includes(response.status)) throw new StaleDrawing();
  if (!response.ok) {
    // The token is in the URL, so never include the URL in the message.
    throw new Error(`Save failed: HTTP ${response.status}`);
  }
  return (await response.json() as { revision: string }).revision;
}
