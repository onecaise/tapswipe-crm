import { describe, expect, it } from "vitest";

import {
  type DuplicateMatch,
  duplicateHref,
  ownMessage,
  redactedMessage,
  splitMatches,
} from "@/lib/duplicates";

function match(over: Partial<DuplicateMatch> = {}): DuplicateMatch {
  return {
    visibility: "own",
    record_type: "lead",
    record_id: 7,
    title: "Mine Diner",
    subtitle: "Ada Mine",
    matched_field: "contact_email",
    strength: "exact",
    ...over,
  };
}

const REDACTED: DuplicateMatch = {
  visibility: "redacted",
  record_type: "lead",
  record_id: null,
  title: null,
  subtitle: null,
  matched_field: "phone",
  strength: "exact",
};

describe("duplicateHref", () => {
  it("links each own-book record type to its detail page", () => {
    expect(duplicateHref(match({ record_type: "lead" }))).toBe("/leads/7");
    expect(duplicateHref(match({ record_type: "ghost_sheet" }))).toBe(
      "/ghost-sheets/7",
    );
    expect(duplicateHref(match({ record_type: "merchant" }))).toBe(
      "/merchants/7",
    );
  });

  it("returns null for a redacted row, which has nothing to link to", () => {
    // The guard that stops a future caller building `/leads/null`. record_id is
    // NULL from the function for every cross-book row, by construction.
    expect(duplicateHref(REDACTED)).toBeNull();
  });
});

describe("redactedMessage", () => {
  it("names the matched field and the escalation path, and nothing else", () => {
    const text = redactedMessage(REDACTED);

    expect(text).toContain("phone number");
    expect(text).toMatch(/admin/i);
  });

  it("says something different for a merchant", () => {
    // "already a customer" and "another rep is working it" are different
    // problems that happen to share an escalation path, and a rep who reads
    // the wrong one goes to the wrong conversation.
    const merchant = redactedMessage({
      ...REDACTED,
      record_type: "merchant",
      matched_field: "name",
      strength: "fuzzy",
    });

    expect(merchant).toMatch(/existing merchant/i);
    expect(merchant).toMatch(/similar/i);
  });

  it("hedges a fuzzy match and does not hedge an exact one", () => {
    expect(redactedMessage({ ...REDACTED, strength: "fuzzy" })).toMatch(
      /similar/i,
    );
    expect(redactedMessage({ ...REDACTED, strength: "exact" })).not.toMatch(
      /similar/i,
    );
  });

  it("cannot leak detail, because it is handed none", () => {
    // Belt and braces over the function's own redaction: even if a caller
    // passed a row with a title still attached, the sentence does not
    // interpolate it. The boundary is the RPC; this is the second lock.
    const text = redactedMessage({
      ...REDACTED,
      title: "Theirs Grill",
      subtitle: "Bob Theirs",
      record_id: 99,
    });

    expect(text).not.toContain("Theirs");
    expect(text).not.toContain("Bob");
    expect(text).not.toContain("99");
  });
});

describe("ownMessage", () => {
  it("distinguishes the same field from a similar one", () => {
    expect(ownMessage(match({ strength: "exact" }))).toMatch(/^Same /);
    expect(ownMessage(match({ strength: "fuzzy" }))).toMatch(/^Similar /);
  });

  it("names the record type so the rep knows where they are going", () => {
    expect(ownMessage(match({ record_type: "ghost_sheet" }))).toContain(
      "ghost sheet",
    );
    expect(ownMessage(match({ record_type: "merchant" }))).toContain(
      "merchant",
    );
  });
});

describe("splitMatches", () => {
  it("separates the two kinds, which are rendered completely differently", () => {
    const { own, redacted } = splitMatches([match(), REDACTED, match()]);

    expect(own).toHaveLength(2);
    expect(redacted).toHaveLength(1);
    expect(own.every((m) => m.record_id !== null)).toBe(true);
    expect(redacted.every((m) => m.record_id === null)).toBe(true);
  });

  it("handles an empty result, which is the common case", () => {
    expect(splitMatches([])).toEqual({ own: [], redacted: [] });
  });
});
