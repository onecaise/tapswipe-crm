/**
 * The one place that turns a supabase-js function error into something a person
 * can act on.
 *
 * `supabase.functions.invoke()` reports every non-2xx as a `FunctionsHttpError`
 * whose `.message` is the fixed string "Edge Function returned a non-2xx status
 * code" — the function's own `{ error: "..." }` body sits unread on
 * `error.context`, which is the raw `Response`. Show `.message` and a rep whose
 * account was deactivated, a rep who aimed at a record that isn't theirs, and a
 * genuine server fault all read the same sentence, and none of them can tell
 * which happened.
 *
 * Three call sites grew their own copy of this unwrapping before it was
 * extracted (lib/admin-users.ts, components/payout-export-button.tsx, and
 * neither of the two document components — which is how the document panel
 * shipped showing that generic string for every failure). It lives here so the
 * fourth call site doesn't have to rediscover it.
 */

/** Reads the function's own `{ error }` message off a failed invoke. */
export async function edgeFunctionErrorMessage(
  error: unknown,
  fallback = "Something went wrong.",
): Promise<string> {
  const response = (error as { context?: Response } | null)?.context;

  if (response && typeof response.json === "function") {
    try {
      const payload = (await response.json()) as { error?: unknown };
      if (payload?.error) return String(payload.error);
    } catch {
      // Not JSON — a 502 from the runtime restarting, say, or an HTML error
      // page. The generic message below is all there is.
    }
  }

  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === "string" && message.length > 0 ? message : fallback;
}

/**
 * Invokes an Edge Function, returning the server's own message on failure.
 *
 * Also treats a 2xx with no body as a failure: `invoke` resolves `{ data: null,
 * error: null }` in that case, and every caller here needs a field off `data`,
 * so letting it through only moves the crash one line down into a property read
 * on null.
 */
export async function invokeEdgeFunction<T>(
  supabase: {
    functions: {
      invoke: (
        name: string,
        options: { body: Record<string, unknown> },
      ) => Promise<{ data: unknown; error: unknown }>;
    };
  },
  name: string,
  body: Record<string, unknown>,
  fallback = "Something went wrong.",
): Promise<{ data: T | null; error: string | null }> {
  const { data, error } = await supabase.functions.invoke(name, { body });

  if (error) {
    return { data: null, error: await edgeFunctionErrorMessage(error, fallback) };
  }
  if (data === null || data === undefined) {
    return { data: null, error: fallback };
  }

  return { data: data as T, error: null };
}
