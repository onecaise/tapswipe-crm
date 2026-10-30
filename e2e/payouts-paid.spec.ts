import { expect, test, type Page } from "@playwright/test";
import { createClient } from "@supabase/supabase-js";

import { E2E_PASSWORD, PERSONAS, freeBatchSlot, publicStackConfig, storageStateFor } from "./fixtures/seed";
import { service } from "./qa/qa-stack";

/**
 * Phase 9 of docs/design/intake-and-reports.md on the payouts pages: Mark paid
 * and Reopen (A8), the paid month's adjustment (A23), and the per-processor
 * period delete (§3.4).
 *
 * tests/rls/replace-paid-adjustments.test.ts owns every rule. What only a
 * browser shows: that /payouts lists each committed processor-month with its
 * paid state and the two actions; that the typed confirmation and the written
 * reason are asked for and their refusals read as sentences; that a paid month
 * offers the adjustment form; that the period page's delete is per processor
 * and refused for a paid month; and that a rep sees none of it.
 */

const PREFIX = "e2e-paid-";
const MONTHS = ["January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December"];
const phrase = (processor: string, period: string) =>
  `${processor} ${MONTHS[Number(period.slice(5, 7)) - 1]} ${period.slice(0, 4)}`;

type Slot = { processor: string; period: string; batchId: number; mid: string };

async function adminId(): Promise<string> {
  const { data } = await service().from("profiles").select("id").eq("email", PERSONAS.admin.email).single();
  return data!.id as string;
}

/** A committed processor-month with one agent line, as v3 would leave it. */
async function committedMonth(tag: string): Promise<Slot> {
  const db = service();
  const slot = await freeBatchSlot(db);
  const { data: agent } = await db.from("profiles").select("id").eq("email", PERSONAS.agent.email).single();
  const mid = `E2E-PAID-${tag}-${Date.now()}`;
  const { data: merchant, error: merchantError } = await db
    .from("merchants")
    .insert({ agent_id: agent!.id, mid, dba: `${PREFIX}${tag}`, city: "Nashville", state: "TN" })
    .select("id")
    .single();
  if (merchantError) throw new Error(merchantError.message);
  const { data: batch, error } = await db
    .from("rep_payout_batches")
    .insert({
      imported_by: await adminId(),
      file_key: `e2e/${PREFIX}${tag}.xlsx`,
      file_name: `${PREFIX}${tag}.xlsx`,
      status: "committed",
      committed_at: new Date().toISOString(),
      ...slot,
    })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  const { error: lineError } = await db.from("rep_payout_rows").insert({
    agent_id: agent!.id, period: slot.period, processor: slot.processor, mid, merchant_id: merchant!.id,
    merchant_name: `${PREFIX}${tag}`, volume: 1000, residual_income: 100, rep_split_pct: 50, batch_id: batch!.id,
  });
  if (lineError) throw new Error(lineError.message);
  // A slot an earlier run used comes free again; its audit rows must not count.
  await db.from("audit_log").delete().eq("row_id", `${slot.period}/${slot.processor}`);
  return { ...slot, batchId: batch!.id as number, mid };
}

/** Reopens a month this spec left paid: a closure goes only with a reason, through the admin's own session. */
async function reopenIfPaid(processor: string, period: string): Promise<void> {
  const { data } = await service().from("payout_period_closures").select("period").eq("processor", processor).eq("period", period);
  if ((data ?? []).length === 0) return;
  const { apiUrl, publishableKey } = publicStackConfig();
  const admin = createClient(apiUrl, publishableKey, { auth: { persistSession: false } });
  const { error: signInError } = await admin.auth.signInWithPassword({ email: PERSONAS.admin.email, password: E2E_PASSWORD });
  if (signInError) throw new Error(signInError.message);
  const { error } = await admin.rpc("reopen_payout_period", {
    period_input: period, processor_input: processor, reason_input: "e2e cleanup: reopening its own month",
  });
  if (error) throw new Error(error.message);
}

const slots: Slot[] = [];

async function clear(): Promise<void> {
  const db = service();
  for (const s of slots) await reopenIfPaid(s.processor, s.period);
  const { data: merchants } = await db.from("merchants").select("id, mid").like("dba", `${PREFIX}%`);
  const mids = (merchants ?? []).map((m) => m.mid as string);
  if (mids.length > 0) await db.from("rep_payout_rows").delete().in("mid", mids);
  const { data: batches } = await db.from("rep_payout_batches").select("id").like("file_name", `${PREFIX}%`);
  const ids = (batches ?? []).map((b) => b.id as number);
  if (ids.length > 0) await db.from("rep_payout_batches").delete().in("id", ids);
  if (merchants && merchants.length > 0) await db.from("merchants").delete().in("id", merchants.map((m) => m.id));
}

const monthRow = (page: Page, slot: Slot) =>
  page.getByTestId("processor-month").filter({ has: page.locator(`a[href="/payouts/import/${slot.batchId}"]`) });

test.describe("as the admin", () => {
  test.use({ storageState: storageStateFor("admin") });
  test.describe.configure({ mode: "serial" });

  test.beforeAll(clear);
  test.afterAll(clear);

  let paid: Slot;

  test("Mark paid asks for the processor and month typed, refuses anything else, and records one audit row", async ({ page }) => {
    paid = await committedMonth("close");
    slots.push(paid);
    const label = phrase(paid.processor, paid.period);
    await page.goto("/payouts");
    const row = monthRow(page, paid);
    await expect(row).toContainText("not paid");

    await row.getByRole("button", { name: `Mark paid: ${label}` }).click();
    await expect(row).toContainText(`Type ${label} to confirm`);
    await row.getByRole("textbox").fill("yes");
    await row.getByRole("button", { name: "Mark paid" }).click();
    await expect(row).toContainText(`To mark it paid, type ${label} exactly.`);

    await row.getByRole("textbox").fill(label.toLowerCase());
    await row.getByRole("button", { name: "Mark paid" }).click();
    await expect(row).toContainText("paid ");
    await expect(row.getByRole("button", { name: `Reopen: ${label}` })).toBeVisible();

    const { data: audit } = await service()
      .from("audit_log").select("action, detail").eq("row_id", `${paid.period}/${paid.processor}`);
    expect(audit).toEqual([{ action: "close_payout_period", detail: null }]);
  });

  test("a paid month's delete on the period page is refused with its sentence", async ({ page }) => {
    await page.goto(`/payouts/${paid.period.slice(0, 7)}`);
    await page.getByRole("button", { name: `Delete ${paid.processor}` }).click();
    await page.getByRole("button", { name: "Delete 1 line" }).click();
    await expect(page.getByText(/is marked paid and cannot be deleted\. Reopen it \(with a reason\) first/)).toBeVisible();
    const { data } = await service().from("rep_payout_rows").select("id").eq("batch_id", paid.batchId);
    expect(data).toHaveLength(1);
  });

  test("a paid month offers the adjustment form, which posts a line in the open month", async ({ page }) => {
    await page.goto("/payouts");
    const row = monthRow(page, paid);
    await row.getByRole("button", { name: "Post adjustment" }).click();
    const form = row.getByRole("form", { name: /^Adjustment for / });
    await form.getByLabel("Rep", { exact: true }).selectOption({ label: PERSONAS.agent.fullName });
    await form.getByLabel("MID", { exact: true }).fill(paid.mid);
    await form.getByLabel(/Amount/).fill("-7.25");
    await form.getByLabel(/Reason/).fill("Processor clawback after payment");
    await form.getByRole("button", { name: "Post adjustment" }).click();
    await expect(row.getByText(/^Posted in /)).toBeVisible();
    const { data } = await service()
      .from("rep_payout_rows")
      .select("line_kind, adjustment_amount, adjusts_period, processor, adjustment_note")
      .eq("mid", paid.mid).eq("line_kind", "adjustment");
    expect(data).toEqual([{
      line_kind: "adjustment", adjustment_amount: -7.25, adjusts_period: paid.period,
      processor: paid.processor, adjustment_note: "Processor clawback after payment",
    }]);
  });

  test("Reopen asks for a written reason, refuses a short one, and the reason is on its one audit row", async ({ page }) => {
    const label = phrase(paid.processor, paid.period);
    await page.goto("/payouts");
    const row = monthRow(page, paid);
    await row.getByRole("button", { name: `Reopen: ${label}` }).click();
    await row.getByRole("textbox").fill("oops");
    await row.getByRole("button", { name: "Reopen month" }).click();
    await expect(row).toContainText("in at least 10 characters");
    await row.getByRole("textbox").fill("The processor re-sent the file with fees.");
    await row.getByRole("button", { name: "Reopen month" }).click();
    await expect(row).toContainText("not paid");
    const { data: audit } = await service()
      .from("audit_log").select("action, detail").eq("row_id", `${paid.period}/${paid.processor}`).order("id");
    expect(audit).toEqual([
      { action: "close_payout_period", detail: null },
      { action: "reopen_payout_period", detail: "The processor re-sent the file with fees." },
    ]);
  });

  test("an unpaid month is deleted per processor from the period page: lines gone, import deleted, one audit row", async ({ page }) => {
    const gone = await committedMonth("delete");
    slots.push(gone);
    await page.goto(`/payouts/${gone.period.slice(0, 7)}`);
    await page.getByRole("button", { name: `Delete ${gone.processor}` }).click();
    await page.getByRole("button", { name: "Delete 1 line" }).click();
    await expect(page).toHaveURL(/\/payouts$/);
    const db = service();
    expect((await db.from("rep_payout_rows").select("id").eq("batch_id", gone.batchId)).data).toEqual([]);
    expect((await db.from("rep_payout_batches").select("status").eq("id", gone.batchId).single()).data).toEqual({ status: "deleted" });
    const { data: audit } = await db
      .from("audit_log").select("action, detail").eq("row_id", `${gone.period}/${gone.processor}`).eq("action", "delete_payout_period");
    expect(audit).toEqual([{ action: "delete_payout_period", detail: `1 lines; import #${gone.batchId}` }]);
  });
});

test.describe("as a rep", () => {
  test.use({ storageState: storageStateFor("agent") });

  test("sees no processor months, no Mark paid and no adjustment form", async ({ page }) => {
    await page.goto("/payouts");
    await expect(page.getByRole("heading", { name: "Payouts" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Processor months" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: /Mark paid|Reopen|Post adjustment/ })).toHaveCount(0);
  });
});
