import { describe, expect, it } from "vitest";
import * as XLSX from "xlsx";

import {
  COLUMN_HEADERS,
  RESIDUAL_BLOCKERS,
  RESIDUAL_COLUMNS,
  blockerMessage,
  isResidualIncomeType,
  mapHeaders,
  midsInOtherBatches,
  monthsBefore,
  normalizeHeader,
  orderBlockers,
  parseMidCell,
  parseNumberCell,
  parseResidualSheet,
  pickBlocker,
  rowWarnings,
  sameProcessor,
} from "../../supabase/functions/_shared/residuals";

/**
 * The residual parser, phase 7 of docs/design/intake-and-reports.md: the
 * processor's six-column file (§0b.1, §1.G).
 *
 * Imported straight out of supabase/functions/_shared/ -- which works, and is
 * deliberate. That module is dependency-free precisely so it needs no deno.json
 * import map, and the same property lets Node import it. So the rules where all
 * the judgement lives are testable under vitest, with no Deno, no Docker and no
 * running stack. The workbook tests below build real XLSX bytes with the SAME
 * SheetJS build the function imports (cdn.sheetjs.com 0.20.3) and read them the
 * way parse-residual-import does, so the Merchant-Number-as-text rule is proven
 * through SheetJS, not only on hand-made cells.
 *
 * What these tests are really guarding, in order of how much a mistake would cost:
 *
 *   1. **A MID is text.** A numeric read drops leading zeros and can print a
 *      12-digit number in exponent form; either pays the wrong merchant, or
 *      refuses a right one.
 *   2. **The whole file is refused** on a non-Residuals income type, a repeated
 *      MID, a blank or unreadable figure -- every one listed.
 *   3. **A wrong number must be refused, not approximated.**
 */

const HEADER = RESIDUAL_COLUMNS.map((column) => COLUMN_HEADERS[column]);

/** A well-formed data row, so a test can vary one cell at a time. */
function row(overrides: Partial<Record<number, unknown>> = {}): unknown[] {
  const base: unknown[] = [
    "TSYS",
    "012345678901",
    "Joe's Diner",
    "Residuals",
    "$76,877.18",
    "$412.50",
  ];
  for (const [position, value] of Object.entries(overrides)) {
    base[Number(position)] = value;
  }
  return base;
}

function parsed(sheet: unknown[][], formatted?: unknown[][]) {
  const result = parseResidualSheet(sheet, formatted);
  if (!result.ok) throw new Error(`expected a parse, got: ${result.error}`);
  return result.rows;
}

/** Writes a sheet to XLSX bytes and reads it back the way the function does. */
function throughSheetJS(build: (sheet: XLSX.WorkSheet) => void, rows: unknown[][]) {
  const book = XLSX.utils.book_new();
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  build(sheet);
  XLSX.utils.book_append_sheet(book, sheet, "Residuals");
  const bytes = XLSX.write(book, { type: "buffer", bookType: "xlsx" }) as Buffer;
  const read = XLSX.read(new Uint8Array(bytes), { type: "array" });
  const first = read.Sheets[read.SheetNames[0]];
  const options = { header: 1 as const, defval: null, blankrows: true };
  return {
    raw: XLSX.utils.sheet_to_json(first, { ...options, raw: true }) as unknown[][],
    formatted: XLSX.utils.sheet_to_json(first, { ...options, raw: false }) as unknown[][],
  };
}

describe("the file format", () => {
  it("is exactly the six columns, in Owen's order", () => {
    expect(HEADER).toEqual([
      "Processor",
      "Merchant Number",
      "Merchant Name",
      "Income Type",
      "Volume",
      "Residual",
    ]);
  });
});

describe("mapHeaders: header tolerance", () => {
  it("matches the six names case-insensitively", () => {
    const { index, missing } = mapHeaders([
      "PROCESSOR",
      "merchant number",
      "Merchant name",
      "INCOME TYPE",
      "volume",
      "residual",
    ]);
    expect(missing).toEqual([]);
    expect(index.mid).toBe(1);
    expect(index.residual_income).toBe(5);
  });

  it("tolerates a leading BOM, a leading apostrophe and stray whitespace", () => {
    const { index, missing } = mapHeaders([
      "\uFEFFProcessor",
      "'Merchant Number",
      "  Merchant   Name  ",
      "\tIncome Type\n",
      "Volume ",
      " 'Residual ",
    ]);
    expect(missing).toEqual([]);
    expect(index).toEqual({
      processor: 0,
      mid: 1,
      merchant_name: 2,
      income_type: 3,
      volume: 4,
      residual_income: 5,
    });
  });

  it("is space-insensitive inside a name, and ignores a trailing colon", () => {
    expect(normalizeHeader("MerchantNumber")).toBe(normalizeHeader("Merchant Number"));
    expect(normalizeHeader("Income Type:")).toBe("incometype");
  });

  it("does not strip an apostrophe that is not leading", () => {
    expect(normalizeHeader("Merchant's Number")).not.toBe(normalizeHeader("Merchant Number"));
  });

  it("matches by name, so column order does not matter", () => {
    const { index, missing } = mapHeaders([...HEADER].reverse());
    expect(missing).toEqual([]);
    expect(index.processor).toBe(5);
  });

  it("names every required column a file is missing", () => {
    const { missing } = mapHeaders(["Processor", "Merchant Number"]);
    expect(missing).toEqual(["Merchant Name", "Income Type", "Volume", "Residual"]);
  });

  it("does not know the old headers: a MID or Period column is not a Merchant Number", () => {
    const { missing } = mapHeaders(["Period", "Agent #", "MID", "Merchant name", "Volume", "Residual income"]);
    expect(missing).toEqual(["Processor", "Merchant Number", "Income Type", "Residual"]);
  });

  it("reports a column given twice", () => {
    expect(mapHeaders([...HEADER, " volume "]).repeated).toEqual(["Volume"]);
  });

  it("spots the CRM's own export by Agent # or Rep payout", () => {
    expect(mapHeaders([...HEADER, "Agent #"]).crmExport).toBe(true);
    expect(mapHeaders([...HEADER, "rep payout"]).crmExport).toBe(true);
    expect(mapHeaders(HEADER).crmExport).toBe(false);
  });

  it("ignores other columns it does not recognise", () => {
    const { missing, index } = mapHeaders(["Notes", ...HEADER]);
    expect(missing).toEqual([]);
    expect(index.processor).toBe(1);
  });
});

describe("parseMidCell: the Merchant Number is text", () => {
  it("keeps a text MID exactly, leading zeros included", () => {
    expect(parseMidCell("012345678901")).toEqual({ mid: "012345678901", unreadable: null });
    expect(parseMidCell("00012345678")).toEqual({ mid: "00012345678", unreadable: null });
  });

  it("strips a leading apostrophe, a BOM and whitespace", () => {
    expect(parseMidCell("'012345678901")).toEqual({ mid: "012345678901", unreadable: null });
    expect(parseMidCell("\uFEFF 012345678901 ")).toEqual({ mid: "012345678901", unreadable: null });
    expect(parseMidCell("  ' 4400123456789 ")).toEqual({ mid: "4400123456789", unreadable: null });
  });

  it("writes a numeric 12-digit cell out digit for digit, never in exponent form", () => {
    // Excel's General format DISPLAYS 123456789012 as 1.23457E+11; that text
    // must not become the MID.
    expect(parseMidCell(123456789012, "1.23457E+11")).toEqual({ mid: "123456789012", unreadable: null });
    expect(parseMidCell(987654321098)).toEqual({ mid: "987654321098", unreadable: null });
    expect(parseMidCell(12345678901, "12345678901")).toEqual({ mid: "12345678901", unreadable: null });
  });

  it("takes a numeric cell's leading zeros from its displayed text", () => {
    // A "000000000000" number format is the only place they survive.
    expect(parseMidCell(12345678901, "012345678901")).toEqual({ mid: "012345678901", unreadable: null });
  });

  it("refuses what is not all digits, quoting the cell", () => {
    expect(parseMidCell("4400-1234-5678")).toEqual({ mid: null, unreadable: "4400-1234-5678" });
    expect(parseMidCell("MID-1")).toEqual({ mid: null, unreadable: "MID-1" });
    expect(parseMidCell(1234.5, "1234.5")).toEqual({ mid: null, unreadable: "1234.5" });
    expect(parseMidCell(-12345, "-12345")).toEqual({ mid: null, unreadable: "-12345" });
    expect(parseMidCell(2 ** 60, "1.15292E+18")).toEqual({ mid: null, unreadable: "1.15292E+18" });
  });

  it("treats a blank cell as no MID, not as unreadable", () => {
    expect(parseMidCell(null)).toEqual({ mid: null, unreadable: null });
    expect(parseMidCell("   ")).toEqual({ mid: null, unreadable: null });
    expect(parseMidCell("'")).toEqual({ mid: null, unreadable: null });
  });
});

describe("Merchant Number through a real workbook (SheetJS 0.20.3)", () => {
  it("keeps a text cell's leading zero, and a 12-digit text cell, exactly", () => {
    const { raw, formatted } = throughSheetJS(() => {}, [
      HEADER,
      row({ 1: "012345678901" }),
      row({ 1: "123456789012" }),
      row({ 1: "00001234567" }),
    ]);
    expect(parsed(raw, formatted).map((r) => r.mid_raw)).toEqual([
      "012345678901",
      "123456789012",
      "00001234567",
    ]);
  });

  it("reads a 12-digit NUMBER cell in General format as its digits", () => {
    const { raw, formatted } = throughSheetJS(() => {}, [HEADER, row({ 1: 123456789012 })]);
    // What SheetJS shows for it, so the test proves the fallback is needed.
    expect(typeof raw[1][1]).toBe("number");
    expect(parsed(raw, formatted)[0].mid_raw).toBe("123456789012");
  });

  it("recovers leading zeros from a zero-padded number format", () => {
    const { raw, formatted } = throughSheetJS(
      (sheet) => {
        sheet.B2.z = "000000000000";
        delete sheet.B2.w;
      },
      [HEADER, row({ 1: 12345678901 })],
    );
    expect(formatted[1][1]).toBe("012345678901");
    expect(parsed(raw, formatted)[0].mid_raw).toBe("012345678901");
  });

  it("reads currency text and negatives through the workbook too", () => {
    const { raw, formatted } = throughSheetJS(() => {}, [
      HEADER,
      row({ 4: "$76,877.18", 5: "-$11.76" }),
      row({ 1: "111111111111", 4: 0, 5: -3.2 }),
    ]);
    const rows = parsed(raw, formatted);
    expect(rows.map((r) => [r.volume, r.residual_income])).toEqual([
      [76877.18, -11.76],
      [0, -3.2],
    ]);
    expect(rows.every((r) => r.blockers.length === 0)).toBe(true);
  });
});

describe("parseNumberCell", () => {
  it("reads what Excel emits", () => {
    expect(parseNumberCell("12,400.00")).toEqual({ value: 12400, ok: true });
    expect(parseNumberCell("$310.00")).toEqual({ value: 310, ok: true });
    expect(parseNumberCell("  62.5  ")).toEqual({ value: 62.5, ok: true });
    expect(parseNumberCell("60%")).toEqual({ value: 60, ok: true });
    expect(parseNumberCell("$1,234,567.89")).toEqual({
      value: 1234567.89,
      ok: true,
    });
  });

  it("passes a real number through without the text handling", () => {
    // SheetJS gives a number for a numeric cell. Running that through the string
    // cleanup would mangle exponent notation — String(1e21) is "1e+21".
    expect(parseNumberCell(310)).toEqual({ value: 310, ok: true });
    expect(parseNumberCell(-18.5)).toEqual({ value: -18.5, ok: true });
  });

  it("reads accounting parentheses as negative", () => {
    expect(parseNumberCell("(1,234.56)")).toEqual({ value: -1234.56, ok: true });
    expect(parseNumberCell("($42.00)")).toEqual({ value: -42, ok: true });
  });

  it("reads a leading minus as negative", () => {
    // Clawbacks are real, and the columns that carry them are signed on purpose.
    expect(parseNumberCell("-18.50")).toEqual({ value: -18.5, ok: true });
  });

  it("treats blank as null and NOT as zero", () => {
    // The most consequential rule in this file. "Earned nothing" and "nobody has
    // filled this in" are different facts, and every total downstream depends on
    // keeping them apart.
    for (const blank of [null, undefined, "", "   ", "-", "—", "n/a", "N/A"]) {
      expect(parseNumberCell(blank), `${String(blank)} should be null`).toEqual({
        value: null,
        ok: true,
      });
    }
  });

  it("keeps a real zero as zero", () => {
    // The other half of the same rule: a zero someone typed is a figure.
    expect(parseNumberCell("0")).toEqual({ value: 0, ok: true });
    expect(parseNumberCell("$0.00")).toEqual({ value: 0, ok: true });
    expect(parseNumberCell(0)).toEqual({ value: 0, ok: true });
  });

  it("refuses text that is not a number", () => {
    for (const bad of ["twelve", "12.3.4", "1,2x0", "--5"]) {
      expect(parseNumberCell(bad), `${bad} should not parse`).toEqual({
        value: null,
        ok: false,
      });
    }
  });

  it("refuses the values Number() would happily accept", () => {
    // Number("0x10") is 16, Number("1e5") is 100000, Number("Infinity") is
    // Infinity. None of those is a figure a processor typed, and each would import
    // a number nobody can trace to the report.
    for (const bad of ["0x10", "1e5", "Infinity", "-Infinity", "NaN"]) {
      expect(parseNumberCell(bad), `${bad} should not parse`).toMatchObject({
        ok: false,
      });
    }
  });

  it("rounds to the cent, away from zero on a negative", () => {
    // Matching Postgres's round() on numeric, so a parsed figure and the generated
    // column agree.
    expect(parseNumberCell("10.005")).toEqual({ value: 10.01, ok: true });
    expect(parseNumberCell("-10.005")).toEqual({ value: -10.01, ok: true });
  });
});

describe("parseNumberCell: the processor file's currency formatting (§0b.1)", () => {
  it("reads currency with commas, and a minus before or after the sign", () => {
    expect(parseNumberCell("$76,877.18")).toEqual({ value: 76877.18, ok: true });
    expect(parseNumberCell("-$11.76")).toEqual({ value: -11.76, ok: true });
    expect(parseNumberCell("$-11.76")).toEqual({ value: -11.76, ok: true });
    expect(parseNumberCell("-$1,299.00")).toEqual({ value: -1299, ok: true });
    expect(parseNumberCell("1,234,567.89")).toEqual({ value: 1234567.89, ok: true });
  });

  it("refuses a decimal comma, saying why (D-10)", () => {
    expect(parseNumberCell("12,99")).toMatchObject({ value: null, ok: false });
    expect(parseNumberCell("12,99").problem).toMatch(/not a thousands separator/);
  });
});

describe("isResidualIncomeType", () => {
  it("accepts Residuals in any case, trimmed", () => {
    for (const ok of ["Residuals", "residuals", " RESIDUALS ", "\tResiduals"]) {
      expect(isResidualIncomeType(ok), ok).toBe(true);
    }
  });

  it("refuses everything else, blank and the singular included", () => {
    for (const bad of [null, "", "Residual", "Fees", "Residuals Adj", "Bonus"]) {
      expect(isResidualIncomeType(bad), String(bad)).toBe(false);
    }
  });
});

describe("pickBlocker and orderBlockers", () => {
  it("orders by the memo's precedence: identity first, figures last", () => {
    expect(RESIDUAL_BLOCKERS).toEqual([
      "missing_mid",
      "duplicate_mid",
      "unknown_mid",
      "mid_in_other_batch",
      "wrong_income_type",
      "missing_figure",
      "unreadable_number",
    ]);
    expect(orderBlockers(["unreadable_number", "unknown_mid", "wrong_income_type"])).toEqual([
      "unknown_mid",
      "wrong_income_type",
      "unreadable_number",
    ]);
    expect(pickBlocker(["missing_figure", "duplicate_mid"])).toBe("duplicate_mid");
    expect(pickBlocker([])).toBeNull();
  });
});

describe("blockerMessage", () => {
  it("names what to look at", () => {
    expect(blockerMessage("unknown_mid", { mid: "4400" })).toMatch(/MID 4400 is not a merchant in the CRM/);
    expect(blockerMessage("duplicate_mid", { mid: "4400", rows: [7, 31] })).toMatch(/appears on rows 7, 31/);
    expect(blockerMessage("wrong_income_type", { incomeType: "Fees" })).toMatch(/"Fees", not Residuals/);
    expect(blockerMessage("missing_mid", { midCell: "MID-1" })).toMatch(/"MID-1" is not a number/);
    expect(blockerMessage("mid_in_other_batch", { mid: "4400", period: "2026-07-01" })).toMatch(
      /line for July 2026 from another processor/,
    );
  });
});

describe("parseResidualSheet", () => {
  it("parses a clean sheet into staging rows", () => {
    const [only] = parsed([HEADER, row()]);
    expect(only).toEqual({
      row_number: 2,
      processor_raw: "TSYS",
      mid_raw: "012345678901",
      merchant_name_raw: "Joe's Diner",
      income_type_raw: "Residuals",
      volume_raw: "$76,877.18",
      residual_income_raw: "$412.50",
      volume: 76877.18,
      residual_income: 412.5,
      blockers: [],
      messages: {},
    });
  });

  it("fails the whole parse, naming every missing column and the six expected", () => {
    const result = parseResidualSheet([["Processor", "Merchant Number"], ["TSYS", "1"]]);
    expect(result).toEqual({
      ok: false,
      error:
        "That file is missing columns: Merchant Name, Income Type, Volume, Residual. A residual file has six: Processor, Merchant Number, Merchant Name, Income Type, Volume, Residual.",
    });
  });

  it("refuses a column given twice", () => {
    const result = parseResidualSheet([[...HEADER, "Residual"], [...row(), "1"]]);
    expect(result).toEqual({ ok: false, error: "That file has a column more than once: Residual." });
  });

  it("refuses the CRM's own export, before complaining about columns", () => {
    const result = parseResidualSheet([
      ["Period", "Agent #", "Agent", "MID", "Merchant name", "Volume", "Rep payout"],
      ["2026-07-01", "4471", "Ann", "MID-1", "Joe", 1, 1],
    ]);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toMatch(/looks like a CRM export, not a processor file/);
  });

  it("refuses a row whose Income Type is not Residuals, quoting what it says", () => {
    const rows = parsed([HEADER, row(), row({ 1: "2", 3: "Fees" }), row({ 1: "3", 3: null })]);
    expect(rows.map((r) => r.blockers)).toEqual([[], ["wrong_income_type"], ["wrong_income_type"]]);
    expect(rows[1].messages.wrong_income_type).toBe(
      'Income Type is "Fees", not Residuals. A residual file holds residuals only.',
    );
    expect(rows[1].income_type_raw).toBe("Fees");
  });

  it("refuses EVERY row of a repeated MID, the first one too, listing the rows", () => {
    const rows = parsed([HEADER, row(), row({ 1: "999" }), row(), row()]);
    expect(rows.map((r) => r.blockers)).toEqual([["duplicate_mid"], [], ["duplicate_mid"], ["duplicate_mid"]]);
    expect(rows[0].messages.duplicate_mid).toBe(
      "MID 012345678901 appears on rows 2, 4, 5. Fix the file and upload it again.",
    );
  });

  it("does not treat two MIDs that differ only by a leading zero as one", () => {
    const rows = parsed([HEADER, row({ 1: "012345678901" }), row({ 1: "12345678901" })]);
    expect(rows.map((r) => r.blockers)).toEqual([[], []]);
  });

  it("refuses a blank Volume or Residual as missing_figure, not as zero", () => {
    const rows = parsed([HEADER, row({ 4: null }), row({ 1: "2", 5: "" }), row({ 1: "3", 4: "-", 5: "N/A" })]);
    expect(rows.map((r) => r.blockers)).toEqual([["missing_figure"], ["missing_figure"], ["missing_figure"]]);
    expect(rows[2].messages.missing_figure).toBe("Volume and Residual are blank on this row.");
    expect(rows[0].volume).toBeNull();
  });

  it("refuses an unreadable figure, quoting the cell, and a decimal comma with its reason", () => {
    const rows = parsed([HEADER, row({ 4: "12abc" }), row({ 1: "2", 5: "12,99" })]);
    expect(rows.map((r) => r.blockers)).toEqual([["unreadable_number"], ["unreadable_number"]]);
    expect(rows[0].messages.unreadable_number).toBe('Volume "12abc" could not be read as a number.');
    expect(rows[1].messages.unreadable_number).toMatch(/^Residual "12,99" has a comma that is not a thousands separator/);
  });

  it("refuses a row with no MID or an unreadable one, quoting the cell", () => {
    const rows = parsed([HEADER, row({ 1: null }), row({ 1: "MID-7" })]);
    expect(rows.map((r) => r.blockers)).toEqual([["missing_mid"], ["missing_mid"]]);
    expect(rows[1].mid_raw).toBe("MID-7");
    expect(rows[1].messages.missing_mid).toMatch(/"MID-7"/);
  });

  it("lists every problem a row has, in precedence order", () => {
    const rows = parsed([HEADER, row({ 3: "Fees", 4: "x" }), row({ 3: "Fees", 5: null })]);
    expect(rows[0].blockers).toEqual(["duplicate_mid", "wrong_income_type", "unreadable_number"]);
    expect(rows[1].blockers).toEqual(["duplicate_mid", "wrong_income_type", "missing_figure"]);
  });

  it("does not block a negative residual or a zero volume: those are warnings", () => {
    const rows = parsed([HEADER, row({ 4: "$0.00", 5: "-$11.76" }), row({ 1: "2", 4: "-5", 5: "1" })]);
    expect(rows.map((r) => r.blockers)).toEqual([[], []]);
  });

  it("skips entirely blank rows instead of refusing them, keeping sheet row numbers", () => {
    const rows = parsed([HEADER, row(), [null, "", "  ", null, null, null], row({ 1: "2" })]);
    expect(rows.map((r) => r.row_number)).toEqual([2, 4]);
  });

  it("reports a header-only file and an empty one", () => {
    expect(parseResidualSheet([HEADER])).toEqual({ ok: false, error: "That file has a header but no data rows." });
    expect(parseResidualSheet([])).toEqual({ ok: false, error: "That file has no rows." });
  });

  it("does not read a month from the file: the batch has it", () => {
    const [only] = parsed([HEADER, row()]);
    expect("period" in only).toBe(false);
  });
});

describe("midsInOtherBatches (mid_in_other_batch)", () => {
  const lines = [
    { mid: "1", processor: "TSYS" },
    { mid: "2", processor: "Square" },
    { mid: "3", processor: null },
  ];

  it("counts another processor's line, and a line with NO processor, as another batch's", () => {
    expect([...midsInOtherBatches(lines, "TSYS")].sort()).toEqual(["2", "3"]);
  });

  it("does not count the batch's own processor", () => {
    expect(midsInOtherBatches([{ mid: "1", processor: "TSYS" }], "TSYS").size).toBe(0);
  });
});

describe("rowWarnings", () => {
  const base = {
    fileProcessor: "TSYS",
    batchProcessor: "TSYS",
    merchant: { status: "active", processor: "TSYS" },
    volume: 1000,
    residual: 50,
  };

  it("warns of nothing on a clean row", () => {
    expect(rowWarnings(base)).toEqual([]);
  });

  it("processor_mismatch: the file's Processor differs from the chosen one", () => {
    expect(rowWarnings({ ...base, fileProcessor: "Square" })).toEqual(["processor_mismatch"]);
    expect(rowWarnings({ ...base, fileProcessor: null })).toEqual(["processor_mismatch"]);
  });

  it("matches the file's Processor case- and space-insensitively", () => {
    expect(rowWarnings({ ...base, fileProcessor: " tsys " })).toEqual([]);
    expect(sameProcessor("Netevia  HQ", "Netevia HQ")).toBe(true);
    expect(sameProcessor("Red Fynn", "RedFynn")).toBe(false);
  });

  it("processor_mismatch: the merchant's saved processor differs", () => {
    expect(rowWarnings({ ...base, merchant: { status: "active", processor: "Square" } })).toEqual([
      "processor_mismatch",
    ]);
  });

  it("a merchant with NO saved processor is not a mismatch (A6)", () => {
    expect(rowWarnings({ ...base, merchant: { status: "active", processor: null } })).toEqual([]);
  });

  it("inactive_merchant: status inactive only, never 'other' (A26)", () => {
    expect(rowWarnings({ ...base, merchant: { status: "inactive", processor: null } })).toEqual(["inactive_merchant"]);
    expect(rowWarnings({ ...base, merchant: { status: "other", processor: null } })).toEqual([]);
  });

  it("bad_numbers: volume zero or less, or residual over volume", () => {
    expect(rowWarnings({ ...base, volume: 0, residual: 1.5 })).toEqual(["bad_numbers"]);
    expect(rowWarnings({ ...base, volume: 0, residual: -1.5 })).toEqual(["bad_numbers"]);
    expect(rowWarnings({ ...base, volume: -10, residual: 1 })).toEqual(["bad_numbers"]);
    expect(rowWarnings({ ...base, volume: 100, residual: 100.01 })).toEqual(["bad_numbers"]);
    expect(rowWarnings({ ...base, volume: 100, residual: 100 })).toEqual([]);
  });

  it("a clawback (negative residual on a positive volume) imports with no warning (A25)", () => {
    expect(rowWarnings({ ...base, volume: 500, residual: -11.76 })).toEqual([]);
  });

  it("needs both figures read for bad_numbers (a blank is a refusal instead)", () => {
    expect(rowWarnings({ ...base, volume: null, residual: 5 })).toEqual([]);
  });

  it("can carry all three at once", () => {
    expect(
      rowWarnings({
        fileProcessor: "Square",
        batchProcessor: "TSYS",
        merchant: { status: "inactive", processor: "TSYS" },
        volume: 0,
        residual: 0,
      }),
    ).toEqual(["processor_mismatch", "inactive_merchant", "bad_numbers"]);
  });
});

describe("monthsBefore", () => {
  it("steps back across a year", () => {
    expect(monthsBefore("2026-01-01", 1)).toBe("2025-12-01");
    expect(monthsBefore("2026-07-01", 1)).toBe("2026-06-01");
  });
});
