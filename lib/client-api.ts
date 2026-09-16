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

export function renameDrawing(id: string, title: string) {
  return call<{ drawing: { id: string; title: string; updated_at: string } }>(
    `/api/manage/drawings/${id}`,
    { method: "PATCH", body: JSON.stringify({ title }) },
  );
}

export function deleteDrawing(id: string) {
  return call<{ ok: true }>(`/api/manage/drawings/${id}`, { method: "DELETE" });
}

/** Saves a scene. Returns nothing useful; it throws when the save failed. */
export async function saveScene(id: string, token: string, scene: string): Promise<void> {
  const response = await fetch(`/api/drawings/${id}?token=${encodeURIComponent(token)}`, {
    method: "PUT",
    cache: "no-store",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ scene }),
  });

  if (!response.ok) {
    // The token is in the URL, so never include the URL in the message.
    throw new Error(`Save failed: HTTP ${response.status}`);
  }
}
