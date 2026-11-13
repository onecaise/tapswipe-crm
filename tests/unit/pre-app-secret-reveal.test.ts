import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  maskedLast4,
  REVEAL_FIELDS,
  REVEAL_TIMEOUT_MS,
  revealBody,
  revealKey,
} from "@/lib/pre-app-secrets";
import {
  parseRevealRequest,
  REVEAL_FIELDS as DENO_REVEAL_FIELDS,
} from "../../supabase/functions/_shared/pre-app-secrets.ts";

/**
 * Phase 5 (docs/design/intake-and-reports.md §1.E, A24): the reveal request,
 * from both sides of the wire, and the shape of the code paths a full value
 * may take. The behaviour is pinned over HTTP in
 * tests/live/pre-app-secrets.test.ts and in a browser in
 * e2e/qa/pre-app-secret-reveal.spec.ts; what is here is what a source read
 * catches before either runs.
 */

const FUNCTION_SRC = readFileSync("supabase/functions/read-pre-app-secrets/index.ts", "utf8");
const PANEL_SRC = readFileSync("components/pre-app-sensitive-data.tsx", "utf8");
const STEP_SRC = readFileSync("components/pre-app-steps/secrets-step.tsx", "utf8");
const MIGRATION = readFileSync("supabase/migrations/20261028140000_pre_app_secret_reveal.sql", "utf8");

describe("one field vocabulary, three copies", () => {
  it("the browser's list equals the Edge Function's", () => {
    expect([...REVEAL_FIELDS]).toEqual([...DENO_REVEAL_FIELDS]);
  });

  it("and equals what record_pre_app_secret_reveal() accepts", () => {
    const m = /field_input not in \(([^)]*)\)/.exec(MIGRATION);
    expect(m).not.toBeNull();
    const sqlFields = m![1].split(",").map((s) => s.trim().replace(/^'|'$/g, ""));
    expect(sqlFields).toEqual([...REVEAL_FIELDS]);
  });
});

describe("parseRevealRequest", () => {
  it("treats an absent or null reveal as the default masked read", () => {
    expect(parseRevealRequest({ pre_app_id: 1 })).toEqual({ ok: true, reveal: null });
    expect(parseRevealRequest({ pre_app_id: 1, reveal: null })).toEqual({ ok: true, reveal: null });
  });

  it.each(["aba_routing", "account_number", "rp_password", "tax_id"] as const)(
    "accepts %s on its own",
    (field) => {
      expect(parseRevealRequest({ reveal: { field } })).toEqual({ ok: true, reveal: { field } });
    },
  );

  it("accepts an owner SSN naming one owner", () => {
    expect(parseRevealRequest({ reveal: { field: "owner_ssn", pre_app_owner_id: 7 } })).toEqual({
      ok: true,
      reveal: { field: "owner_ssn", pre_app_owner_id: 7 },
    });
  });

  it.each([
    ["a string", "tax_id"],
    ["an array", ["tax_id"]],
    ["a number", 1],
    ["an unknown field", { field: "ssn" }],
    ["no field", {}],
    ["a field list", { field: ["tax_id"] }],
    ["an owner SSN with no owner", { field: "owner_ssn" }],
    ["an owner SSN with owner 0", { field: "owner_ssn", pre_app_owner_id: 0 }],
    ["an owner SSN with a string owner", { field: "owner_ssn", pre_app_owner_id: "7" }],
    ["an owner on another field", { field: "tax_id", pre_app_owner_id: 7 }],
    ["an extra member", { field: "tax_id", everything: true }],
  ])("refuses %s", (_label, reveal) => {
    expect(parseRevealRequest({ reveal }).ok).toBe(false);
  });
});

describe("the browser helpers", () => {
  it("builds a POST body naming one field, and nothing for a URL", () => {
    expect(revealBody(12, { field: "tax_id" })).toEqual({ pre_app_id: 12, reveal: { field: "tax_id" } });
    expect(revealBody(12, { field: "owner_ssn", preAppOwnerId: 3 })).toEqual({
      pre_app_id: 12,
      reveal: { field: "owner_ssn", pre_app_owner_id: 3 },
    });
  });

  it("keys each owner's SSN separately", () => {
    expect(revealKey({ field: "owner_ssn", preAppOwnerId: 3 })).not.toBe(
      revealKey({ field: "owner_ssn", preAppOwnerId: 4 }),
    );
  });

  it("masks to the last four, the same dots the wizard has always shown", () => {
    expect(maskedLast4("1357")).toBe("····1357");
    expect(maskedLast4(undefined)).toBe("····");
  });

  it("re-masks after 30 seconds", () => {
    expect(REVEAL_TIMEOUT_MS).toBe(30_000);
  });
});

describe("read-pre-app-secrets: where a full value can leave", () => {
  const defaultRead = FUNCTION_SRC.slice(
    FUNCTION_SRC.indexOf('action: "read_pre_app_secrets:last4"'),
    FUNCTION_SRC.indexOf("async function revealOne("),
  );
  const revealPath = FUNCTION_SRC.slice(FUNCTION_SRC.indexOf("async function revealOne("));

  it("the default read is one tier for every caller: no admin branch at all", () => {
    expect(defaultRead.length).toBeGreaterThan(500);
    expect(defaultRead).not.toMatch(/isAdmin|callerIsAdmin/);
    expect(defaultRead).not.toMatch(/tier:\s*"full"/);
    // Only last-four keys leave it, plus on_file and the stored kind. The
    // response's `tax_id: taxIdOut` is the section, not a value.
    const keys = defaultRead.replace("tax_id: taxIdOut", "");
    for (const fullKey of ["ssn:", "aba_routing:", "account_number:", "rp_password:", "tax_id:"]) {
      expect(keys, fullKey).not.toMatch(new RegExp(`[{,\\s]${fullKey}\\s`));
    }
    // The RP password is not even decrypted for it.
    expect(defaultRead).not.toContain("rp_password_encrypted");
  });

  it("the role check precedes the record lookup, so a rep's reveal is one 403 for every id", () => {
    const gate = FUNCTION_SRC.indexOf("if (reveal && !(await callerIsAdmin(ctx.supabase)))");
    const lookup = FUNCTION_SRC.indexOf('.from("pre_apps")');
    expect(gate).toBeGreaterThan(0);
    expect(gate).toBeLessThan(lookup);
  });

  it("a reveal audits through the RPC before it decrypts, and returns nothing on its error", () => {
    const rpc = revealPath.indexOf('ctx.supabase.rpc("record_pre_app_secret_reveal"');
    const bail = revealPath.indexOf('return json({ error: "Could not record the access" }, 500)');
    const decrypt = revealPath.indexOf("decryptSecret(");
    expect(rpc).toBeGreaterThan(0);
    expect(bail).toBeGreaterThan(rpc);
    expect(decrypt).toBeGreaterThan(bail);
  });

  it("never logs a value: every console line names a code or message, not data", () => {
    for (const line of FUNCTION_SRC.split("\n").filter((l) => l.includes("console."))) {
      expect(line).not.toMatch(/value|ssn|routing|account|password|taxId|plaintext/i);
    }
  });
});

describe("the browser never stores a revealed value", () => {
  it.each([
    ["the detail page's Sensitive data section", PANEL_SRC],
    ["the wizard's Sensitive data step", STEP_SRC],
  ])("%s touches no storage, URL or log", (_label, src) => {
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(code).not.toMatch(/localStorage|sessionStorage|indexedDB|document\.cookie/);
    expect(code).not.toMatch(/console\./);
    expect(code).not.toMatch(/router\.(push|replace)|history\.(push|replace)State|location\.(href|hash|search)\s*=/);
    expect(code).not.toMatch(/useSearchParams/);
  });

  it("the wizard step has no full-value branch left: it reads last four only", () => {
    expect(STEP_SRC).not.toMatch(/tier === "full"|status\.terminal\.rp_password|\?\.ssn\b|\.tax_id\?\.tax_id\b/);
  });

  it("the section masks again on navigation, a hidden tab, pagehide and beforeprint, and hides the value in print", () => {
    expect(PANEL_SRC).toContain('document.addEventListener("visibilitychange"');
    expect(PANEL_SRC).toContain('window.addEventListener("pagehide", maskAll)');
    expect(PANEL_SRC).toContain('window.addEventListener("beforeprint", maskAll)');
    expect(PANEL_SRC).toContain("useEffect(() => maskAll, [pathname, maskAll])");
    expect(PANEL_SRC).toMatch(/className="font-mono print:hidden" data-revealed=""/);
    expect(PANEL_SRC).toContain("setTimeout(() => mask(key), REVEAL_TIMEOUT_MS)");
  });
});
