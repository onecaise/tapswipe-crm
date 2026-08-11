import { createClient } from "@/lib/supabase/client";

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
 * Invokes an Edge Function and returns the server's own error message.
 *
 * supabase-js reports any non-2xx as a FunctionsHttpError whose `.message` is a
 * generic "Edge Function returned a non-2xx status code" — the actual reason sits
 * unread in the response body. Without this unwrapping, "A user with that email
 * already exists" reaches the admin as that generic string, which is the
 * difference between a fixable message and a mysterious one.
 */
export async function callAdminFunction<T>(
  name: string,
  body: Record<string, unknown>,
): Promise<{ data: T | null; error: string | null }> {
  const supabase = createClient();
  const { data, error } = await supabase.functions.invoke(name, { body });

  if (!error) {
    return { data: data as T, error: null };
  }

  const response = (error as { context?: Response }).context;
  if (response && typeof response.json === "function") {
    try {
      const payload = (await response.json()) as { error?: unknown };
      if (payload?.error) {
        return { data: null, error: String(payload.error) };
      }
    } catch {
      // Body wasn't JSON (a 500 page, say) — fall back to the generic message.
    }
  }

  return { data: null, error: error.message };
}
