import { readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

import { SECURITY_HEADERS } from "@/lib/security-headers";

/**
 * Security fix phase 3. The values are pinned here; that a browser honours
 * them, on every kind of response, is e2e/security-headers.spec.ts.
 */
describe("SECURITY_HEADERS", () => {
  it("is exactly the four agreed headers", () => {
    expect(Object.fromEntries(SECURITY_HEADERS.map((h) => [h.key, h.value]))).toEqual({
      "X-Frame-Options": "DENY",
      "Content-Security-Policy": "frame-ancestors 'none'",
      "Referrer-Policy": "strict-origin-when-cross-origin",
      "X-Content-Type-Options": "nosniff",
    });
  });

  it("has a CSP that governs framing and nothing else", () => {
    const csp = SECURITY_HEADERS.find((h) => h.key === "Content-Security-Policy")!.value;
    expect(csp.split(";").map((d) => d.trim()).filter(Boolean)).toEqual(["frame-ancestors 'none'"]);
  });

  it("is applied to every path by next.config.ts", async () => {
    const config = await readFile("next.config.ts", "utf8");
    expect(config).toMatch(/import \{ SECURITY_HEADERS \} from "\.\/lib\/security-headers";/);
    expect(config).toMatch(/source: "\/:path\*", headers: \[\.\.\.SECURITY_HEADERS\]/);
  });
});
