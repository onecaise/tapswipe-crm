import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * The owner picker on the admin's merchant form (security fix phase 1
 * follow-up, docs/claude/security-fixes.md).
 *
 * Owning a merchant decides whose book it is in -- who can SEE it. It does
 * not decide who is paid: commit_residual_import_v2 pays the rep named by
 * the processor file's Agent #, and never reads merchants.agent_id. Nor does
 * it touch merchant_rep_shares: a share names its two reps itself.
 */

export type OwnerProfile = {
  id: string;
  full_name: string;
  role: "agent" | "admin";
  is_active: boolean;
  agent_number: string | null;
};

export type OwnerOption = { id: string; label: string };

export const OWNER_PROFILE_COLUMNS = "id, full_name, role, is_active, agent_number";

function withNumber(p: OwnerProfile): string {
  return p.agent_number ? `${p.full_name} (Agent # ${p.agent_number})` : `${p.full_name} (no Agent #)`;
}

/**
 * Every ACTIVE rep, by name, then the admin themself -- an explicit choice,
 * never the default. On edit, a current owner who is neither (a deactivated
 * rep, another admin) is listed too and labelled, so the select can show the
 * value it holds instead of silently changing it on save.
 */
export function ownerOptions(
  profiles: OwnerProfile[],
  selfId: string,
  currentOwnerId?: string,
): OwnerOption[] {
  const reps = profiles
    .filter((p) => p.role === "agent" && p.is_active && p.id !== selfId)
    .sort((a, b) => a.full_name.localeCompare(b.full_name))
    .map((p) => ({ id: p.id, label: withNumber(p) }));

  const options = [...reps];

  const self = profiles.find((p) => p.id === selfId);
  if (self) options.push({ id: self.id, label: `${self.full_name} (you)` });

  if (currentOwnerId && !options.some((o) => o.id === currentOwnerId)) {
    const current = profiles.find((p) => p.id === currentOwnerId);
    if (current) {
      const why = !current.is_active ? "deactivated" : "admin";
      options.unshift({ id: current.id, label: `${withNumber(current)} — ${why}` });
    }
  }

  return options;
}

/** Reads every profile (an admin's RLS admits all of them) and builds the options. */
export async function loadOwnerOptions(
  supabase: SupabaseClient,
  selfId: string,
  currentOwnerId?: string,
): Promise<OwnerOption[]> {
  const { data, error } = await supabase
    .from("profiles")
    .select(OWNER_PROFILE_COLUMNS)
    .order("full_name", { ascending: true });
  if (error) throw new Error(`Could not load reps: ${error.message}`);
  return ownerOptions((data ?? []) as OwnerProfile[], selfId, currentOwnerId);
}
