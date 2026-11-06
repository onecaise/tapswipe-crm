import type { StatusIntent } from "@/components/status-badge";

/**
 * The merchant bulk import's review page (phase 14 of
 * docs/design/intake-and-reports.md): types, labels and grouping. NOTHING here
 * decides whether a row is acceptable. That is the parser's
 * (supabase/functions/_shared/merchant-imports.ts) at staging and
 * commit_merchant_import()'s at commit; this file only presents what they
 * staged. The two vocabularies below are pinned to the parser's by
 * tests/unit/merchant-import-lib.test.ts.
 */

export type MerchantImportBatchStatus = "review" | "committed" | "abandoned";

export type MerchantImportBatch = {
  id: number;
  file_name: string;
  file_kind: "csv" | "xlsx";
  status: MerchantImportBatchStatus;
  row_count: number;
  merchant_count: number | null;
  uploaded_at: string | null;
  committed_at: string | null;
};

/** Never source_bytes: the page has no use for the file itself. */
export const MERCHANT_IMPORT_BATCH_COLUMNS =
  "id, file_name, file_kind, status, row_count, merchant_count, uploaded_at, committed_at";

export type MerchantImportRow = {
  id: number;
  row_number: number;
  type_raw: string | null;
  mid_raw: string | null;
  mid_source: "text" | "number" | "unsafe_number";
  name_raw: string | null;
  split_raw: string | null;
  agent_raw: string | null;
  processor_raw: string | null;
  status_raw: string | null;
  mid: string | null;
  name: string | null;
  owner_id: string | null;
  rate: number | null;
  processor: string | null;
  status: "active" | "inactive" | null;
  merged_into: number | null;
  blockers: string[];
  notes: string[];
};

export const MERCHANT_IMPORT_ROW_COLUMNS =
  "id, row_number, type_raw, mid_raw, mid_source, name_raw, split_raw, agent_raw, processor_raw, status_raw, mid, name, owner_id, rate, processor, status, merged_into, blockers, notes";

/** Every refusal code, in the parser's order, with what the admin reads. */
export const BLOCKER_LABELS = {
  invalid_type: "Type is not MERCHANT",
  missing_mid: "No Merchant ID",
  invalid_mid: "Merchant ID is not 6 to 20 letters and digits",
  mid_precision:
    "Merchant ID may have lost digits in a spreadsheet — use the original CSV export",
  missing_name: "No merchant name",
  invalid_name: "Merchant name is over 200 characters",
  missing_agent: "No agent",
  unknown_agent: "Agent matches no rep's LLC legal name",
  ambiguous_agent: "Agent matches more than one rep",
  inactive_agent: "Agent is a deactivated rep",
  agent_not_rep: "Agent is an admin, not a rep",
  invalid_split: "Split is not a fraction (0.5) or a percentage (50%) in hundredths",
  split_above_50: "Split is above 50%",
  unknown_processor: "Processor is not in the CRM's list",
  invalid_status: "Status is not Active or Inactive",
  duplicate_mid_conflict:
    "Merchant ID repeated with a different agent, split or status",
  duplicate_mid_processor: "Merchant ID repeated with two different processors",
  mid_exists: "Merchant ID is already a merchant in the CRM",
} as const;

export type MerchantImportBlocker = keyof typeof BLOCKER_LABELS;

export const NOTE_LABELS = {
  mid_from_number:
    "Merchant ID came from a spreadsheet number: any leading zeros cannot be recovered",
  rate_from_profile: "Split blank: takes the rep's current profile rate",
  rate_differs: "Split differs from the rep's profile rate (kept as given)",
  merged: "Repeats an earlier row's Merchant ID: merged into that merchant",
  name_differs: "Repeated Merchant ID under a different name: the first name is kept",
} as const;

export type MerchantImportNote = keyof typeof NOTE_LABELS;

export function blockerLabel(code: string): string {
  return (BLOCKER_LABELS as Record<string, string>)[code] ?? code;
}

export function noteLabel(code: string): string {
  return (NOTE_LABELS as Record<string, string>)[code] ?? code;
}

export function batchStatusIntent(status: string): StatusIntent {
  if (status === "committed") return "success";
  if (status === "abandoned") return "neutral";
  return "warning";
}

/** The cell a refusal is about, as the file had it. */
function offendingValue(code: string, row: MerchantImportRow): string | null {
  switch (code) {
    case "invalid_type":
      return row.type_raw;
    case "missing_mid":
    case "invalid_mid":
    case "mid_precision":
    case "mid_exists":
    case "duplicate_mid_conflict":
    case "duplicate_mid_processor":
      return row.mid_raw;
    case "missing_name":
    case "invalid_name":
      return row.name_raw;
    case "missing_agent":
    case "unknown_agent":
    case "ambiguous_agent":
    case "inactive_agent":
    case "agent_not_rep":
      return row.agent_raw;
    case "invalid_split":
    case "split_above_50":
      return row.split_raw;
    case "unknown_processor":
      return row.processor_raw;
    case "invalid_status":
      return row.status_raw;
    default:
      return null;
  }
}

/** One distinct offending value and the rows that carry it. */
export type ProblemValue = { value: string; rows: number[] };

/** Every row a repeated MID touches, as the file has them. */
export type DuplicateGroup = {
  mid: string;
  rows: {
    rowNumber: number;
    agent: string | null;
    split: string | null;
    processor: string | null;
    status: string | null;
    name: string | null;
  }[];
};

export type ProblemGroup = {
  code: string;
  rowCount: number;
  /** Distinct values (agent text, processor name, MID...) with their rows. */
  values: ProblemValue[];
  /** For the two repeated-MID refusals: every row involved, side by side. */
  duplicates?: DuplicateGroup[];
};

export type MerchantImportReview = {
  total: number;
  /** Merchants the commit would create: first rows of each MID, no refusals. */
  willCreate: number;
  merged: number;
  refusedRows: number;
  problems: ProblemGroup[];
  notes: { code: string; count: number }[];
  canCommit: boolean;
};

/** What the review page shows, from the staged rows. */
export function reviewMerchantImport(rows: readonly MerchantImportRow[]): MerchantImportReview {
  const order = Object.keys(BLOCKER_LABELS);
  const byCode = new Map<string, MerchantImportRow[]>();
  for (const row of rows) {
    for (const code of row.blockers) {
      byCode.set(code, [...(byCode.get(code) ?? []), row]);
    }
  }

  const problems: ProblemGroup[] = [...byCode.entries()]
    .sort(([a], [b]) => {
      const ia = order.indexOf(a);
      const ib = order.indexOf(b);
      return (ia < 0 ? order.length : ia) - (ib < 0 ? order.length : ib);
    })
    .map(([code, hit]) => {
      const values = new Map<string, number[]>();
      for (const row of hit) {
        const value = (offendingValue(code, row) ?? "").trim() || "(blank)";
        values.set(value, [...(values.get(value) ?? []), row.row_number]);
      }
      const group: ProblemGroup = {
        code,
        rowCount: hit.length,
        values: [...values.entries()]
          .map(([value, rowNumbers]) => ({ value, rows: rowNumbers }))
          .sort((a, b) => b.rows.length - a.rows.length || a.value.localeCompare(b.value)),
      };
      if (code === "duplicate_mid_conflict" || code === "duplicate_mid_processor") {
        const mids = new Map<string, MerchantImportRow[]>();
        for (const row of hit) {
          const key = (row.mid ?? row.mid_raw ?? "").toUpperCase();
          mids.set(key, [...(mids.get(key) ?? []), row]);
        }
        group.duplicates = [...mids.values()].map((members) => ({
          mid: members[0].mid ?? members[0].mid_raw ?? "",
          rows: members.map((row) => ({
            rowNumber: row.row_number,
            agent: row.agent_raw,
            split: row.split_raw,
            processor: row.processor_raw,
            status: row.status_raw,
            name: row.name_raw,
          })),
        }));
      }
      return group;
    });

  const noteCounts = new Map<string, number>();
  for (const row of rows) {
    for (const code of row.notes) noteCounts.set(code, (noteCounts.get(code) ?? 0) + 1);
  }
  const noteOrder = Object.keys(NOTE_LABELS);
  const notes = [...noteCounts.entries()]
    .map(([code, count]) => ({ code, count }))
    .sort((a, b) => noteOrder.indexOf(a.code) - noteOrder.indexOf(b.code));

  const refusedRows = rows.filter((row) => row.blockers.length > 0).length;
  return {
    total: rows.length,
    willCreate: rows.filter((row) => row.merged_into === null && row.blockers.length === 0).length,
    merged: rows.filter((row) => row.merged_into !== null && row.blockers.length === 0).length,
    refusedRows,
    problems,
    notes,
    canCommit: rows.length > 0 && refusedRows === 0,
  };
}

/** The staged rate as the page shows it. */
export function rateLabel(row: MerchantImportRow): string {
  if (row.rate !== null) return `${Number(row.rate)}%`;
  if (row.split_raw === null || row.split_raw.trim() === "") return "Rep's rate";
  return row.split_raw;
}
