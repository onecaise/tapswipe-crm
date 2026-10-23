import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  PAPER_PROCESSOR_CODES,
  PROCESSOR_UNSET_LABEL,
  processorOptions,
} from "@/lib/processors";
import { BUSINESS_SECTION } from "@/lib/pre-app-form-fields";

/**
 * The processor list in the browser code (phase 1 of
 * docs/design/intake-and-reports.md).
 *
 * The table is the list; these tests pin the two places that are not the
 * table to it: the paper form's static copy, and the option builder every
 * drop-down renders through.
 */

const ROOT = path.resolve(__dirname, "../..");

/** The codes an `insert into processors ... values (...)` statement seeds, in order. */
async function seededCodes(file: string): Promise<string[]> {
  const sql = await readFile(path.join(ROOT, file), "utf8");
  const insert = sql.match(/insert into processors \(code, label, sort_order\) values([\s\S]*?);/);
  if (!insert) throw new Error(`no processors insert in ${file}`);
  return [...insert[1].matchAll(/\(\s*'([^']+)'/g)].map((m) => m[1]);
}

describe("the paper form's processor list", () => {
  it("matches what the migration seeds, in order", async () => {
    expect(await seededCodes("supabase/migrations/20261023130000_processors.sql")).toEqual([
      ...PAPER_PROCESSOR_CODES,
    ]);
  });

  it("matches the schema doc", async () => {
    expect(await seededCodes("docs/tapswipe_crm_schema.sql")).toEqual([
      ...PAPER_PROCESSOR_CODES,
    ]);
  });

  it("is what the blank application offers to tick", () => {
    const field = BUSINESS_SECTION.groups
      .flatMap((group) => group.fields)
      .find((f) => f.key === "processor");
    expect(field?.kind).toBe("select");
    expect(field?.options).toEqual(PAPER_PROCESSOR_CODES);
  });
});

describe("processorOptions", () => {
  const list = [
    { code: "TSYS", label: "TSYS" },
    { code: "Square", label: "Square" },
  ];

  it("offers 'not set' first, then the list in its order", () => {
    expect(processorOptions(list, null)).toEqual([
      { value: "", label: PROCESSOR_UNSET_LABEL },
      { value: "TSYS", label: "TSYS" },
      { value: "Square", label: "Square" },
    ]);
  });

  it("adds nothing for a listed or empty current value", () => {
    expect(processorOptions(list, "Square")).toHaveLength(3);
    expect(processorOptions(list, "")).toHaveLength(3);
  });

  it("keeps an unlisted current value selectable instead of silently dropping it", () => {
    // A select whose value is not among its options shows the first option,
    // and saving the form would then change the processor without anyone
    // choosing to.
    expect(processorOptions(list, "First Data")[1]).toEqual({
      value: "First Data",
      label: "First Data (not in the list)",
    });
  });
});
