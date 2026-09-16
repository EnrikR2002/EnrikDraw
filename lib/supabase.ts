/**
 * Supabase client using the service-role key.
 *
 * Server-side only. The service-role key bypasses row level security, so it
 * must never reach the browser. All database access goes through the route
 * handlers in app/api.
 */
import "server-only";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { serverEnv } from "./env";

export type DrawingRow = {
  id: string;
  title: string;
  scene: string | null;
  created_at: string;
  updated_at: string;
};

let cached: SupabaseClient | null = null;

export function supabase(): SupabaseClient {
  if (!cached) {
    cached = createClient(serverEnv.supabaseUrl, serverEnv.supabaseServiceRoleKey, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return cached;
}
