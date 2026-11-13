/**
 * Shared by the residual-upload specs: a six-column processor file (phase 7 of
 * docs/design/intake-and-reports.md), the upload page's three choices, merchants
 * for the file's MIDs, and service-role cleanup. Local stack only (qa-stack).
 */
import type { Page } from "@playwright/test";
import * as XLSX from "xlsx";

import { PERSONAS, freeBatchSlot } from "../fixtures/seed";
import { service } from "./qa-stack";

export const XLSX_TYPE = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

export const HEADER = ["Processor", "Merchant Number", "Merchant Name", "Income Type", "Volume", "Residual"];

export function workbook(rows: unknown[][]): Buffer {
  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), "Residuals");
  return XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer;
}

/** A processor-month no batch uses, so an upload is never a replace by accident. */
export async function freeSlot(): Promise<{ processor: string; period: string }> {
  return freeBatchSlot(service());
}

/** Fills the upload form (processor, year, then month) and uploads. */
export async function upload(
  page: Page,
  file: { name: string; buffer: Buffer; mimeType?: string },
  slot: { processor: string; period: string },
): Promise<void> {
  await page.goto("/payouts/import");
  // Choices made before the page hydrates are lost (phase 1 build notes);
  // the form is only usable once the network has settled.
  await page.waitForLoadState("networkidle");
  await page.getByLabel("Processor").selectOption(slot.processor);
  await page.getByLabel("Year").selectOption(slot.period.slice(0, 4));
  await page.getByLabel("Month").selectOption(slot.period.slice(5, 7));
  await page
    .getByLabel("Residual report (XLSX or CSV)")
    .setInputFiles({ name: file.name, mimeType: file.mimeType ?? XLSX_TYPE, buffer: file.buffer });
  await page.getByRole("button", { name: "Upload" }).click();
}

let counter = 0;
/** A 12-digit MID unique to this run. */
export function newMid(): string {
  counter += 1;
  return `9${String(Date.now()).slice(-7)}${String(counter).padStart(4, "0")}`;
}

/** A merchant with this MID, owned by the e2e agent, its DBA prefixed for cleanup. */
export async function merchantFor(
  prefix: string,
  mid: string,
  fields: { processor?: string | null; status?: string } = {},
): Promise<number> {
  const db = service();
  const { data: agent } = await db.from("profiles").select("id").eq("email", PERSONAS.agent.email).single();
  const { data, error } = await db
    .from("merchants")
    .insert({
      agent_id: agent!.id,
      mid,
      dba: `${prefix}${mid}`,
      city: "Nashville",
      state: "TN",
      status: fields.status ?? "active",
      processor: fields.processor === undefined ? null : fields.processor,
    })
    .select("id")
    .single();
  if (error) throw new Error(`merchant: ${error.message}`);
  return data!.id as number;
}

/** Service-role cleanup, FK order: staged rows, ledger lines, batches and files, merchants. */
export async function clearQa(prefix: string): Promise<void> {
  const db = service();
  const { data } = await db.from("rep_payout_batches").select("id, file_key").like("file_name", `${prefix}%`);
  const rows = (data ?? []) as { id: number; file_key: string | null }[];
  if (rows.length > 0) {
    const ids = rows.map((r) => r.id);
    await db.from("rep_payout_import_rows").delete().in("batch_id", ids);
    await db.from("rep_payout_rows").delete().in("batch_id", ids);
    await db.from("audit_log").delete().eq("table_name", "rep_payout_batches").in("row_id", ids.map(String));
    const { error } = await db.from("rep_payout_batches").delete().in("id", ids);
    if (error) throw new Error(`clear batches: ${error.message}`);
    const keys = rows.map((r) => r.file_key).filter((k): k is string => Boolean(k));
    if (keys.length > 0) await db.storage.from("residual-imports").remove(keys);
  }
  const { error } = await db.from("merchants").delete().like("dba", `${prefix}%`);
  if (error) throw new Error(`clear merchants: ${error.message}`);
}
