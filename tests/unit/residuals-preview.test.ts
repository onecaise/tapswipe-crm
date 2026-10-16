import { describe, expect, it } from "vitest";

import {
  LOOKS_SHARED_MONTHS,
  lookbackStart,
  monthLabel,
  monthsBefore,
  previewSharedRow,
  previewUnsharedRow,
  shareCovering,
  sharePreviewNote,
  unsharedPreviewNote,
  type PaidLine,
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

describe("previewSharedRow ignores adjustment lines (20261016160000)", () => {
  it("does not take an adjustment on the signer's key for a foreign line", () => {
    const lines: PreviewLedgerLine[] = [
      { period: JUL, mid: "MID-1", agentId: SIGNER, repShareId: null, shareRole: null, lineKind: "adjustment" },
      { period: JUL, mid: "MID-1", agentId: PARTNER, repShareId: null, shareRole: null, lineKind: "adjustment" },
    ];
    expect(flag(row(SIGNER), lines)).toBeNull();
    // The same lines as import lines are foreign, as before.
    expect(flag(row(SIGNER), lines.map((l) => ({ ...l, lineKind: "import" })))).toBe("line_not_shared");
  });
});

describe("previewUnsharedRow (phase 5): share_not_in_force and looks_shared", () => {
  const OTHER = "other";
  const unshared = (r: ReturnType<typeof row>, shares: PreviewShare[], paid: PaidLine[] = []) =>
    previewUnsharedRow(r, shares, paid);

  it("is silent where a share covers the month (previewSharedRow speaks there)", () => {
    expect(unshared(row(THIRD), [SHARE], [{ period: JUL, mid: "MID-1", agentId: OTHER }])).toBeNull();
  });

  it("flags a share that has ended, or starts later, and names every share on the MID", () => {
    const ended = unshared(row(SIGNER, { period: SEP }), [SHARE]);
    expect(ended).toEqual({ flag: "share_not_in_force", shares: [SHARE] });
    const later = unshared(row(SIGNER, { period: "2026-06-01" }), [SHARE]);
    expect(later?.flag).toBe("share_not_in_force");
    // A share on another MID is not this MID's.
    expect(unshared(row(SIGNER, { mid: "MID-2" }), [SHARE])).toBeNull();
  });

  it("prefers share_not_in_force to looks_shared", () => {
    const result = unshared(row(SIGNER, { period: SEP }), [SHARE], [{ period: AUG, mid: "MID-1", agentId: OTHER }]);
    expect(result?.flag).toBe("share_not_in_force");
  });

  it("flags a MID another rep was paid on within six months before, or in, the row's month", () => {
    const at = (period: string): PaidLine => ({ period, mid: "MID-1", agentId: OTHER });
    // In the month itself (another row of the file, or a committed line).
    expect(unshared(row(SIGNER), [], [at(JUL)])?.flag).toBe("looks_shared");
    // Six months back is the edge, inside; seven is outside.
    expect(lookbackStart(JUL)).toBe("2026-01-01");
    expect(unshared(row(SIGNER), [], [at("2026-01-01")])?.flag).toBe("looks_shared");
    expect(unshared(row(SIGNER), [], [at("2025-12-01")])).toBeNull();
    // A LATER month is not a lookback.
    expect(unshared(row(SIGNER), [], [at(AUG)])).toBeNull();
  });

  it("is not fooled by the same rep, or by another MID", () => {
    expect(unshared(row(SIGNER), [], [{ period: JUL, mid: "MID-1", agentId: SIGNER }])).toBeNull();
    expect(unshared(row(SIGNER), [], [{ period: JUL, mid: "MID-2", agentId: OTHER }])).toBeNull();
  });

  it("never flags a blocked or unresolved row", () => {
    const paid = [{ period: JUL, mid: "MID-1", agentId: OTHER }];
    expect(unshared(row(SIGNER, { blocked: true }), [], paid)).toBeNull();
    expect(unshared(row(null), [], paid)).toBeNull();
    expect(unshared(row(SIGNER, { period: null }), [], paid)).toBeNull();
    expect(unshared(row(SIGNER, { mid: null }), [], paid)).toBeNull();
  });

  it("does month arithmetic across a year boundary, without Date", () => {
    expect(LOOKS_SHARED_MONTHS).toBe(6);
    expect(monthsBefore("2026-03-01", 6)).toBe("2025-09-01");
    expect(monthsBefore("2026-01-01", 1)).toBe("2025-12-01");
    expect(monthsBefore("2026-12-01", 12)).toBe("2025-12-01");
    expect(monthsBefore("2026-07-01", 0)).toBe("2026-07-01");
  });

  describe("unsharedPreviewNote", () => {
    const names: Record<string, string> = { [SIGNER]: "Ann Ito", [PARTNER]: "Bo Lee", [OTHER]: "Cy Day" };
    const context = { mid: "MID-1", period: SEP, fileRepName: "Ann Ito", hasMerchant: true, nameOf: (id: string) => names[id] ?? id };

    it("names the share and its range, and says the rep is paid the whole rep side", () => {
      expect(unsharedPreviewNote({ flag: "share_not_in_force", shares: [SHARE] }, context)).toBe(
        "MID MID-1 has a share (Ann Ito / Bo Lee, July 2026 to August 2026), but it does not cover September 2026. This row imports as an ordinary line paying Ann Ito the whole rep side.",
      );
      expect(
        unsharedPreviewNote({ flag: "share_not_in_force", shares: [{ ...SHARE, effectiveTo: null, effectiveFrom: "2026-11-01" }] }, context),
      ).toContain("(Ann Ito / Bo Lee, from November 2026)");
    });

    it("names the other reps once each, and gives the advice the merchant record allows", () => {
      const preview = {
        flag: "looks_shared" as const,
        others: [
          { period: JUL, mid: "MID-1", agentId: OTHER },
          { period: AUG, mid: "MID-1", agentId: OTHER },
        ],
      };
      expect(unsharedPreviewNote(preview, context)).toBe(
        "MID MID-1 is also paid to Cy Day within the six months to September 2026, and no share is set on it. This row imports for Ann Ito alone. If two reps share this account, set it on the merchant page before committing.",
      );
      expect(unsharedPreviewNote(preview, { ...context, hasMerchant: false })).toContain(
        "No merchant in the CRM has this MID, so a share cannot be set on it until one is added.",
      );
    });
  });
});
