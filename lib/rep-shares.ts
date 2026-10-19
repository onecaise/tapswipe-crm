import type { SupabaseClient } from "@supabase/supabase-js";

import { formatPeriod } from "@/lib/format";

/**
 * Shared accounts: two reps dividing one merchant's 50-point rep side
 * (docs/design/residual-splits.md). The company keeps the other 50, always.
 *
 * Two readers, deliberately different:
 *
 *  - An ADMIN reads `merchant_rep_shares` directly; its select policy is
 *    is_admin() and nothing else.
 *  - A REP reads `my_share_partners()` (20261019120000) and nothing else: the
 *    partner's name and the rep's own share and months. Never the partner's
 *    share or payout. The table itself returns zero rows to a rep, so there is
 *    no "fallback" read to reach for -- and none must be added.
 */

/** The rep side of every account, in rep-percent terms. */
export const REP_SIDE_PCT = 50;

export type MerchantShare = {
  id: number;
  merchant_id: number;
  primary_agent_id: string;
  secondary_agent_id: string;
  primary_rep_pct: number;
  secondary_rep_pct: number;
  /** First month it applies to, YYYY-MM-01. */
  effective_from: string;
  /** EXCLUSIVE: the first month it no longer applies; null = open-ended. */
  effective_to: string | null;
};

export const MERCHANT_SHARE_COLUMNS =
  "id, merchant_id, primary_agent_id, secondary_agent_id, primary_rep_pct, secondary_rep_pct, effective_from, effective_to";

/** One row of my_share_partners(): exactly these five keys. */
export type SharePartnerEntry = {
  rep_share_id: number;
  partner_name: string;
  own_rep_pct: number;
  effective_from: string;
  effective_to: string | null;
};

/**
 * A rep-percent figure as typed: above 0, at most two decimals, at most 50.
 * Returns the value in hundredths (4000 for "40"), so totals are compared in
 * integers and "33.33 + 16.67" is exactly 5000 rather than a float near it.
 */
export function parseRepPct(raw: string): number | null {
  const text = raw.trim();
  if (!/^\d{1,2}(\.\d{1,2})?$/.test(text)) return null;
  const hundredths = Math.round(Number(text) * 100);
  if (hundredths <= 0 || hundredths > REP_SIDE_PCT * 100) return null;
  return hundredths;
}

/**
 * Why a signer + partner pair cannot be saved, as a sentence, or null when it
 * can. The same rule the RPCs enforce (each above 0, hundredths at most,
 * totalling 50) -- a courtesy so the form can refuse before the round trip;
 * set_merchant_rep_share() and post_share_correction() are the boundary.
 */
export function shareSplitProblem(signer: string, partner: string): string | null {
  if (signer.trim() === "" || partner.trim() === "") {
    return "Enter both shares.";
  }
  const a = parseRepPct(signer);
  const b = parseRepPct(partner);
  if (a === null || b === null) {
    return "Each share is a number above 0 with at most two decimals, like 40 or 33.33.";
  }
  if (a + b !== REP_SIDE_PCT * 100) {
    return `The two shares must add up to ${REP_SIDE_PCT}. These add up to ${formatHundredths(a + b)}.`;
  }
  return null;
}

/** 4000 -> "40", 3333 -> "33.33", 1650 -> "16.5". */
export function formatHundredths(hundredths: number): string {
  return String(hundredths / 100);
}

/**
 * The live line under the inputs: "Company 50% · Signer 40% · Partner 10%".
 * A side that is not a valid figure yet shows as "?" rather than a guess.
 */
export function shareSummary(signer: string, partner: string): string {
  const show = (raw: string) => {
    const value = parseRepPct(raw);
    return value === null ? "?" : `${formatHundredths(value)}%`;
  };
  return `Company ${REP_SIDE_PCT}% · Signer ${show(signer)} · Partner ${show(partner)}`;
}

/** `<input type="month">` value ("2026-08") to a period ("2026-08-01"). */
export function monthInputToPeriod(value: string): string | null {
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(value) ? `${value}-01` : null;
}

/** A period ("2026-08-01") to an `<input type="month">` value ("2026-08"). */
export function periodToMonthInput(period: string): string {
  return period.slice(0, 7);
}

/** The month after a period, as a period. Arithmetic on the text, no Date. */
export function nextPeriod(period: string): string {
  const year = Number(period.slice(0, 4));
  const month = Number(period.slice(5, 7));
  return month === 12
    ? `${year + 1}-01-01`
    : `${year}-${String(month + 1).padStart(2, "0")}-01`;
}

/** The month before a period, as a period. */
export function previousPeriod(period: string): string {
  const year = Number(period.slice(0, 4));
  const month = Number(period.slice(5, 7));
  return month === 1
    ? `${year - 1}-12-01`
    : `${year}-${String(month - 1).padStart(2, "0")}-01`;
}

/**
 * "from August 2026" or "August 2026 – October 2026". effective_to is
 * EXCLUSIVE, so the last month shown is the one before it.
 */
export function shareMonths(from: string, to: string | null): string {
  if (to === null) return `from ${formatPeriod(from)}`;
  return `${formatPeriod(from)} – ${formatPeriod(previousPeriod(to))}`;
}

/** Every share on one merchant, newest first. Admin-only by policy. */
export async function loadMerchantShares(
  supabase: SupabaseClient,
  merchantId: number,
): Promise<MerchantShare[]> {
  const { data, error } = await supabase
    .from("merchant_rep_shares")
    .select(MERCHANT_SHARE_COLUMNS)
    .eq("merchant_id", merchantId)
    .order("effective_from", { ascending: false });
  if (error) throw new Error(`Could not load shared accounts: ${error.message}`);
  return ((data ?? []) as Record<string, unknown>[]).map((row) => ({
    ...(row as unknown as MerchantShare),
    // numeric arrives as a string or a number depending on the driver path;
    // the form compares in hundredths, so pin it to a number once, here.
    primary_rep_pct: Number(row.primary_rep_pct),
    secondary_rep_pct: Number(row.secondary_rep_pct),
  }));
}

/**
 * The caller's own shares through my_share_partners(), optionally narrowed to
 * one merchant. An empty list on any error: a notice that cannot load is
 * left out rather than replaced by an error on a page whose job is elsewhere.
 */
export async function loadMySharePartners(
  supabase: SupabaseClient,
  merchantId?: number,
): Promise<SharePartnerEntry[]> {
  const { data, error } = await supabase.rpc("my_share_partners", {
    merchant_id_input: merchantId ?? null,
  });
  if (error || !Array.isArray(data)) return [];
  return (data as Record<string, unknown>[]).map((row) => ({
    rep_share_id: Number(row.rep_share_id),
    partner_name: String(row.partner_name),
    own_rep_pct: Number(row.own_rep_pct),
    effective_from: String(row.effective_from),
    effective_to: row.effective_to === null ? null : String(row.effective_to),
  }));
}

/**
 * One month a correction could be posted for: the single, unshared import
 * line a merchant's MID has in a committed month.
 */
export type CorrectableMonth = {
  period: string;
  /** The rep that month paid: the "signer" of the correction. */
  agent_id: string;
  /** False while the line's residual or rate is blank: nothing to divide. */
  payout_known: boolean;
  /** The posting month of a correction already made for it, or null. */
  corrected_in: string | null;
};

type LedgerLine = {
  period: string;
  agent_id: string;
  line_kind: string;
  share_role: string | null;
  rep_payout: number | string | null;
  adjusts_period: string | null;
};

/**
 * What the merchant page's correction control needs from the ledger, from
 * one admin read of the MID's lines (an admin sees every row by RLS):
 *
 *   * latestCommitted -- the latest month holding an import line for this MID,
 *     the boundary the share RPCs refuse to cross;
 *   * months -- the committed months a correction could apply to.
 *
 * A month qualifies only with exactly ONE import line and that line unshared,
 * which is post_share_correction()'s own first rule; anything else would
 * offer an admin a month the RPC refuses.
 */
export async function loadShareLedger(
  supabase: SupabaseClient,
  mid: string,
): Promise<{ latestCommitted: string | null; months: CorrectableMonth[] }> {
  const { data, error } = await supabase
    .from("rep_payout_rows")
    .select("period, agent_id, line_kind, share_role, rep_payout, adjusts_period")
    .eq("mid", mid)
    .order("period", { ascending: false });
  if (error) throw new Error(`Could not load this MID's payouts: ${error.message}`);
  const lines = (data ?? []) as LedgerLine[];

  const imports = lines.filter((line) => line.line_kind === "import");
  const correctedIn = new Map<string, string>();
  for (const line of lines) {
    if (line.line_kind === "adjustment" && line.adjusts_period) {
      correctedIn.set(line.adjusts_period, line.period);
    }
  }

  const byPeriod = new Map<string, LedgerLine[]>();
  for (const line of imports) {
    byPeriod.set(line.period, [...(byPeriod.get(line.period) ?? []), line]);
  }

  const months: CorrectableMonth[] = [];
  for (const [period, group] of byPeriod) {
    if (group.length !== 1 || group[0].share_role !== null) continue;
    months.push({
      period,
      agent_id: group[0].agent_id,
      payout_known: group[0].rep_payout !== null,
      corrected_in: correctedIn.get(period) ?? null,
    });
  }

  return {
    latestCommitted: imports.length > 0 ? imports[0].period : null,
    months,
  };
}
