import { describe, expect, it } from "vitest";

import { safeNextPath } from "@/lib/safe-redirect";

const FALLBACK = "/fallback";

describe("safeNextPath — a same-origin path or the fallback (QA-001)", () => {
  const refused: Array<string | null | undefined> = [
    "https://evil.com",
    "//evil.com",
    "///evil.com",
    "/\\evil.com",
    "/\\/evil.com",
    "\\\\evil.com",
    "%2F%2Fevil.com",
    "/%2F/evil.com",
    "/%5Cevil.com",
    "javascript:alert(1)",
    "data:text/html,x",
    " //evil.com",
    "/\t/evil.com",
    "/%09/evil.com",
    "http:evil.com",
    "",
    null,
    // Beyond the brief: double encoding, newline, undefined.
    "/%252F/evil.com",
    "/%255Cevil.com",
    "/\n/evil.com",
    "/%0A/evil.com",
    undefined,
  ];

  it.each(refused.map((value) => [JSON.stringify(value), value]))(
    "falls back for %s",
    (_label, value) => {
      expect(safeNextPath(value, FALLBACK)).toBe(FALLBACK);
    },
  );

  const allowed = [
    "/leads/123?tab=a",
    "/ok?x=https://evil.com",
    "/proposals/new",
    // Not in the brief, worth pinning: an escaped `%` must not be refused just
    // because it cannot be decoded a second time.
    "/search?q=100%25",
    "/auth/update-password",
  ];

  it.each(allowed)("allows %s unchanged", (value) => {
    expect(safeNextPath(value, FALLBACK)).toBe(value);
  });
});
