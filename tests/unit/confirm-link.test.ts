import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { CONFIRM_LINK_TYPES, continueUrl, parseConfirmLink } from "@/lib/confirm-link";

/**
 * Phase 7: the rules for an email link to /auth/confirm. The browser-level
 * attack and its refusals are in e2e/qa/auth-confirm-csrf.spec.ts; this pins
 * the parsing, and that the GET handler cannot verify anything.
 */

const q = (query: string) => new URLSearchParams(query);
const root = path.resolve(import.meta.dirname, "../..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");
/** Source without comments, so a comment naming verifyOtp is not code calling it. */
const code = (file: string) =>
  read(file)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");

describe("parseConfirmLink", () => {
  it("accepts exactly the one type the app sends", () => {
    expect([...CONFIRM_LINK_TYPES]).toEqual(["recovery"]);
  });

  it("parses a recovery link with its next", () => {
    expect(parseConfirmLink(q("token_hash=abc&type=recovery&next=/auth/update-password"))).toEqual({
      ok: true,
      link: { tokenHash: "abc", type: "recovery", next: "/auth/update-password" },
    });
  });

  it("sends a recovery link with no next to the reset form", () => {
    const parsed = parseConfirmLink(q("token_hash=abc&type=recovery"));
    expect(parsed.ok && parsed.link.next).toBe("/auth/update-password");
  });

  it.each(["https://example.com", "//example.com", "/\\example.com", "/%2F/example.com"])(
    "replaces an off-site next (%s) with the reset form",
    (next) => {
      const parsed = parseConfirmLink(q(`token_hash=abc&type=recovery&next=${encodeURIComponent(next)}`));
      expect(parsed.ok && parsed.link.next).toBe("/auth/update-password");
    },
  );

  it.each(["magiclink", "invite", "signup", "email", "email_change", "RECOVERY", "recovery "])(
    "refuses type=%s as unsupported",
    (type) => {
      expect(parseConfirmLink(q(`token_hash=abc&type=${encodeURIComponent(type)}`))).toEqual({
        ok: false,
        error: "link-unsupported",
      });
    },
  );

  it.each(["type=recovery", "token_hash=abc", "token_hash=&type=recovery", ""])(
    "calls %j incomplete",
    (query) => {
      expect(parseConfirmLink(q(query))).toEqual({ ok: false, error: "link-incomplete" });
    },
  );

  it("reads a form the same way as a query", () => {
    const form = new FormData();
    form.set("token_hash", "abc");
    form.set("type", "magiclink");
    expect(parseConfirmLink(form)).toEqual({ ok: false, error: "link-unsupported" });
  });

  it("builds the Continue URL with every value encoded", () => {
    expect(continueUrl({ tokenHash: "a&b", type: "recovery", next: "/leads?status=new" })).toBe(
      "/auth/confirm/continue?token_hash=a%26b&type=recovery&next=%2Fleads%3Fstatus%3Dnew",
    );
  });
});

describe("where the token is exchanged", () => {
  it("the GET handler never verifies and exports no other method", () => {
    const route = code("app/auth/confirm/route.ts");
    expect(route).not.toMatch(/verifyOtp|exchangeCodeForSession|createClient/);
    expect(route).toMatch(/export async function GET\(/);
    expect(route).not.toMatch(/export (async )?function (POST|PUT|PATCH|DELETE)\b/);
  });

  it("only the Server Action verifies, and it checks Sec-Fetch-Site and re-parses the form", () => {
    const action = read("app/auth/confirm/continue/actions.ts");
    expect(action.startsWith('"use server";')).toBe(true);
    expect(action).toMatch(/verifyOtp/);
    expect(action).toMatch(/sec-fetch-site/);
    expect(action).toMatch(/parseConfirmLink\(formData\)/);
    expect(code("app/auth/confirm/continue/page.tsx")).not.toMatch(/verifyOtp/);
  });

  it("the local reset email links to /auth/confirm with a token_hash", () => {
    const template = read("supabase/templates/recovery.html");
    expect(template).toContain(
      'href="{{ .SiteURL }}/auth/confirm?token_hash={{ .TokenHash }}&type=recovery&next=/auth/update-password"',
    );
    expect(template).not.toContain("ConfirmationURL");
    expect(read("supabase/config.toml")).toMatch(
      /\[auth\.email\.template\.recovery\][^[]*content_path = "\.\/supabase\/templates\/recovery\.html"/,
    );
  });
});
