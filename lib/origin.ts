/**
 * Works out the public origin of this deployment, e.g. https://foo.vercel.app.
 *
 * NEXT_PUBLIC_APP_URL wins when set. Otherwise we read the incoming request
 * headers, which covers local development and preview deployments.
 */
import "server-only";

export function originFromHeaders(headers: Headers): string {
  const configured = process.env.NEXT_PUBLIC_APP_URL;
  if (configured) return configured.replace(/\/+$/, "");

  const host = headers.get("x-forwarded-host") ?? headers.get("host") ?? "localhost:3000";
  const proto = headers.get("x-forwarded-proto") ?? (host.startsWith("localhost") ? "http" : "https");
  return `${proto}://${host}`;
}
