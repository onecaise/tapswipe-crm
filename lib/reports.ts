import { periodParam } from "@/lib/format";
import { parsePeriodParam } from "@/lib/payouts";
import { REPORT_TITLES, type ReportKind } from "@/supabase/functions/_shared/report-sheets";

/**
 * The two admin reports at /admin/reports (phase 12 of
 * docs/design/intake-and-reports.md, §7.2).
 *
 * Every figure comes from two security-invoker SQL functions,
 * rep_payout_summary() and merchant_processor_summary() (20261102160000),
 * which read the committed ledger only and sum its own generated rep_payout.
 * Nothing here adds money up: the totals rows are the functions' own
 * GROUPING SETS rows, so the page cannot disagree with a statement. This file
 * holds the URL's filters; the row types, the column lists and the Excel
 * sheet are in supabase/functions/_shared/report-sheets.ts (phase 12b), so the
 * page and the export-report download read one list of columns.
 */

export {
  DEDUCTIONS_HEADER,
  MERCHANT_FIGURES,
  REP_FIGURES,
  reportFileName,
  type MerchantSummaryRow,
  type RepSummaryRow,
  type ReportKind,
} from "@/supabase/functions/_shared/report-sheets";
export const REPORT_TABS = [
  { value: "reps", label: REPORT_TITLES.reps },
  { value: "merchants", label: REPORT_TITLES.merchants },
] as const satisfies readonly { value: ReportKind; label: string }[];

/**
 * One override line behind Report 1's plus (memo §4.5's detail row), for
 * display: the page reads it, nothing sums it.
 */
export type OverrideDetail = {
  id: number;
  role: "debit" | "credit";
  mid: string;
  merchant_name: string | null;
  pct: number | null;
  /** The recipient on a debit; the rep(s) whose merchant it is, on a credit. */
  counterpart: string | null;
  amount: number | null;
};

/** The detail map's key: one rep in one month. */
export const detailKey = (agentId: string, period: string) => `${agentId}|${period}`;

export type ReportFilters = {
  report: ReportKind;
  /** First of the first month, YYYY-MM-DD. */
  from: string;
  /** First of the last month, YYYY-MM-DD; equal to `from` for one month. */
  to: string;
  /** A processor code, or null for every processor. */
  processor: string | null;
};

export type ReportFilterResult =
  | { ok: true; filters: ReportFilters }
  | { ok: false; message: string };

/**
 * The page's filters from its URL. With no month, the latest committed one
 * (`latest`); `to` defaults to `from`. A month that cannot be read, or a range
 * that runs backwards, is said so -- never replaced by another month's
 * figures (parsePeriodParam's rule). An unknown processor is refused the same
 * way rather than read as "all".
 */
export function parseReportFilters(
  params: { report?: string; from?: string; to?: string; processor?: string },
  latest: string,
  processorCodes: readonly string[],
): ReportFilterResult {
  const report: ReportKind = params.report === "merchants" ? "merchants" : "reps";

  const from = params.from ? parsePeriodParam(params.from) : latest;
  if (from === null) return { ok: false, message: "The first month in the address is not a month." };
  const to = params.to ? parsePeriodParam(params.to) : from;
  if (to === null) return { ok: false, message: "The last month in the address is not a month." };
  if (to < from) return { ok: false, message: "The first month is after the last. Choose them again." };

  const processor = params.processor ? params.processor : null;
  if (processor !== null && !processorCodes.includes(processor)) {
    return { ok: false, message: `"${processor}" is not a processor in the CRM.` };
  }

  return { ok: true, filters: { report, from, to, processor } };
}

/** The page's address for a set of filters (the tabs and the form agree on it). */
export function reportsHref(filters: ReportFilters): string {
  const query = new URLSearchParams();
  if (filters.report !== "reps") query.set("report", filters.report);
  query.set("from", periodParam(filters.from));
  if (filters.to !== filters.from) query.set("to", periodParam(filters.to));
  if (filters.processor !== null) query.set("processor", filters.processor);
  return `/admin/reports?${query.toString()}`;
}
