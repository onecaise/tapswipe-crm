import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  PRE_APP_REQUIRED_ITEMS,
  missingCountByStep,
  type PreAppMissingItem,
} from "@/lib/pre-app-required";
import { PRE_APP_STEPS } from "@/lib/pre-apps";

/**
 * lib/pre-app-required.ts is the code vocabulary of pre_app_missing_fields()
 * (phase 4). It holds no rule, so the only way it can be wrong is by naming a
 * different set of codes than the function: pinned here by reading the
 * migration and the schema doc, so adding a code to one without the other
 * goes red. (The rules themselves are asserted against the function, code by
 * code, in tests/rls/pre-app-required-fields.test.ts.)
 */

const ROOT = path.resolve(__dirname, "../..");

async function functionBody(file: string): Promise<string> {
  const text = await readFile(path.join(ROOT, file), "utf8");
  const start = text.indexOf("create or replace function pre_app_missing_fields(");
  expect(start, `${file} defines pre_app_missing_fields`).toBeGreaterThan(-1);
  return text.slice(start, text.indexOf("\n$$;", start));
}

/** Every code the body can return, read from its 'code', '...' and value rows. */
function codesIn(body: string): string[] {
  const direct = [...body.matchAll(/'code', '([a-z_]+)'/g)].map((m) => m[1]);
  const ownerRows = [...body.matchAll(/\(\d+,\s*'(owner_[a-z_]+)'/g)].map((m) => m[1]);
  return [...new Set([...direct, ...ownerRows])].sort();
}

describe("the code list matches pre_app_missing_fields()", () => {
  for (const file of [
    "supabase/migrations/20261028120000_pre_app_required_fields.sql",
    "docs/tapswipe_crm_schema.sql",
  ]) {
    it(`in ${file}`, async () => {
      const codes = codesIn(await functionBody(file));
      expect(codes).toEqual(PRE_APP_REQUIRED_ITEMS.map((i) => i.code).sort());
    });
  }

  it("has no duplicate codes, and every step is a real wizard step", () => {
    const codes = PRE_APP_REQUIRED_ITEMS.map((i) => i.code);
    expect(new Set(codes).size).toBe(codes.length);
    for (const item of PRE_APP_REQUIRED_ITEMS) {
      expect(PRE_APP_STEPS).toContain(item.step);
    }
  });
});

describe("missingCountByStep", () => {
  it("counts items by the step where each is fixed, for the wizard's badges", () => {
    const items: PreAppMissingItem[] = [
      { code: "zip", step: "business", label: "x" },
      { code: "owner_dob", step: "owners", label: "x", owner_id: 1 },
      { code: "owner_dob", step: "owners", label: "x", owner_id: 2 },
      { code: "banking", step: "secrets", label: "x" },
      { code: "tax_id", step: "secrets", label: "x" },
    ];
    expect(missingCountByStep(items)).toEqual({ business: 1, owners: 2, secrets: 2 });
    expect(missingCountByStep([])).toEqual({});
  });
});
