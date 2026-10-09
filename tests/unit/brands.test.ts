import { describe, expect, it } from "vitest";

import {
  brandHref,
  brandWriteError,
  diffLinks,
  matchesDeviceSearch,
  normalizeBrandName,
  sortBrandProducts,
  summarizeBrands,
} from "@/lib/brands";

const square = { id: 1, name: "Square" };
const clover = { id: 2, name: "Clover POS" };
const material = { id: 3, name: "Material POS" };

describe("summarizeBrands", () => {
  const products = [
    { brand: "Square", archived_at: null },
    { brand: "Square", archived_at: "2026-10-01T00:00:00Z" },
    { brand: "Clover POS", archived_at: null },
    { brand: null, archived_at: null },
  ];

  it("gives every brand a box, an empty one included, in name order", () => {
    // An admin adds a brand ahead of its first product -- that is why the
    // table exists -- so a zero-product brand must still be a box.
    expect(summarizeBrands([square, material, clover], products)).toEqual([
      { brand: clover, total: 1, inactive: 0 },
      { brand: material, total: 0, inactive: 0 },
      { brand: square, total: 2, inactive: 1 },
      { brand: null, total: 1, inactive: 0 },
    ]);
  });

  it("shows the unbranded bucket only while it holds something", () => {
    const summaries = summarizeBrands(
      [square],
      [{ brand: "Square", archived_at: null }],
    );
    expect(summaries.map((s) => s.brand)).toEqual([square]);
  });
});

describe("sortBrandProducts", () => {
  it("puts devices first, then add-ons, each by name", () => {
    const sorted = sortBrandProducts([
      { kind: "addon", name: "Case" },
      { kind: "device", name: "Terminal" },
      { kind: "addon", name: "Battery" },
      { kind: "device", name: "Handheld" },
    ]);
    expect(sorted.map((p) => p.name)).toEqual([
      "Handheld",
      "Terminal",
      "Battery",
      "Case",
    ]);
  });
});

describe("diffLinks", () => {
  it("adds and removes only what changed", () => {
    expect(diffLinks([1, 2, 3], [2, 3, 4])).toEqual({ add: [4], remove: [1] });
  });

  it("removes everything when an add-on becomes a device", () => {
    expect(diffLinks([1, 2], [])).toEqual({ add: [], remove: [1, 2] });
  });
});

describe("brand name and errors", () => {
  it("trims, and treats blank as no name", () => {
    expect(normalizeBrandName("  Square ")).toBe("Square");
    expect(normalizeBrandName("   ")).toBeNull();
  });

  it("translates the constraints an admin can actually hit", () => {
    expect(
      brandWriteError(
        'duplicate key value violates unique constraint "idx_brands_name_lower"',
      ),
    ).toMatch(/already exists/);
    expect(
      brandWriteError(
        'update or delete on table "brands" violates foreign key constraint "products_brand_fkey" on table "products"',
      ),
    ).toMatch(/still has products/);
    expect(brandWriteError("something else")).toBe("something else");
  });

  it("links a brand by id, and the unbranded bucket by its own segment", () => {
    expect(brandHref(square)).toBe("/admin/products/1");
    expect(brandHref(null)).toBe("/admin/products/unbranded");
  });
});

describe("matchesDeviceSearch", () => {
  it("matches name or model, case-insensitively", () => {
    const device = { name: "Clover Flex", sku: "C401U" };
    expect(matchesDeviceSearch(device, "flex")).toBe(true);
    expect(matchesDeviceSearch(device, "c401")).toBe(true);
    expect(matchesDeviceSearch(device, "mini")).toBe(false);
    expect(matchesDeviceSearch(device, "  ")).toBe(true);
  });
});
