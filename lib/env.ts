/**
 * Server-only environment access.
 *
 * Every value here is a secret or a server setting. Nothing in this file may be
 * imported from a client component, or it would end up in the browser bundle.
 */
import "server-only";

function required(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing environment variable ${name}. Copy .env.example to .env.local and fill it in.`,
    );
  }
  return value;
}

export const serverEnv = {
  get supabaseUrl() {
    return required("SUPABASE_URL");
  },
  get supabaseServiceRoleKey() {
    return required("SUPABASE_SERVICE_ROLE_KEY");
  },
  get drawingAccessSecret() {
    return required("DRAWING_ACCESS_SECRET");
  },
};
