import type { SupabaseClient } from "@supabase/supabase-js";

/**
 * Abandons a residual import batch that is still under review. Returns null on
 * success, or a sentence for the admin.
 *
 * The one path for this, shared by the Abandon button
 * (components/residual-batch-actions.tsx) and the upload form's clean-up of a
 * file that turned out not to be a residual report (D-08), so "remove a batch
 * from Review" means the same thing wherever it happens.
 *
 * An UPDATE, not a delete: rep_payout_batches has no delete policy and no delete
 * grant — a batch is the record that an import was attempted, and the uploaded
 * file stays downloadable behind it.
 */
export async function abandonResidualBatch(
  supabase: SupabaseClient,
  batchId: number,
): Promise<string | null> {
  const { error, count } = await supabase
    .from("rep_payout_batches")
    .update({ status: "abandoned" }, { count: "exact" })
    .eq("id", batchId);

  // RLS filters rather than errors, so a write the policy hides reports success
  // having changed nothing. Without the count check a rep who reached this
  // control would be told the batch was abandoned.
  if (error) return error.message;
  if (count === 0) return "That batch could not be abandoned. Reload the page.";
  return null;
}
