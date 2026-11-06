import { describe, expect, it } from "vitest";

import {
  BLOCKER_LABELS,
  NOTE_LABELS,
  rateLabel,
  reviewMerchantImport,
  type MerchantImportRow,
} from "@/lib/merchant-imports";
import {
  MERCHANT_IMPORT_BLOCKERS,
  MERCHANT_IMPORT_NOTES,
} from "../../supabase/functions/_shared/merchant-imports.ts";

/** The review page's presentation of a staged merchant import. Invented data. */

let id = 0;
function row(overrides: Partial<MerchantImportRow> = {}): MerchantImportRow {
  id += 1;
  return {
    id,
    row_number: id + 1,
    type_raw: "MERCHANT",
    mid_raw: `40010020${String(id).padStart(4, "0")}`,
    mid_source: "text",
    name_raw: "Invented Merchant",
    split_raw: "0.5",
    agent_raw: "Quill Payments LLC",
    processor_raw: "TSYS",
    status_raw: "Active",
    mid: `40010020${String(id).padStart(4, "0")}`,
    name: "Invented Merchant",
    owner_id: "aaaaaaaa-0000-0000-0000-000000000001",
    rate: 50,
    processor: "TSYS",
    status: "active",
    merged_into: null,
    blockers: [],
    notes: [],
    ...overrides,
  };
}

describe("vocabularies", () => {
  it("labels exactly the parser's refusals, in its order", () => {
    expect(Object.keys(BLOCKER_LABELS)).toEqual([...MERCHANT_IMPORT_BLOCKERS]);
  });
  it("labels exactly the parser's notes, in its order", () => {
    expect(Object.keys(NOTE_LABELS)).toEqual([...MERCHANT_IMPORT_NOTES]);
  });
});

describe("reviewMerchantImport", () => {
  it("counts merchants to create, merged rows and refused rows; commit only with no refusal", () => {
    const first = row();
    const review = reviewMerchantImport([first, row({ merged_into: first.row_number, notes: ["merged"] }), row()]);
    expect(review).toMatchObject({ total: 3, willCreate: 2, merged: 1, refusedRows: 0, canCommit: true });
    expect(review.notes).toEqual([{ code: "merged", count: 1 }]);
    expect(reviewMerchantImport([]).canCommit).toBe(false);
  });

  it("lists each distinct unknown agent with its row numbers, most rows first", () => {
    const rows = [
      row({ agent_raw: "Nobody LLC", blockers: ["unknown_agent"] }),
      row({ agent_raw: "Typo Payments", blockers: ["unknown_agent"] }),
      row({ agent_raw: "Typo Payments", blockers: ["unknown_agent"] }),
      row({ processor_raw: "Fiserv Nova", blockers: ["unknown_processor"] }),
    ];
    const review = reviewMerchantImport(rows);
    expect(review.canCommit).toBe(false);
    expect(review.refusedRows).toBe(4);
    expect(review.problems.map((p) => p.code)).toEqual(["unknown_agent", "unknown_processor"]);
    expect(review.problems[0].values).toEqual([
      { value: "Typo Payments", rows: [rows[1].row_number, rows[2].row_number] },
      { value: "Nobody LLC", rows: [rows[0].row_number] },
    ]);
    expect(review.problems[1].values).toEqual([{ value: "Fiserv Nova", rows: [rows[3].row_number] }]);
  });

  it("shows every row of a conflicting repeated MID side by side", () => {
    const a = row({ mid: "SQ7XK2MN9P", mid_raw: "SQ7XK2MN9P", blockers: ["duplicate_mid_conflict"] });
    const b = row({ mid: "sq7xk2mn9p", mid_raw: "sq7xk2mn9p", agent_raw: "Other LLC", blockers: ["duplicate_mid_conflict"] });
    const [group] = reviewMerchantImport([a, b]).problems;
    expect(group.duplicates).toEqual([
      {
        mid: "SQ7XK2MN9P",
        rows: [
          { rowNumber: a.row_number, agent: "Quill Payments LLC", split: "0.5", processor: "TSYS", status: "Active", name: "Invented Merchant" },
          { rowNumber: b.row_number, agent: "Other LLC", split: "0.5", processor: "TSYS", status: "Active", name: "Invented Merchant" },
        ],
      },
    ]);
  });

  it("names a blank offending cell", () => {
    const [group] = reviewMerchantImport([row({ mid_raw: null, mid: null, blockers: ["missing_mid"] })]).problems;
    expect(group.values[0].value).toBe("(blank)");
  });
});

describe("rateLabel", () => {
  it("shows the rate, or that the rep's rate applies", () => {
    expect(rateLabel(row({ rate: 30 }))).toBe("30%");
    expect(rateLabel(row({ rate: null, split_raw: null }))).toBe("Rep's rate");
    expect(rateLabel(row({ rate: null, split_raw: "half" }))).toBe("half");
  });
});
