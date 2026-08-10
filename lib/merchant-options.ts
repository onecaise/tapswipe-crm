import { createClient } from "@/lib/supabase/server";

export type MerchantOption = { id: number; dba: string };

/**
 * The merchants the caller may attach something to, for a form's dropdown.
 *
 * Server-side on purpose, so RLS does the scoping: an agent's own book,
 * everything for an admin. The resolved list is passed down as a prop, which
 * means the browser cannot widen it and the form component stays a pure form
 * with no query of its own.
 *
 * Lives here rather than in lib/support-tickets.ts because that module is
 * imported by a "use client" component, and pulling lib/supabase/server into it
 * would drag server-only code into the client bundle.
 */
export async function merchantOptions(): Promise<MerchantOption[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("merchants")
    .select("id, dba")
    .order("dba");
  return (data ?? []) as MerchantOption[];
}
