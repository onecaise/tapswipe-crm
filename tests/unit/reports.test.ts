import { describe, expect, it } from "vitest";

import { NAV_GROUPS } from "@/lib/nav";
import {
  DEDUCTIONS_HEADER,
  REPORT_TABS,
  parseReportFilters,
  reportsHref,
} from "@/lib/reports";

/**
 * The reports page's URL handling and its nav entry (phase 12 of
 * docs/design/intake-and-reports.md). The figures are the SQL functions'
 * (tests/rls/reports.test.ts); this file pins what the page does with its
 * address: a default month, a range, a processor, and refusals that never
 * show another month's figures.
 */

const LATEST = "2026-07-01";
const CODES = ["TSYS", "Square"];

describe("parseReportFilters", () => {
  it("defaults to Report 1, the latest committed month, every processor", () => {
    expect(parseReportFilters({}, LATEST, CODES)).toEqual({
      ok: true,
      filters: { report: "reps", from: LATEST, to: LATEST, processor: null },
    });
  });

  it("reads a range, a processor and the merchants tab", () => {
    expect(parseReportFilters(
      { report: "merchants", from: "2026-05", to: "2026-07", processor: "Square" }, LATEST, CODES,
    )).toEqual({
      ok: true,
      filters: { report: "merchants", from: "2026-05-01", to: "2026-07-01", processor: "Square" },
    });
  });

  it("takes `to` as `from` when only `from` is given", () => {
    const result = parseReportFilters({ from: "2026-03" }, LATEST, CODES);
    expect(result.ok && result.filters.to).toBe("2026-03-01");
  });

  it("an unknown tab is Report 1", () => {
    const result = parseReportFilters({ report: "nope" }, LATEST, CODES);
    expect(result.ok && result.filters.report).toBe("reps");
  });

  it.each([
    [{ from: "2026-13" }, "first month"],
    [{ from: "July" }, "first month"],
    [{ from: "2026-07", to: "2026-7" }, "last month"],
    [{ from: "2026-07", to: "2026-06" }, "after the last"],
    [{ processor: "Nope" }, "not a processor"],
  ])("refuses %j rather than showing another selection", (params, words) => {
    const result = parseReportFilters(params, LATEST, CODES);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain(words);
  });
});

describe("reportsHref", () => {
  it("round-trips through parseReportFilters", () => {
    for (const filters of [
      { report: "reps" as const, from: "2026-07-01", to: "2026-07-01", processor: null },
      { report: "merchants" as const, from: "2026-05-01", to: "2026-07-01", processor: "TSYS" },
    ]) {
      const href = reportsHref(filters);
      const params = Object.fromEntries(new URL(href, "http://x").searchParams);
      expect(parseReportFilters(params, LATEST, CODES)).toEqual({ ok: true, filters });
    }
  });

  it("says one month once, and leaves Report 1's tab implicit", () => {
    expect(reportsHref({ report: "reps", from: "2026-07-01", to: "2026-07-01", processor: null }))
      .toBe("/admin/reports?from=2026-07");
  });
});

describe("the page's words and nav entry", () => {
  it("labels deductions as not in the total (§0c.1)", () => {
    expect(DEDUCTIONS_HEADER).toBe("Deductions (info only, not in total)");
  });

  it("has the two tabs", () => {
    expect(REPORT_TABS.map((t) => t.value)).toEqual(["reps", "merchants"]);
  });

  it("the Reports nav item is in the Admin group and admin-only", () => {
    const admin = NAV_GROUPS.find((g) => g.label === "Admin")!;
    expect(admin.items.find((i) => i.href === "/admin/reports")).toMatchObject({
      label: "Reports",
      adminOnly: true,
    });
    const elsewhere = NAV_GROUPS.filter((g) => g !== admin)
      .flatMap((g) => g.items)
      .filter((i) => i.href === "/admin/reports");
    expect(elsewhere).toEqual([]);
  });
});
