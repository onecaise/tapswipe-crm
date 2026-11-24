import { describe, expect, it } from "vitest";

import {
  MERCHANT_SORTS,
  MERCHANT_SORT_DEFAULT_DIRECTION,
  clampMerchantPage,
  merchantFiltersActive,
  merchantListHref,
  merchantSortHref,
  parseMerchantListParams,
  type MerchantListParams,
} from "@/lib/merchants";

/**
 * The merchants list's URL (docs/design/merchants-and-dashboard.md §1.2–1.4,
 * phase 1a): what parseMerchantListParams() accepts, what it drops, and that
 * merchantListHref() writes back exactly what the parser reads.
 */

const PROCESSORS = ["TSYS", "Netevia HQ", "Square"];
const admin = { isAdmin: true, processors: PROCESSORS };
const rep = { isAdmin: false, processors: PROCESSORS };
const UUID = "22222222-2222-2222-2222-222222222222";

const DEFAULTS: MerchantListParams = {
  status: "all",
  processor: null,
  agent: null,
  splitNone: false,
  splitMin: null,
  splitMax: null,
  from: null,
  to: null,
  sort: "added",
  dir: "desc",
  size: 25,
  page: 1,
};

describe("parseMerchantListParams", () => {
  it("defaults to the newest first, 25 a page, unfiltered", () => {
    expect(parseMerchantListParams({}, admin)).toEqual(DEFAULTS);
  });

  it("reads every param it knows", () => {
    expect(
      parseMerchantListParams(
        {
          status: "active",
          processor: "Netevia HQ",
          agent: UUID,
          split_min: "10",
          split_max: "40.5",
          from: "2026-01-01",
          to: "2026-06-30",
          sort: "dba",
          dir: "desc",
          size: "100",
          page: "3",
        },
        admin,
      ),
    ).toEqual({
      status: "active",
      processor: "Netevia HQ",
      agent: UUID,
      splitNone: false,
      splitMin: 10,
      splitMax: 40.5,
      from: "2026-01-01",
      to: "2026-06-30",
      sort: "dba",
      dir: "desc",
      size: 100,
      page: 3,
    });
  });

  it("drops what it cannot read rather than sending it", () => {
    const parsed = parseMerchantListParams(
      {
        status: "closed",
        processor: "Unknown Bank",
        agent: "not-a-uuid",
        split_min: "51",
        split_max: "abc",
        from: "01/02/2026",
        to: "2026-13",
        sort: "volume",
        dir: "sideways",
        size: "30",
        page: "-2",
      },
      admin,
    );
    expect(parsed).toEqual(DEFAULTS);
  });

  it("drops a backwards range whole", () => {
    const parsed = parseMerchantListParams(
      { split_min: "40", split_max: "10", from: "2026-06-01", to: "2026-01-01" },
      admin,
    );
    expect([parsed.splitMin, parsed.splitMax, parsed.from, parsed.to]).toEqual([
      null,
      null,
      null,
      null,
    ]);
  });

  it("refuses a rate with more than two decimals", () => {
    expect(parseMerchantListParams({ split_min: "10.555" }, admin).splitMin).toBeNull();
    expect(parseMerchantListParams({ split_min: "0" }, admin).splitMin).toBe(0);
    expect(parseMerchantListParams({ split_max: "50" }, admin).splitMax).toBe(50);
  });

  it("reads split=none as 'no rate' and ignores the range then", () => {
    const parsed = parseMerchantListParams(
      { split: "none", split_min: "10", split_max: "20" },
      admin,
    );
    expect(parsed.splitNone).toBe(true);
    expect([parsed.splitMin, parsed.splitMax]).toEqual([null, null]);
  });

  it("reads processor=none as 'not set'", () => {
    expect(parseMerchantListParams({ processor: "none" }, admin).processor).toBe("none");
  });

  it("ignores the agent filter and the agent sort for a rep", () => {
    const parsed = parseMerchantListParams({ agent: UUID, sort: "agent" }, rep);
    expect(parsed.agent).toBeNull();
    expect(parsed.sort).toBe("added");
    expect(parsed.dir).toBe("desc");
  });

  it("gives each sort its own default direction", () => {
    for (const sort of MERCHANT_SORTS) {
      expect(parseMerchantListParams({ sort }, admin).dir).toBe(
        MERCHANT_SORT_DEFAULT_DIRECTION[sort],
      );
    }
    expect(MERCHANT_SORT_DEFAULT_DIRECTION).toEqual({
      added: "desc",
      dba: "asc",
      mid: "asc",
      split: "desc",
      agent: "asc",
    });
  });

  it("treats a repeated param as absent", () => {
    const parsed = parseMerchantListParams(
      { page: ["2", "3"], split_min: ["10", "20"] } as unknown as Record<string, string>,
      admin,
    );
    expect(parsed.page).toBe(1);
    expect(parsed.splitMin).toBeNull();
  });

  it("caps an absurd page number", () => {
    expect(parseMerchantListParams({ page: "9999999" }, admin).page).toBe(1);
    expect(parseMerchantListParams({ page: "250" }, admin).page).toBe(250);
  });
});

describe("merchantListHref", () => {
  it("is plain /merchants at the defaults", () => {
    expect(merchantListHref(DEFAULTS)).toBe("/merchants");
  });

  it("keeps today's ?status= links meaning what they meant", () => {
    expect(merchantListHref(DEFAULTS, { status: "active" })).toBe("/merchants?status=active");
  });

  it("omits a direction that is the sort's default", () => {
    expect(merchantListHref(DEFAULTS, { sort: "dba", dir: "asc" })).toBe("/merchants?sort=dba");
    expect(merchantListHref(DEFAULTS, { sort: "dba", dir: "desc" })).toBe(
      "/merchants?sort=dba&dir=desc",
    );
  });

  it("round-trips through the parser", () => {
    const params: MerchantListParams = {
      status: "inactive",
      processor: "Netevia HQ",
      agent: UUID,
      splitNone: false,
      splitMin: 12.5,
      splitMax: 50,
      from: "2026-02-01",
      to: "2026-03-01",
      sort: "mid",
      dir: "desc",
      size: 50,
      page: 4,
    };
    const href = merchantListHref(params);
    const query = Object.fromEntries(new URL(href, "http://x").searchParams);
    expect(parseMerchantListParams(query, admin)).toEqual(params);
  });

  it("round-trips split=none", () => {
    const params = { ...DEFAULTS, splitNone: true };
    const query = Object.fromEntries(
      new URL(merchantListHref(params), "http://x").searchParams,
    );
    expect(parseMerchantListParams(query, admin)).toEqual(params);
  });
});

describe("merchantSortHref", () => {
  const onPage3 = { ...DEFAULTS, page: 3 };

  it("flips the active column and goes back to page 1", () => {
    expect(merchantSortHref(onPage3, "added")).toBe("/merchants?dir=asc");
  });

  it("starts a new column in its own default direction", () => {
    expect(merchantSortHref(onPage3, "dba")).toBe("/merchants?sort=dba");
    expect(merchantSortHref(onPage3, "split")).toBe("/merchants?sort=split");
  });

  it("keeps the filters and page size", () => {
    expect(
      merchantSortHref({ ...onPage3, status: "active", size: 100 }, "mid"),
    ).toBe("/merchants?status=active&sort=mid&size=100");
  });
});

describe("merchantFiltersActive", () => {
  it("ignores sort, size and page", () => {
    expect(merchantFiltersActive({ ...DEFAULTS, sort: "dba", size: 100, page: 2 })).toBe(false);
  });

  it("sees every filter", () => {
    expect(merchantFiltersActive({ ...DEFAULTS, status: "active" })).toBe(true);
    expect(merchantFiltersActive({ ...DEFAULTS, processor: "none" })).toBe(true);
    expect(merchantFiltersActive({ ...DEFAULTS, splitNone: true })).toBe(true);
    expect(merchantFiltersActive({ ...DEFAULTS, splitMax: 40 })).toBe(true);
    expect(merchantFiltersActive({ ...DEFAULTS, to: "2026-01-01" })).toBe(true);
  });
});

describe("clampMerchantPage", () => {
  it("shows the last page when asked for one past it", () => {
    expect(clampMerchantPage(9, 60, 25)).toEqual({ page: 3, lastPage: 3 });
  });

  it("has one page for an empty list", () => {
    expect(clampMerchantPage(4, 0, 25)).toEqual({ page: 1, lastPage: 1 });
  });

  it("counts an exact fit as full pages", () => {
    expect(clampMerchantPage(2, 50, 25)).toEqual({ page: 2, lastPage: 2 });
  });
});
