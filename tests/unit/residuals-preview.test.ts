import { describe, expect, it } from "vitest";

import {
  monthLabel,
  monthsBefore,
  payeeChangedNote,
  previewUnsharedRow,
  previousPayees,
  shareCovering,
  unsharedPreviewNote,
  type LastMonthLine,
  type PreviewShare,
} from "../../supabase/functions/_shared/residuals";

/**
 * The shared-account preview notes parse-residual-import stores on each staged
 * row (phase 4b of docs/design/residual-splits.md, §7).
 *
 * v2's three share flags (share_not_applied, partner_named, line_not_shared)
 * and their tests went with v2 in phase 8 of docs/design/intake-and-reports.md:
 * under v3 a share's signer is the merchant's owner and the commit pays the
 * pair directly, so none can happen. What stays: shareCovering, the
 * share_not_in_force note and payee_changed.
 */

const SIGNER = "signer";
const PARTNER = "partner";
const THIRD = "third";
const JUL = "2026-07-01";
const AUG = "2026-08-01";
const SEP = "2026-09-01";

const SHARE: PreviewShare = {
  id: 7,
  mid: "MID-1",
  primaryAgentId: SIGNER,
  secondaryAgentId: PARTNER,
  effectiveFrom: JUL,
  effectiveTo: SEP,
};

const row = (agentId: string | null, over: Partial<{ period: string | null; mid: string | null; blocked: boolean }> = {}) => ({
  period: JUL,
  agentId,
  mid: "MID-1",
  blocked: false,
  ...over,
});


describe("shareCovering", () => {
  it("covers [from, to): the first month in, the last month out", () => {
    expect(shareCovering([SHARE], "MID-1", JUL)).toBe(SHARE);
    expect(shareCovering([SHARE], "MID-1", AUG)).toBe(SHARE);
    expect(shareCovering([SHARE], "MID-1", SEP)).toBeNull();
    expect(shareCovering([SHARE], "MID-1", "2026-06-01")).toBeNull();
  });

  it("an open-ended share covers every later month", () => {
    const open = { ...SHARE, effectiveTo: null };
    expect(shareCovering([open], "MID-1", "2031-01-01")).toBe(open);
  });

  it("matches on the MID", () => {
    expect(shareCovering([SHARE], "MID-2", JUL)).toBeNull();
  });

  it("matches the MID in any case (20261106140000): the share carries the merchant's spelling", () => {
    expect(shareCovering([SHARE], " mid-1 ", JUL)).toBe(SHARE);
    expect(previewUnsharedRow(row(SIGNER, { period: SEP, mid: "mid-1" }), [SHARE])?.flag).toBe("share_not_in_force");
  });
});

describe("monthLabel", () => {
  it("labels months", () => {
    expect(monthLabel("2026-01-01")).toBe("January 2026");
    expect(monthLabel("2026-12-01")).toBe("December 2026");
  });
});

describe("previewUnsharedRow (phase 5): share_not_in_force", () => {
  it("is silent where a share covers the month (the commit pays the pair there)", () => {
    expect(previewUnsharedRow(row(THIRD), [SHARE])).toBeNull();
  });

  it("flags a share that has ended, or starts later, and names every share on the MID", () => {
    const ended = previewUnsharedRow(row(SIGNER, { period: SEP }), [SHARE]);
    expect(ended).toEqual({ flag: "share_not_in_force", shares: [SHARE] });
    const later = previewUnsharedRow(row(SIGNER, { period: "2026-06-01" }), [SHARE]);
    expect(later?.flag).toBe("share_not_in_force");
    // A share on another MID is not this MID's.
    expect(previewUnsharedRow(row(SIGNER, { mid: "MID-2" }), [SHARE])).toBeNull();
  });

  it("never flags a blocked or unresolved row", () => {
    const ended = { period: SEP };
    expect(previewUnsharedRow(row(SIGNER, { ...ended, blocked: true }), [SHARE])).toBeNull();
    expect(previewUnsharedRow(row(null, ended), [SHARE])).toBeNull();
    expect(previewUnsharedRow(row(SIGNER, { period: null }), [SHARE])).toBeNull();
    expect(previewUnsharedRow(row(SIGNER, { ...ended, mid: null }), [SHARE])).toBeNull();
  });

  it("does month arithmetic across a year boundary, without Date", () => {
    expect(monthsBefore("2026-03-01", 6)).toBe("2025-09-01");
    expect(monthsBefore("2026-01-01", 1)).toBe("2025-12-01");
    expect(monthsBefore("2026-12-01", 12)).toBe("2025-12-01");
    expect(monthsBefore("2026-07-01", 0)).toBe("2026-07-01");
  });

  describe("unsharedPreviewNote", () => {
    const names: Record<string, string> = { [SIGNER]: "Ann Ito", [PARTNER]: "Bo Lee" };
    const context = { mid: "MID-1", period: SEP, ownerName: "Ann Ito", nameOf: (id: string) => names[id] ?? id };

    it("names the share and its range, and says the owner is paid the whole rep side", () => {
      expect(unsharedPreviewNote({ flag: "share_not_in_force", shares: [SHARE] }, context)).toBe(
        "MID MID-1 has a share (Ann Ito / Bo Lee, July 2026 to August 2026), but it does not cover September 2026. This row imports as an ordinary line paying Ann Ito the whole rep side.",
      );
      expect(
        unsharedPreviewNote({ flag: "share_not_in_force", shares: [{ ...SHARE, effectiveTo: null, effectiveFrom: "2026-11-01" }] }, context),
      ).toContain("(Ann Ito / Bo Lee, from November 2026)");
    });
  });
});

describe("payee_changed (memo A10): a MID that now pays a different rep than last month", () => {
  const line = (agentId: string, shareRole: string | null = null, mid = "MID-1"): LastMonthLine => ({
    mid,
    agentId,
    shareRole,
  });

  it("names last month's payee when the owner is someone else", () => {
    expect(previousPayees([line(THIRD)], "MID-1", SIGNER)).toEqual([THIRD]);
  });

  it("is silent when the owner was paid last month", () => {
    expect(previousPayees([line(SIGNER)], "MID-1", SIGNER)).toBeNull();
    expect(previousPayees([line(SIGNER, "primary"), line(PARTNER, "secondary")], "MID-1", SIGNER)).toBeNull();
  });

  it("is silent when the MID was not paid last month: nothing to compare", () => {
    expect(previousPayees([], "MID-1", SIGNER)).toBeNull();
    expect(previousPayees([line(THIRD, null, "MID-2")], "MID-1", SIGNER)).toBeNull();
  });

  it("does not count a partner's half of a shared pair as who the MID paid", () => {
    // The owner is the signer; last month's partner line names someone else
    // and must not raise the note on its own.
    expect(previousPayees([line(PARTNER, "secondary")], "MID-1", SIGNER)).toBeNull();
    // But a signer who is not the owner does.
    expect(previousPayees([line(THIRD, "primary"), line(PARTNER, "secondary")], "MID-1", SIGNER)).toEqual([THIRD]);
  });

  it("lists each previous payee once", () => {
    expect(previousPayees([line(THIRD), line(THIRD), line(PARTNER)], "MID-1", SIGNER)).toEqual([THIRD, PARTNER]);
  });

  it("says who it paid, who it pays now, and what to do", () => {
    expect(
      payeeChangedNote({ mid: "MID-1", period: JUL, previousNames: ["Ann Ito"], ownerName: "Bo Lee" }),
    ).toBe(
      "Last month (June 2026) MID MID-1 paid Ann Ito; this month it pays Bo Lee, the merchant's current owner. If moving the merchant was not meant to change who is paid, correct its owner before committing.",
    );
    expect(
      payeeChangedNote({ mid: "MID-1", period: "2026-01-01", previousNames: ["Zed", "Ann"], ownerName: "Bo" }),
    ).toMatch(/^Last month \(December 2025\) MID MID-1 paid Ann, Zed;/);
  });
});
