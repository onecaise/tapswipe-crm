import { describe, expect, it } from "vitest";

import {
  monthLabel,
  previewSharedRow,
  shareCovering,
  sharePreviewNote,
  type PreviewLedgerLine,
  type PreviewShare,
} from "../../supabase/functions/_shared/residuals";

/**
 * The shared-account preview flags parse-residual-import stores on each staged
 * row (phase 4b of docs/design/residual-splits.md, §7).
 *
 * previewSharedRow() mirrors the plan CASE in commit_residual_import_v2, which
 * is the authority. This file pins the branches one at a time; the live suite
 * (tests/live/residual-import.test.ts) runs one file through both and requires
 * the flags to predict exactly what v2 skipped.
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

const flag = (r: ReturnType<typeof row>, ledger: PreviewLedgerLine[] = [], shares = [SHARE]) =>
  previewSharedRow(r, shares, ledger)?.flag ?? null;

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
});

describe("previewSharedRow", () => {
  it("flags nothing on a MID no share covers", () => {
    expect(flag(row(THIRD, { mid: "MID-2" }))).toBeNull();
    expect(flag(row(SIGNER, { period: SEP }))).toBeNull();
    expect(flag(row(SIGNER), [], [])).toBeNull();
  });

  it("flags nothing on the signer's row when the keys are clear: that is the shared case", () => {
    expect(flag(row(SIGNER))).toBeNull();
  });

  it("flags the signer's row clean against the share's own lines (a re-import)", () => {
    const own: PreviewLedgerLine[] = [
      { period: JUL, mid: "MID-1", agentId: SIGNER, repShareId: 7, shareRole: "primary" },
      { period: JUL, mid: "MID-1", agentId: PARTNER, repShareId: 7, shareRole: "secondary" },
    ];
    expect(flag(row(SIGNER), own)).toBeNull();
  });

  it("partner_named: the file names the partner", () => {
    expect(flag(row(PARTNER))).toBe("partner_named");
  });

  it("share_not_applied: the file names a rep outside the pair", () => {
    expect(flag(row(THIRD))).toBe("share_not_applied");
  });

  it.each<[string, PreviewLedgerLine]>([
    ["an unshared signer line", { period: JUL, mid: "MID-1", agentId: SIGNER, repShareId: null, shareRole: null }],
    ["an unshared partner line", { period: JUL, mid: "MID-1", agentId: PARTNER, repShareId: null, shareRole: null }],
    ["another share's line", { period: JUL, mid: "MID-1", agentId: SIGNER, repShareId: 99, shareRole: "primary" }],
    ["this share in the wrong role", { period: JUL, mid: "MID-1", agentId: SIGNER, repShareId: 7, shareRole: "secondary" }],
  ])("line_not_shared: the signer's row when a key holds %s", (_label, line) => {
    expect(flag(row(SIGNER), [line])).toBe("line_not_shared");
  });

  it("ignores ledger lines in another month, on another MID, or for a third rep", () => {
    const lines: PreviewLedgerLine[] = [
      { period: AUG, mid: "MID-1", agentId: SIGNER, repShareId: null, shareRole: null },
      { period: JUL, mid: "MID-2", agentId: SIGNER, repShareId: null, shareRole: null },
      { period: JUL, mid: "MID-1", agentId: THIRD, repShareId: null, shareRole: null },
    ];
    expect(flag(row(SIGNER), lines)).toBeNull();
  });

  it("never flags a blocked or unresolved row", () => {
    expect(flag(row(PARTNER, { blocked: true }))).toBeNull();
    expect(flag(row(null))).toBeNull();
    expect(flag(row(PARTNER, { period: null }))).toBeNull();
    expect(flag(row(PARTNER, { mid: null }))).toBeNull();
  });
});

describe("sharePreviewNote", () => {
  const context = {
    mid: "MID-1",
    period: JUL,
    signerName: "Ann Ito",
    partnerName: "Bo Lee",
    fileRepName: "Cy Day",
  };

  it("says a share was not applied, and for whom the row imports", () => {
    expect(sharePreviewNote({ flag: "share_not_applied", share: SHARE }, context)).toBe(
      "Share Ann Ito / Bo Lee not applied to MID MID-1 for July 2026: the file names Cy Day. This row imports as an ordinary line for Cy Day.",
    );
  });

  it("says a skipped row will be skipped", () => {
    for (const f of ["partner_named", "line_not_shared"] as const) {
      expect(sharePreviewNote({ flag: f, share: SHARE }, context)).toContain("This row will be skipped");
    }
  });

  it("labels months", () => {
    expect(monthLabel("2026-01-01")).toBe("January 2026");
    expect(monthLabel("2026-12-01")).toBe("December 2026");
  });
});
