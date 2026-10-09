import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { parseDelimitedText } from "../../supabase/functions/_shared/user-imports";
import {
  BILLINGS,
  CATALOG_COLUMNS,
  DEFAULT_CATALOG_PATH,
  KINDS,
  SPECS_KEYS_OWNED,
  mergeSpecs,
  parseActiveCell,
  parseCatalog,
  parsePriceCell,
  planLoad,
  splitCsvRows,
  toProductRow,
} from "../../scripts/load-hardware-catalog.mjs";

/**
 * The hardware catalog loader's validation.
 *
 * This is the whole review step. The bulk-import pipeline the products
 * migration deferred -- staging table, review screen, commit RPC -- is not
 * being built, because the file is 43 curated rows in version control that an
 * admin maintains on /admin/products afterwards. So the only thing standing
 * between a mistyped cell and a price on a document somebody hands a merchant
 * is this file plus the dry run.
 *
 * What these guard, in order of what a mistake would cost:
 *
 *   1. **A blank price must stay NULL, never 0.00.** `list_price` is nullable
 *      precisely so "not priced yet" survives as a different fact from "free",
 *      and `Number("")` is 0. The catalog ships one unpriced row today
 *      (greta-bs1560-ns), so this is a live case rather than a hypothetical.
 *   2. **A quoted field must not shift the columns.** The catalog contains both
 *      hard CSV cases -- a comma inside quotes, and a doubled quote standing
 *      for an inches mark -- so a naive split would produce a plausible-looking
 *      catalog of nonsense.
 *   3. **Every `fits` id must resolve to a device.** A dangling or misdirected
 *      link is INERT rather than loud: the store asks only "which add-ons fit
 *      this device", so a wrong row matches nothing and nothing reports it.
 *   4. **kind and billing are read by CODE**, not by a person -- the
 *      compatibility trigger, the store's device list, the proposal's two
 *      totals -- so a third value is not a new label, it is a row all three
 *      silently skip.
 */

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const catalogText = readFileSync(
  path.join(repoRoot, DEFAULT_CATALOG_PATH),
  "utf8",
);

/** The header plus however many data rows, as the loader wants them. */
function csv(...rows: string[]): string {
  return [CATALOG_COLUMNS.join(","), ...rows].join("\n");
}

/** A valid device row, with named overrides by column. */
function row(overrides: Partial<Record<string, string>> = {}): string {
  const base: Record<string, string> = {
    id: "widget",
    kind: "device",
    brand: "Acme",
    name: "Acme Widget",
    device_type: "Terminal",
    connectivity: "Wi-Fi",
    retail_price: "199",
    billing: "one_time",
    fits: "",
    notes: "",
    active: "yes",
    review: "",
  };
  return CATALOG_COLUMNS.map((column) => ({ ...base, ...overrides })[column]).join(
    ",",
  );
}

const messages = (text: string) =>
  parseCatalog(text).problems.map((problem) => problem.message);

// ---------------------------------------------------------------------------

describe("splitCsvRows", () => {
  /**
   * The duplication pin.
   *
   * splitCsvRows() is a verbatim copy of parseDelimitedText() with the
   * delimiter fixed to a comma, because a .mjs script run by plain `node`
   * cannot import a TypeScript module under supabase/. Nothing type-checks that
   * pair, so this asserts it by behaviour -- the arrangement isBlocking()
   * already has in tests/unit/user-import-lib.test.ts. Change one and this
   * reds.
   */
  const cases = [
    "a,b,c",
    'a,"b,c",d',
    'a,"say ""hi""",c',
    'one\ntwo\nthree',
    "one\r\ntwo\r\nthree",
    'a,"multi\nline",c',
    'a,"trailing\r\nCRLF inside",c',
    "",
    ",,",
    catalogText,
  ];

  for (const [index, input] of cases.entries()) {
    it(`agrees with parseDelimitedText on case ${index}`, () => {
      expect(splitCsvRows(input)).toEqual(parseDelimitedText(input, ","));
    });
  }

  it("keeps a quoted comma in one cell", () => {
    expect(splitCsvRows('a,"b,c",d')).toEqual([["a", "b,c", "d"]]);
  });

  it("reads a doubled quote as the inches mark it stands for", () => {
    expect(splitCsvRows('x,"15.6"" screen",y')).toEqual([
      ["x", '15.6" screen', "y"],
    ]);
  });
});

describe("parsePriceCell", () => {
  it("leaves a blank price NULL rather than collapsing it to zero", () => {
    expect(parsePriceCell("")).toEqual({ value: null });
    expect(parsePriceCell("   ")).toEqual({ value: null });
  });

  it("keeps a real zero, which is a different fact", () => {
    expect(parsePriceCell("0")).toEqual({ value: 0 });
  });

  it("reads the shapes a price sheet is typed in", () => {
    expect(parsePriceCell("199")).toEqual({ value: 199 });
    expect(parsePriceCell("19.99")).toEqual({ value: 19.99 });
    expect(parsePriceCell("$1,900")).toEqual({ value: 1900 });
    expect(parsePriceCell(" 2599 ")).toEqual({ value: 2599 });
  });

  it("refuses what the column cannot hold", () => {
    expect(parsePriceCell("free").error).toBeTruthy();
    expect(parsePriceCell("-5").error).toBeTruthy();
    expect(parsePriceCell("1.005").error).toBeTruthy();
    expect(parsePriceCell("99999999999").error).toBeTruthy();
    // Not a number, and emphatically not NaN silently becoming null.
    expect(parsePriceCell("$").error).toBeTruthy();
  });
});

describe("parseActiveCell", () => {
  it("accepts only yes and no", () => {
    expect(parseActiveCell("yes")).toEqual({ value: true });
    expect(parseActiveCell("NO")).toEqual({ value: false });
    expect(parseActiveCell("true").error).toBeTruthy();
    expect(parseActiveCell("").error).toBeTruthy();
  });
});

describe("parseCatalog", () => {
  it("accepts a minimal valid file", () => {
    const { items, problems } = parseCatalog(csv(row()));
    expect(problems).toEqual([]);
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe("widget");
  });

  it("refuses a header that is not exactly the expected columns", () => {
    const reordered = [...CATALOG_COLUMNS];
    [reordered[1], reordered[2]] = [reordered[2], reordered[1]];
    const { items, problems } = parseCatalog([reordered.join(","), row()].join("\n"));
    expect(items).toEqual([]);
    expect(problems).toHaveLength(1);
    expect(problems[0].message).toMatch(/header must be exactly/);
  });

  it("refuses a duplicate id, naming the line that used it first", () => {
    const problems = messages(csv(row(), row({ name: "Other Widget" })));
    expect(problems).toEqual([
      expect.stringContaining("duplicate id -- already used on line 2"),
    ]);
  });

  it("refuses an id-less row", () => {
    expect(messages(csv(row({ id: "" })))).toEqual(["has no id"]);
  });

  describe("prices", () => {
    it("accepts a blank price and stores NULL", () => {
      const { items, problems } = parseCatalog(csv(row({ retail_price: "" })));
      expect(problems).toEqual([]);
      expect(items[0].listPrice).toBeNull();
      expect(toProductRow(items[0]).list_price).toBeNull();
    });

    it("refuses a non-numeric price", () => {
      expect(messages(csv(row({ retail_price: "call us" })))).toEqual([
        expect.stringContaining("not a number"),
      ]);
    });
  });

  describe("vocabularies", () => {
    it("refuses a kind outside the CHECK", () => {
      expect(messages(csv(row({ kind: "bundle" })))).toEqual([
        expect.stringContaining('kind "bundle" is not one of device, addon'),
      ]);
    });

    it("refuses a billing outside the CHECK", () => {
      expect(messages(csv(row({ billing: "annual" })))).toEqual([
        expect.stringContaining('billing "annual" is not one of one_time, monthly'),
      ]);
    });

    it("mirrors the migration's two vocabularies", () => {
      expect(KINDS).toEqual(["device", "addon"]);
      expect(BILLINGS).toEqual(["one_time", "monthly"]);
    });
  });

  describe("fits", () => {
    const device = row({ id: "term", kind: "device" });
    const addon = (fits: string) =>
      row({ id: "case", kind: "addon", name: "Case", device_type: "Case", fits });

    it("accepts an add-on pointing at a device defined below it", () => {
      expect(parseCatalog(csv(addon("term"), device)).problems).toEqual([]);
    });

    it("refuses an add-on that fits nothing", () => {
      expect(messages(csv(device, addon("")))).toEqual([
        "is an add-on and fits nothing",
      ]);
    });

    it("refuses a fits id that is not in the file", () => {
      expect(messages(csv(device, addon("ghost")))).toEqual([
        expect.stringContaining('fits "ghost", which is not in this file'),
      ]);
    });

    it("refuses an add-on that fits another add-on", () => {
      const other = row({
        id: "other",
        kind: "addon",
        device_type: "Case",
        fits: "term",
      });
      expect(messages(csv(device, other, addon("other")))).toEqual([
        expect.stringContaining('fits "other", which is a addon, not a device'),
      ]);
    });

    it("refuses a device that names fits -- the swapped-columns case", () => {
      expect(messages(csv(device, row({ id: "two", fits: "term" })))).toEqual([
        expect.stringContaining("is a device but names fits"),
      ]);
    });

    it("refuses a self-reference, which product_compatibility_distinct would", () => {
      expect(
        messages(csv(device, addon("case;term"))).some((m) => m === "fits itself"),
      ).toBe(true);
    });

    it("refuses the same target twice, which would be a duplicate link", () => {
      expect(messages(csv(device, addon("term;term")))).toEqual([
        expect.stringContaining('fits "term" twice'),
      ]);
    });
  });

  it("refuses a row with no device_type, since category is NOT NULL", () => {
    expect(messages(csv(row({ device_type: "" })))).toEqual(["has no device_type"]);
  });

  it("refuses a row with the wrong number of cells", () => {
    expect(messages(csv("widget,device,Acme"))).toEqual([
      expect.stringContaining("has 3 cells, expected 12"),
    ]);
  });
});

describe("toProductRow", () => {
  it("maps the columns the way the loader documents", () => {
    const { items } = parseCatalog(
      csv(
        row({
          id: "acme-1",
          brand: "Acme",
          name: "Acme One",
          device_type: "Terminal",
          connectivity: "Wi-Fi / Ethernet",
          notes: "A note.",
          retail_price: "199",
        }),
      ),
    );
    expect(toProductRow(items[0])).toEqual({
      sku: "acme-1",
      name: "Acme One",
      category: "Terminal",
      brand: "Acme",
      kind: "device",
      billing: "one_time",
      list_price: 199,
      description: "A note.",
      specs: { connectivity: "Wi-Fi / Ethernet" },
    });
  });

  it("normalises a blank brand to NULL, which products_brand_not_blank requires", () => {
    const { items } = parseCatalog(csv(row({ brand: "" })));
    expect(toProductRow(items[0]).brand).toBeNull();
  });

  it("carries the review note into specs, so an archived row says why", () => {
    const { items } = parseCatalog(
      csv(row({ active: "no", review: "Price unconfirmed." })),
    );
    expect(toProductRow(items[0]).specs).toMatchObject({
      review: "Price unconfirmed.",
    });
  });

  it("omits empty specs keys rather than storing blanks", () => {
    const { items } = parseCatalog(csv(row({ connectivity: "", review: "" })));
    expect(toProductRow(items[0]).specs).toEqual({});
  });
});

describe("mergeSpecs", () => {
  it("keeps a key an admin added on /admin/products", () => {
    expect(mergeSpecs({ warranty: "2y" }, { connectivity: "Wi-Fi" })).toEqual({
      warranty: "2y",
      connectivity: "Wi-Fi",
    });
  });

  it("removes a key the CSV has cleared", () => {
    expect(mergeSpecs({ connectivity: "Wi-Fi", warranty: "2y" }, {})).toEqual({
      warranty: "2y",
    });
  });

  it("owns exactly the two columns with no column of their own", () => {
    expect(SPECS_KEYS_OWNED).toEqual(["connectivity", "review"]);
  });
});

describe("planLoad", () => {
  const now = "2026-10-09T00:00:00.000Z";
  const { items } = parseCatalog(
    csv(
      row({ id: "term", kind: "device" }),
      row({ id: "case", kind: "addon", device_type: "Case", fits: "term" }),
    ),
  );

  it("plans every row as new against an empty catalog", () => {
    const plan = planLoad(items, [], [], now);
    expect(plan.inserts).toHaveLength(2);
    expect(plan.updates).toEqual([]);
    // The ids do not exist yet, so the links cannot be resolved on this pass --
    // which is why the writer re-reads and re-plans before inserting them.
    expect(plan.linkInserts).toHaveLength(1);
    expect(plan.linkInserts[0]).toMatchObject({
      addonSku: "case",
      deviceSku: "term",
      addonId: null,
    });
  });

  it("plans nothing on a second run -- the idempotence claim", () => {
    const products = items.map((item, index) => ({
      id: index + 1,
      ...toProductRow(item),
      archived_at: null,
    }));
    const links = [{ addon_product_id: 2, device_product_id: 1 }];
    const plan = planLoad(items, products, links, now);
    expect(plan.inserts).toEqual([]);
    expect(plan.updates).toEqual([]);
    expect(plan.linkInserts).toEqual([]);
    expect(plan.unchanged).toBe(2);
  });

  it("does not re-stamp archived_at on a row already archived", () => {
    const { items: parked } = parseCatalog(csv(row({ id: "term", active: "no" })));
    const plan = planLoad(
      parked,
      [
        {
          id: 1,
          ...toProductRow(parked[0]),
          archived_at: "2026-01-01T00:00:00.000Z",
        },
      ],
      [],
      now,
    );
    expect(plan.updates).toEqual([]);
    expect(plan.unchanged).toBe(1);
  });

  it("treats a numeric price string from PostgREST as equal to the CSV's number", () => {
    const plan = planLoad(
      items,
      items.map((item, index) => ({
        id: index + 1,
        ...toProductRow(item),
        list_price: "199.00",
        archived_at: null,
      })),
      [{ addon_product_id: 2, device_product_id: 1 }],
      now,
    );
    expect(plan.updates).toEqual([]);
  });

  it("reports an unknown product and an unknown link without planning to touch them", () => {
    const products = [
      ...items.map((item, index) => ({
        id: index + 1,
        ...toProductRow(item),
        archived_at: null,
      })),
      {
        id: 3,
        sku: "hand-typed",
        name: "Hand-typed",
        category: "Terminal",
        brand: null,
        kind: "device",
        billing: "one_time",
        list_price: "10.00",
        description: null,
        specs: {},
        archived_at: null,
      },
    ];
    const plan = planLoad(
      items,
      products,
      [
        { addon_product_id: 2, device_product_id: 1 },
        { addon_product_id: 2, device_product_id: 3 },
      ],
      now,
    );
    expect(plan.orphans).toEqual([{ sku: "hand-typed", name: "Hand-typed" }]);
    expect(plan.extraLinks).toEqual([
      { addonSku: "case", deviceSku: "hand-typed" },
    ]);
    expect(plan.inserts).toEqual([]);
    expect(plan.updates).toEqual([]);
    expect(plan.linkInserts).toEqual([]);
  });
});

/**
 * The file that actually ships.
 *
 * A validator green on synthetic fixtures while the real catalog is broken is
 * the whole failure this section exists to stop -- and the loader refuses to
 * write anything when the file has a problem, so a bad edit is a red test here
 * before it is a confusing run there.
 */
describe("data/hardware-catalog.csv", () => {
  const { items, problems } = parseCatalog(catalogText);

  it("validates clean", () => {
    expect(problems).toEqual([]);
  });

  it("holds 25 devices and 18 add-ons", () => {
    expect(items.filter((item) => item.kind === "device")).toHaveLength(25);
    expect(items.filter((item) => item.kind === "addon")).toHaveLength(18);
  });

  it("describes 28 compatibility links", () => {
    expect(items.reduce((n, item) => n + item.fits.length, 0)).toBe(28);
  });

  it("carries the CSV cases a naive split would get wrong", () => {
    // A doubled quote standing for the inches mark...
    expect(items.find((item) => item.id === "square-kds-156")?.name).toBe(
      'Square KDS 15.6" touchscreen',
    );
    // ...and a comma inside a quoted field, which would otherwise shift every
    // column after it and produce a plausible import of nonsense.
    expect(items.find((item) => item.id === "square-terminal")?.description).toBe(
      "All-in-one compact POS with built-in receipt printer; accepts contactless, chip, and magstripe.",
    );
  });

  it("leaves the one unpriced row NULL, and says why it is parked", () => {
    const unpriced = items.filter((item) => item.listPrice === null);
    expect(unpriced.map((item) => item.id)).toEqual(["greta-bs1560-ns"]);
    expect(unpriced[0].active).toBe(false);
    expect(unpriced[0].review).toBeTruthy();
  });

  it("keeps a real zero distinct from a blank", () => {
    expect(items.find((item) => item.id === "valor-virtual-terminal")?.listPrice).toBe(
      0,
    );
  });

  it("marks exactly the rows awaiting review as inactive", () => {
    const inactive = items.filter((item) => !item.active);
    expect(inactive.map((item) => item.id).sort()).toEqual([
      "greta-bs1560-ns",
      "square-kiosk",
      "square-stand-addon",
    ]);
    // Every parked row explains itself, or an admin un-archives it blind.
    expect(inactive.every((item) => item.review !== null)).toBe(true);
  });

  it("has one monthly product, and it is a device rather than an add-on", () => {
    const monthly = items.filter((item) => item.billing === "monthly");
    expect(monthly.map((item) => item.id)).toEqual(["valor-sim"]);
    expect(monthly[0].kind).toBe("device");
  });
});
