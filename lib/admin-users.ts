import { createClient } from "@/lib/supabase/client";
import { invokeEdgeFunction } from "@/lib/edge-functions";

/**
 * Client-side plumbing for the three admin Edge Functions.
 *
 * The functions themselves are the security boundary — each verifies the caller
 * is an active admin server-side before doing anything. Nothing here is a check;
 * the UI only hides what a non-admin cannot use anyway, which master plan §8
 * calls a UX nicety and not a boundary.
 */

export type CreatedUser = {
  user_id: string;
  email: string;
  /** Shown once. Never persisted, here or anywhere. */
  temporary_password: string;
  auditWriteFailed?: boolean;
};

export type ResetPassword = {
  user_id: string;
  temporary_password: string;
  forcedChangeFlagFailed?: boolean;
  auditWriteFailed?: boolean;
};

/**
 * Invokes one of the admin Edge Functions and returns the server's own error
 * message.
 *
 * The unwrapping this used to do inline now lives in lib/edge-functions.ts. It
 * moved because the document panel needed exactly the same thing and shipped
 * without it — reporting "Edge Function returned a non-2xx status code" for a
 * deactivated account, a record that wasn't the caller's, and a real fault
 * alike. Kept as a named wrapper so the admin screens still read as calling one
 * thing.
 */
export async function callAdminFunction<T>(
  name: string,
  body: Record<string, unknown>,
): Promise<{ data: T | null; error: string | null }> {
  return invokeEdgeFunction<T>(
    createClient(),
    name,
    body,
    "Edge Function returned a non-2xx status code",
  );
}
