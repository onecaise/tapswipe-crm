import type { SupabaseClient } from "@supabase/supabase-js";

import { formatPeriod } from "@/lib/format";
import { previousPeriod } from "@/lib/rep-shares";

/**
 * Overrides (20261102120000, memo §4): a percent of a merchant's FULL
 * residual paid to a named person, at most the merchant's rate. Since
 * 20261116120000 (docs/design/override-funding.md) each override says who
 * pays it: the OWNER's rep side (the owner keeps rate − percent, the company
 * its share) or the COMPANY's share (the owner keeps the full rate, the
 * company its share less the percent).
 *
 * Two readers, as for shared accounts:
 *
 *  - An ADMIN reads `merchant_overrides` directly (its one policy is
 *    is_admin()) and `profiles` for the names.
 *  - A REP reads `my_override_recipients()` and nothing else: who receives
 *    the override on each of their OWN debit lines, and its percent. The
 *    table returns a rep no rows, so there is no fallback read to reach for.
 *  - The RECIPIENT reads their own credit line, whose merchant_name is plain
 *    text. Nothing here gives them the merchant, the rep or the percent.
 */

export type MerchantOverride = {
  id: number;
  merchant_id: number;
  recipient_id: string;
  override_pct: number;
  /** First month it applies to, YYYY-MM-01. */
  effective_from: string;
  /** EXCLUSIVE: the first month it no longer applies; null = open-ended. */
  effective_to: string | null;
  /** Who pays it (20261116120000). Changed only by set_merchant_override_funding(). */
  funded_by: OverrideFunding;
};

/** Who pays an override: the owner's rep side or the company's share. */
export type OverrideFunding = "owner" | "company";

export const MERCHANT_OVERRIDE_COLUMNS =
  "id, merchant_id, recipient_id, override_pct, effective_from, effective_to, funded_by";

/** Who pays a company-funded override, where a line would otherwise name the debtor. */
export const COMPANY_FUNDER = "Tapswipe (company share)";

/** "paid from the company's share" / "paid from the owner's side". */
export function overrideFundingText(fundedBy: OverrideFunding): string {
  return fundedBy === "company" ? "paid from the company's share" : "paid from the owner's side";
}

/** The two "Paid from" choices on the form, in the order shown. Neither is preselected. */
export const OVERRIDE_FUNDING_CHOICES = [
  { value: "owner", label: "The owner's side" },
  { value: "company", label: "The company's share" },
] as const satisfies readonly { value: OverrideFunding; label: string }[];

/** The form's prompt until a "Paid from" choice is made. */
export const CHOOSE_FUNDING = "Choose who pays it: the owner's side or the company's share.";

/** One override behind a rep's debit line: my_override_recipients()' three keys. */
export type OverrideRecipientView = {
  override_id: number;
  recipient_name: string;
  override_pct: number;
};

/**
 * An override percent as typed, against the merchant's rate: above 0, at
 * most two decimals, at most the rate. Returns the value in hundredths, or a
 * sentence. A courtesy only -- set_merchant_override() is the boundary and
 * says the same thing when it refuses.
 */
export function parseOverridePct(
  raw: string,
  rate: number | null,
): { ok: true; hundredths: number } | { ok: false; message: string } {
  if (rate === null) {
    return { ok: false, message: "This merchant has no split rate yet. Set its rate first." };
  }
  if (Number(rate) === 0) {
    return { ok: false, message: "This merchant's rate is 0, so there is no rep side for an override." };
  }
  const text = raw.trim().replace(/%$/, "");
  if (!/^\d{1,2}(\.\d{1,2})?$/.test(text)) {
    return { ok: false, message: "Enter a percent above 0 with at most two decimals, like 10 or 2.5." };
  }
  const hundredths = Math.round(Number(text) * 100);
  if (hundredths <= 0) {
    return { ok: false, message: "Enter a percent above 0 with at most two decimals, like 10 or 2.5." };
  }
  if (hundredths > Math.round(Number(rate) * 100)) {
    return {
      ok: false,
      message: `An override cannot be more than this merchant's rate: ${Number(rate)}.`,
    };
  }
  return { ok: true, hundredths };
}

/**
 * The worked example under the form, for the "Paid from" choice made (null
 * until one is), so the admin reads what the percent means before saving:
 *   owner:   "the recipient gets $10.00, the owner keeps $40.00 of the $50.00
 *             rep side, and the company keeps $50.00."
 *   company: "the recipient gets $10.00, the owner keeps the full $50.00 rep
 *             side, and the company keeps $40.00 of its $50.00."
 */
export function overrideExample(
  pctHundredths: number,
  rate: number,
  fundedBy: OverrideFunding | null,
): string {
  if (fundedBy === null) return CHOOSE_FUNDING;
  const rep = Number(rate);
  const pct = pctHundredths / 100;
  const company = Math.round((100 - rep) * 100) / 100;
  const lead = `On a $100 residual: the recipient gets $${pct.toFixed(2)}`;
  if (fundedBy === "company") {
    const keep = Math.round((company - pct) * 100) / 100;
    return `${lead}, the owner keeps the full $${rep.toFixed(2)} rep side, and the company keeps $${keep.toFixed(2)} of its $${company.toFixed(2)}.`;
  }
  const keep = Math.round((rep - pct) * 100) / 100;
  return `${lead}, the owner keeps $${keep.toFixed(2)} of the $${rep.toFixed(2)} rep side, and the company keeps $${company.toFixed(2)}.`;
}

/** "from August 2026" or "August 2026 – October 2026" (effective_to is exclusive). */
export function overrideMonths(from: string, to: string | null): string {
  if (to === null) return `from ${formatPeriod(from)}`;
  return `${formatPeriod(from)} – ${formatPeriod(previousPeriod(to))}`;
}

/** The override covering `period`, if any (at most one, by the exclusion constraint). */
export function overrideInForce(
  overrides: readonly MerchantOverride[],
  period: string,
): MerchantOverride | null {
  return (
    overrides.find(
      (o) => o.effective_from <= period && (o.effective_to === null || period < o.effective_to),
    ) ?? null
  );
}

/** Every override on one merchant, newest first. Admin-only by policy. */
export async function loadMerchantOverrides(
  supabase: SupabaseClient,
  merchantId: number,
): Promise<MerchantOverride[]> {
  const { data, error } = await supabase
    .from("merchant_overrides")
    .select(MERCHANT_OVERRIDE_COLUMNS)
    .eq("merchant_id", merchantId)
    .order("effective_from", { ascending: false });
  if (error) throw new Error(`Could not load overrides: ${error.message}`);
  return ((data ?? []) as Record<string, unknown>[]).map((row) => ({
    ...(row as unknown as MerchantOverride),
    override_pct: Number(row.override_pct),
  }));
}

/**
 * A committed processor-month an override's lines are in (its "touched
 * months", 20261116120000): whether it is marked paid, and whether its lines
 * still carry another funding than the override's now (replace it to apply).
 */
export type OverrideMonth = {
  processor: string;
  /** YYYY-MM-01. */
  period: string;
  paid: boolean;
  stale: boolean;
};

/**
 * The touched months of each override, by override id, oldest first.
 * Admin-only by policy (the ledger's override lines of other reps, and
 * payout_period_closures). Display only: set_merchant_override_funding()
 * applies the same paid-month rule itself.
 */
export async function loadOverrideMonths(
  supabase: SupabaseClient,
  overrides: readonly MerchantOverride[],
): Promise<Map<number, OverrideMonth[]>> {
  const months = new Map<number, OverrideMonth[]>();
  if (overrides.length === 0) return months;
  const [{ data: lineData, error }, { data: paidData, error: paidError }] = await Promise.all([
    supabase
      .from("rep_payout_rows")
      .select("override_id, processor, period, override_funded_by")
      .eq("line_kind", "override")
      .eq("override_role", "credit")
      .not("batch_id", "is", null)
      .in("override_id", overrides.map((o) => o.id)),
    supabase.from("payout_period_closures").select("processor, period"),
  ]);
  if (error) throw new Error(`Could not load the override's months: ${error.message}`);
  if (paidError) throw new Error(`Could not load which months are paid: ${paidError.message}`);
  const paid = new Set(
    ((paidData ?? []) as { processor: string; period: string }[]).map((p) => `${p.processor}|${p.period}`),
  );
  const funding = new Map(overrides.map((o) => [o.id, o.funded_by]));
  type Line = { override_id: number; processor: string; period: string; override_funded_by: OverrideFunding | null };
  for (const line of (lineData ?? []) as Line[]) {
    const list = months.get(line.override_id) ?? [];
    let month = list.find((m) => m.processor === line.processor && m.period === line.period);
    if (!month) {
      month = { processor: line.processor, period: line.period, paid: paid.has(`${line.processor}|${line.period}`), stale: false };
      list.push(month);
    }
    if (line.override_funded_by !== funding.get(line.override_id)) month.stale = true;
    months.set(line.override_id, list);
  }
  for (const list of months.values()) {
    list.sort((a, b) => a.period.localeCompare(b.period) || a.processor.localeCompare(b.processor));
  }
  return months;
}

/**
 * Who receives each override behind a page's debit lines, by override id.
 *
 * As an admin: from the table and profiles, under their admin policies. As
 * anyone else: from my_override_recipients(), which answers only for the
 * caller's own debit lines. An empty map on any error: the line still shows
 * its amount, and a name that cannot load is left out, never guessed.
 */
export async function loadOverrideViews(
  supabase: SupabaseClient,
  isAdmin: boolean,
  overrideIds: number[],
): Promise<Map<number, OverrideRecipientView>> {
  const views = new Map<number, OverrideRecipientView>();
  if (overrideIds.length === 0) return views;

  if (isAdmin) {
    const { data } = await supabase
      .from("merchant_overrides")
      .select("id, recipient_id, override_pct")
      .in("id", overrideIds);
    const rows = (data ?? []) as { id: number; recipient_id: string; override_pct: number }[];
    if (rows.length === 0) return views;
    const { data: people } = await supabase
      .from("profiles")
      .select("id, full_name")
      .in("id", [...new Set(rows.map((r) => r.recipient_id))]);
    const names = new Map(
      ((people ?? []) as { id: string; full_name: string }[]).map((p) => [p.id, p.full_name]),
    );
    for (const row of rows) {
      views.set(Number(row.id), {
        override_id: Number(row.id),
        recipient_name: names.get(row.recipient_id) ?? "Unknown",
        override_pct: Number(row.override_pct),
      });
    }
    return views;
  }

  const { data, error } = await supabase.rpc("my_override_recipients");
  if (error || !Array.isArray(data)) return views;
  for (const row of data as Record<string, unknown>[]) {
    views.set(Number(row.override_id), {
      override_id: Number(row.override_id),
      recipient_name: String(row.recipient_name),
      override_pct: Number(row.override_pct),
    });
  }
  return views;
}

/**
 * What an override line says beside its amount (memo §4.3, A4c):
 *   debit:  "Override 10% of residual · to Dana Cole"
 *   credit: "Override received"
 * The debit names who receives it whenever the name could be loaded; the
 * credit names nobody -- the recipient learns the merchant's name from the
 * line and nothing else. An admin's credit also shows the percent and, for a
 * company-funded override, "from the company's share". A company-funded
 * override has no debit line, so its owner sees nothing (design D3).
 */
export function overrideLineLabel(
  line: { override_role: "debit" | "credit" | null; override_funded_by?: OverrideFunding | null },
  view: OverrideRecipientView | undefined,
  isAdmin: boolean,
): string {
  const pct = view ? `${Number(view.override_pct)}% of residual` : null;
  if (line.override_role === "debit") {
    return [`Override${pct ? ` ${pct}` : ""}`, view ? `to ${view.recipient_name}` : null]
      .filter(Boolean)
      .join(" · ");
  }
  if (!isAdmin) return "Override received";
  return [
    "Override received",
    pct,
    line.override_funded_by === "company" ? "from the company's share" : null,
  ]
    .filter(Boolean)
    .join(" · ");
}

/** The ids of the overrides a set of lines names. */
export function overrideIdsOf(rows: readonly { override_id?: number | null }[]): number[] {
  return [
    ...new Set(
      rows.map((row) => row.override_id ?? null).filter((id): id is number => id !== null),
    ),
  ];
}
