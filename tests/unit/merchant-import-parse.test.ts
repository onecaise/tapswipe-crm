import { describe, expect, it } from "vitest";

import {
  MAX_IMPORT_ROWS,
  csvCells,
  mapHeaders,
  normText,
  parseMerchantSheet,
  parseMidCell,
  parseSplit,
  sniffSource,
  validateMerchantRows,
  type ImportProfile,
  type Lookups,
  type RawMerchantRow,
} from "../../supabase/functions/_shared/merchant-imports.ts";

/**
 * The merchant import's parser and staging checks (phase 14 of
 * docs/design/intake-and-reports.md). Every name, MID and rep below is
 * invented. The commit's SQL twin is pinned to this by
 * tests/rls/merchant-import.test.ts.
 */

const HEADER = "#,Type,Merchant ID,Merchant Name,Split,Agent,Processor,Added By,Override Agent,Status";

const REP_A: ImportProfile = {
  id: "aaaaaaaa-0000-0000-0000-000000000001",
  full_name: "Avery Quill",
  llc_legal_name: "Quill Payments LLC",
  role: "agent",
  is_active: true,
  split_rate_pct: 50,
};
const REP_B: ImportProfile = {
  id: "aaaaaaaa-0000-0000-0000-000000000002",
  full_name: "Bram Tolliver",
  // No LLC: the LLC field holds the rep's own legal name (A16).
  llc_legal_name: "Bram  Tolliver",
  role: "agent",
  is_active: true,
  split_rate_pct: 40,
};
const INACTIVE: ImportProfile = {
  id: "aaaaaaaa-0000-0000-0000-000000000003",
  full_name: "Cass Wren",
  llc_legal_name: "Wren Merchant Group",
  role: "agent",
  is_active: false,
  split_rate_pct: 50,
};
const TWIN_1: ImportProfile = {
  id: "aaaaaaaa-0000-0000-0000-000000000004",
  full_name: "Dell Okafor",
  llc_legal_name: "Okafor Ventures",
  role: "agent",
  is_active: true,
  split_rate_pct: 50,
};
const TWIN_2: ImportProfile = { ...TWIN_1, id: "aaaaaaaa-0000-0000-0000-000000000005", full_name: "Dell Okafor Jr" };
const ADMIN: ImportProfile = {
  id: "aaaaaaaa-0000-0000-0000-000000000006",
  full_name: "Esme Admin",
  llc_legal_name: "Esme Holdings",
  role: "admin",
  is_active: true,
  split_rate_pct: 50,
};

const LOOKUPS: Lookups = {
  profiles: [REP_A, REP_B, INACTIVE, TWIN_1, TWIN_2, ADMIN],
  processors: [
    { code: "TSYS", label: "TSYS" },
    { code: "Netevia HQ", label: "Netevia HQ" },
    { code: "Square", label: "Square" },
    { code: "365 Pay", label: "365 Pay" },
  ],
  existingMids: ["555000111222", "SQEXISTING01"],
};

function row(overrides: Partial<RawMerchantRow> = {}, n = 2): RawMerchantRow {
  return {
    row_number: n,
    type_raw: "MERCHANT",
    mid_raw: "400100200300",
    mid_source: "text",
    name_raw: "Fernwood Bakery",
    split_raw: "0.5",
    agent_raw: "Quill Payments LLC",
    processor_raw: "TSYS",
    status_raw: "Active",
    ...overrides,
  };
}

const one = (overrides: Partial<RawMerchantRow> = {}) =>
  validateMerchantRows([row(overrides)], LOOKUPS)[0];

describe("headers", () => {
  it("normalises non-breaking spaces and their mojibake, case and spacing", () => {
    const map = mapHeaders([
      "#",
      " TYPE ",
      "MerchantÂ ID",
      "merchant  name",
      "Split",
      "﻿Agent",
      "Processor",
      "Added By",
      "Override Agent",
      "status",
    ]);
    expect(map.missing).toEqual([]);
    expect(map.index).toEqual({ type: 1, mid: 2, name: 3, split: 4, agent: 5, processor: 6, status: 9 });
  });

  it("refuses the file when a column is missing, naming it", () => {
    const result = parseMerchantSheet(csvCells("Type,Merchant ID,Merchant Name,Split,Agent,Status\nMERCHANT,1,a,0.5,b,Active"));
    expect(result).toEqual({ ok: false, error: expect.stringContaining("missing the column Processor") });
  });

  it("refuses a repeated column", () => {
    const result = parseMerchantSheet(csvCells(`${HEADER},Split\nMERCHANT`));
    expect(result).toEqual({ ok: false, error: expect.stringContaining("Split more than once") });
  });

  it("ignores #, Added By and Override Agent", () => {
    const result = parseMerchantSheet(
      csvCells(`${HEADER}\n1,MERCHANT,400100200300,Fernwood Bakery,0.5,Quill Payments LLC,TSYS,Someone,Somebody Else,Active`),
    );
    expect(result.ok && result.rows[0]).toEqual(row());
  });
});

describe("cells and rows", () => {
  it("reads every CSV cell as text, MIDs included, and keeps the spreadsheet row numbers", () => {
    const result = parseMerchantSheet(
      csvCells(`${HEADER}\n1,MERCHANT,000123456789,A,0.5,Quill Payments LLC,,x,,Active\n,,,,,,,,,\n2,MERCHANT,SQ7XK2MN9P,B,,Quill Payments LLC,Square,x,,Active`),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows.map((r) => [r.row_number, r.mid_raw, r.mid_source])).toEqual([
      [2, "000123456789", "text"],
      [4, "SQ7XK2MN9P", "text"],
    ]);
  });

  it("strips a BOM and handles quoted commas", () => {
    const result = parseMerchantSheet(
      csvCells(`﻿${HEADER}\r\n1,MERCHANT,400100200300,"Fernwood Bakery, Inc.",0.5,Quill Payments LLC,TSYS,,,Active\r\n`),
    );
    expect(result.ok && result.rows[0].name_raw).toBe("Fernwood Bakery, Inc.");
  });

  it("refuses an empty file, a header with nothing under it, and more than the row cap", () => {
    expect(parseMerchantSheet(csvCells(""))).toEqual({ ok: false, error: "That file is empty." });
    expect(parseMerchantSheet(csvCells(HEADER)).ok).toBe(false);
    const many = Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, i) => `${i},MERCHANT,${400000000000 + i},N,,Quill Payments LLC,,,,Active`);
    expect(parseMerchantSheet(csvCells([HEADER, ...many].join("\n")))).toEqual({
      ok: false,
      error: expect.stringContaining("at most 2000"),
    });
  });

  it("normText collapses whitespace, non-breaking spaces and the mojibake pair", () => {
    expect(normText("  Quill  PaymentsÂ LLC \t")).toBe("Quill Payments LLC");
    expect(normText("   ")).toBeNull();
  });

  it("sniffs XLSX, old XLS and text (UTF-8, else Windows-1252)", () => {
    expect(sniffSource(new Uint8Array([0x50, 0x4b, 0x03, 0x04, 1]))).toEqual({ kind: "xlsx" });
    expect(sniffSource(new Uint8Array([0xd0, 0xcf, 0x11, 0xe0]))).toEqual({ kind: "xls" });
    expect(sniffSource(new TextEncoder().encode("Café"))).toEqual({ kind: "csv", text: "Café" });
    expect(sniffSource(new Uint8Array([0x43, 0x61, 0x66, 0xe9]))).toEqual({ kind: "csv", text: "Café" });
  });
});

describe("Merchant ID", () => {
  it("keeps a text MID as written, trimmed, leading zeros and letters included", () => {
    expect(parseMidCell(" 000123456789 ")).toEqual({ text: "000123456789", source: "text" });
    expect(parseMidCell("SQ7XK2MN9P")).toEqual({ text: "SQ7XK2MN9P", source: "text" });
  });

  it("accepts a whole spreadsheet number of 15 digits or fewer, noting lost leading zeros", () => {
    expect(parseMidCell(123456789012345, "123456789012345")).toEqual({ text: "123456789012345", source: "number" });
    expect(one({ mid_raw: "123456789012", mid_source: "number" }).notes).toContain("mid_from_number");
  });

  it("refuses a spreadsheet number that may have lost digits: over 15 digits, a float, exponent form", () => {
    expect(parseMidCell(1234567890123456).source).toBe("unsafe_number");
    expect(parseMidCell(4001002003.5).source).toBe("unsafe_number");
    expect(parseMidCell(400100200300, "4.001E+11")).toEqual({ text: "4.001E+11", source: "unsafe_number" });
    expect(one({ mid_raw: "4.001E+11", mid_source: "unsafe_number" }).blockers).toEqual(["mid_precision"]);
  });

  it("refuses text that a spreadsheet has turned into a number", () => {
    expect(one({ mid_raw: "4.00100E+11" }).blockers).toEqual(["mid_precision"]);
    expect(one({ mid_raw: "400100200300.0" }).blockers).toEqual(["mid_precision"]);
  });

  it("refuses a blank MID, one shorter than 6 or longer than 20, and one with other characters", () => {
    expect(one({ mid_raw: null }).blockers).toEqual(["missing_mid"]);
    expect(one({ mid_raw: "12345" }).blockers).toEqual(["invalid_mid"]);
    expect(one({ mid_raw: "1".repeat(21) }).blockers).toEqual(["invalid_mid"]);
    expect(one({ mid_raw: "4001-0020" }).blockers).toEqual(["invalid_mid"]);
    expect(one({ mid_raw: "123456" }).blockers).toEqual([]);
    expect(one({ mid_raw: "A".repeat(20) }).blockers).toEqual([]);
  });
});

describe("name, type and status", () => {
  it("trims and collapses the name; blank refuses; over 200 refuses", () => {
    expect(one({ name_raw: "  Fernwood   Bakery " }).name).toBe("Fernwood Bakery");
    expect(one({ name_raw: " " }).blockers).toEqual(["missing_name"]);
    expect(one({ name_raw: "N".repeat(201) }).blockers).toEqual(["invalid_name"]);
  });

  it("accepts Type MERCHANT in any case and refuses anything else", () => {
    expect(one({ type_raw: " merchant " }).blockers).toEqual([]);
    expect(one({ type_raw: "AGENT" }).blockers).toEqual(["invalid_type"]);
    expect(one({ type_raw: null }).blockers).toEqual(["invalid_type"]);
  });

  it("maps Active and Inactive and refuses anything else", () => {
    expect(one({ status_raw: "ACTIVE " }).status).toBe("active");
    expect(one({ status_raw: "inactive" }).status).toBe("inactive");
    expect(one({ status_raw: "Closed" }).blockers).toEqual(["invalid_status"]);
    expect(one({ status_raw: null }).blockers).toEqual(["invalid_status"]);
  });
});

describe("Split", () => {
  it("reads 0 to 1 as a fraction and a percent sign as a percentage", () => {
    expect(parseSplit("0.5")).toMatchObject({ kind: "rate", rate: 50 });
    expect(parseSplit("0.3")).toMatchObject({ kind: "rate", rate: 30 });
    expect(parseSplit(".25")).toMatchObject({ kind: "rate", rate: 25 });
    expect(parseSplit("0")).toMatchObject({ kind: "rate", rate: 0 });
    expect(parseSplit("0.4625")).toMatchObject({ kind: "rate", rate: 46.25 });
    expect(parseSplit("30%")).toMatchObject({ kind: "rate", rate: 30 });
    expect(parseSplit("12.5 %")).toMatchObject({ kind: "rate", rate: 12.5 });
  });

  it("blank is blank, which takes the owner's profile rate with a note", () => {
    expect(parseSplit("  ")).toEqual({ kind: "blank", value: null });
    const staged = one({ agent_raw: "Bram Tolliver", split_raw: null });
    expect(staged.blockers).toEqual([]);
    expect(staged.rate).toBeNull();
    expect(staged.notes).toEqual(["rate_from_profile"]);
  });

  it("refuses anything else: a bare whole number, words, a negative, a fraction above 1, beyond hundredths", () => {
    for (const bad of ["30", "half", "-0.5", "1.5", "0.12345", "12.345%", "50 percent"]) {
      expect(parseSplit(bad).kind, bad).toBe("invalid");
      expect(one({ split_raw: bad }).blockers, bad).toEqual(["invalid_split"]);
    }
  });

  it("refuses above 50 percent", () => {
    expect(parseSplit("1")).toMatchObject({ kind: "above_50", rate: 100 });
    expect(parseSplit("50.01%")).toMatchObject({ kind: "above_50" });
    expect(one({ split_raw: "0.6" }).blockers).toEqual(["split_above_50"]);
    expect(one({ split_raw: "50%" }).blockers).toEqual([]);
  });

  it("notes a rate that differs from the owner's profile rate, and never refuses for it", () => {
    const staged = one({ agent_raw: "Bram Tolliver", split_raw: "0.5" });
    expect(staged.blockers).toEqual([]);
    expect(staged.notes).toEqual(["rate_differs"]);
    expect(one({ split_raw: "0.5" }).notes).toEqual([]);
  });
});

describe("Agent", () => {
  it("matches the LLC legal name case-insensitively, trimmed, inner spaces collapsed", () => {
    expect(one({ agent_raw: "  quill   PAYMENTS llc " }).owner_id).toBe(REP_A.id);
    // A rep with no LLC holds their own legal name there (A16), stored here
    // with a double space.
    expect(one({ agent_raw: "Bram Tolliver " }).owner_id).toBe(REP_B.id);
  });

  it("refuses unknown, ambiguous, inactive, not-a-rep and blank", () => {
    expect(one({ agent_raw: "Quill Payment LLC" }).blockers).toEqual(["unknown_agent"]);
    expect(one({ agent_raw: "Okafor Ventures" }).blockers).toEqual(["ambiguous_agent"]);
    expect(one({ agent_raw: "Wren Merchant Group" }).blockers).toEqual(["inactive_agent"]);
    expect(one({ agent_raw: "Esme Holdings" }).blockers).toEqual(["agent_not_rep"]);
    expect(one({ agent_raw: null }).blockers).toEqual(["missing_agent"]);
  });
});

describe("Processor", () => {
  it("matches the list case-insensitively, trimmed; blank stays empty (A6)", () => {
    expect(one({ processor_raw: " netevia   hq " }).processor).toBe("Netevia HQ");
    expect(one({ processor_raw: "365 PAY" }).processor).toBe("365 Pay");
    expect(one({ processor_raw: null })).toMatchObject({ processor: null, blockers: [] });
  });

  it("refuses an unknown name", () => {
    expect(one({ processor_raw: "Fiserv Nova" }).blockers).toEqual(["unknown_processor"]);
  });
});

describe("one merchant per MID", () => {
  it("merges a repeat with the same owner and rate: first non-blank processor, first name, with notes", () => {
    const staged = validateMerchantRows(
      [
        row({ processor_raw: null, name_raw: "Fernwood Bakery" }, 2),
        row({ mid_raw: "400100200300 ", processor_raw: "TSYS", name_raw: "Fernwood Bakery #2", split_raw: "50%" }, 3),
      ],
      LOOKUPS,
    );
    expect(staged.map((r) => r.blockers)).toEqual([[], []]);
    expect(staged[0]).toMatchObject({ merged_into: null, processor: "TSYS", name: "Fernwood Bakery" });
    expect(staged[1]).toMatchObject({ merged_into: 2, notes: ["merged", "name_differs"] });
  });

  it("treats a blank Split and the same explicit rate as the same rate", () => {
    const staged = validateMerchantRows([row({ split_raw: null }, 2), row({ split_raw: "0.5" }, 3)], LOOKUPS);
    expect(staged.map((r) => r.blockers)).toEqual([[], []]);
  });

  it("matches MIDs case-insensitively", () => {
    const staged = validateMerchantRows([row({ mid_raw: "sq7xk2mn9p" }, 2), row({ mid_raw: "SQ7XK2MN9P" }, 3)], LOOKUPS);
    expect(staged[1].merged_into).toBe(2);
  });

  it("refuses every row of a repeat with a different owner, rate or status", () => {
    for (const other of [{ agent_raw: "Bram Tolliver" }, { split_raw: "0.3" }, { status_raw: "Inactive" }]) {
      const staged = validateMerchantRows([row({}, 2), row({}, 3), row(other, 7)], LOOKUPS);
      expect(staged.map((r) => r.blockers.includes("duplicate_mid_conflict")), JSON.stringify(other)).toEqual([true, true, true]);
    }
  });

  it("refuses two different non-blank processors", () => {
    const staged = validateMerchantRows([row({ processor_raw: "TSYS" }, 2), row({ processor_raw: "Square" }, 3)], LOOKUPS);
    expect(staged.map((r) => r.blockers)).toEqual([["duplicate_mid_processor"], ["duplicate_mid_processor"]]);
  });

  it("refuses a MID already on a merchant, case-insensitively", () => {
    expect(one({ mid_raw: "555000111222" }).blockers).toEqual(["mid_exists"]);
    expect(one({ mid_raw: "sqexisting01" }).blockers).toEqual(["mid_exists"]);
  });
});
