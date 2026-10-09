import { test } from "@playwright/test";
import { service } from "./stack";
// One-off: removes residual batches the QA exploration created (file names start "qa-").
test("cleanup qa residual batches", async () => {
  const db = service();
  const { data } = await db.from("rep_payout_batches").select("id, file_name").like("file_name", "qa-%");
  for (const b of data ?? []) {
    await db.from("rep_payout_import_rows").delete().eq("batch_id", b.id);
    await db.storage.from("residual-imports").remove([`${b.id}/${b.file_name}`]);
    const { error } = await db.from("rep_payout_batches").delete().eq("id", b.id);
    console.log("removed", b.id, b.file_name, error?.message ?? "ok");
  }
});
