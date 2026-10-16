import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Who reviewed each batch's skipped rows, by batch id.
 *
 * The name lives in audit_log and nowhere else, deliberately: a
 * skips_acknowledged_by column would be a twenty-sixth profiles FK and one more
 * entry in every teardown list (docs/design/residual-splits.md §5.4). The
 * acknowledgement writes exactly one audit row per batch -- a second one is
 * refused -- so the newest row per batch is the only one.
 *
 * audit_log is admin-only by policy, so for anyone else this returns an empty
 * map and the caller shows no reviewer. The query still runs rather than being
 * skipped on role: a role branch here would be a copy of that policy.
 */
export async function loadSkipReviewers(
  supabase: SupabaseClient,
  batchIds: number[],
): Promise<Map<number, string>> {
  const reviewers = new Map<number, string>();
  if (batchIds.length === 0) return reviewers;

  const { data: audits } = await supabase
    .from("audit_log")
    .select("actor_id, row_id, created_at")
    .eq("action", "acknowledge_residual_skips")
    .eq("table_name", "rep_payout_batches")
    .in("row_id", batchIds.map(String))
    .order("created_at", { ascending: false });

  const actorByBatch = new Map<number, string>();
  for (const audit of audits ?? []) {
    const batchId = Number(audit.row_id);
    if (!actorByBatch.has(batchId) && audit.actor_id !== null) {
      actorByBatch.set(batchId, audit.actor_id as string);
    }
  }
  if (actorByBatch.size === 0) return reviewers;

  const { data: people } = await supabase
    .from("profiles")
    .select("id, full_name")
    .in("id", [...new Set(actorByBatch.values())]);

  const names = new Map(
    (people ?? []).map((p) => [p.id as string, p.full_name as string]),
  );
  for (const [batchId, actor] of actorByBatch) {
    const name = names.get(actor);
    if (name) reviewers.set(batchId, name);
  }
  return reviewers;
}
