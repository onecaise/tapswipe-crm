import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * PayoutFigureCell, rendered.
 *
 * This file exists because of a real crash: `TypeError: text.trim is not a
 * function`, thrown while rendering a period's ledger. The cause was a type that
 * lied. lib/payouts.ts declared rep_payout_rows' numeric columns as
 * `string | null` on the stated (wrong) belief that PostgREST sends `numeric` as a
 * quoted string. It does not — it sends an unquoted JSON number. So the component
 * seeded `useState(value ?? "")` with a NUMBER while TypeScript, trusting the wrong
 * prop type, inferred `string`.
 *
 * TypeScript could not have caught it. The pages do
 * `const rows = (data ?? []) as PayoutRow[]`, and `as` is an assertion rather than
 * a check — with no generated database types, it makes the compiler believe
 * whatever lib/payouts.ts claims. Only running the code finds this class of bug,
 * which is why these tests render rather than type-check.
 *
 * Rendered with react-dom/server rather than a DOM testing library on purpose:
 * react and react-dom are already dependencies, so this needs no jsdom, no
 * @testing-library, and no fourth vitest config, and it still executes the render
 * path where the throw happened. It cannot test click/blur behaviour — the save
 * path is covered by the live suite and by parseFigureInput's own unit tests.
 */

vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: () => {}, push: () => {} }),
}));

// Never called during render; mocked so importing the component pulls in no
// browser-only Supabase client.
vi.mock("@/lib/supabase/client", () => ({
  createClient: () => {
    throw new Error("createClient must not run during render");
  },
}));

const { PayoutFigureCell } = await import("@/components/payout-figure-cell");

type Props = Parameters<typeof PayoutFigureCell>[0];

function render(props: Partial<Props> = {}): string {
  return renderToStaticMarkup(
    createElement(PayoutFigureCell, {
      rowId: 1,
      field: "residual_income",
      value: 88.4,
      merchantName: "Joe's Diner",
      ...props,
    } as Props),
  );
}

describe("PayoutFigureCell renders a numeric value without throwing", () => {
  it("renders residual_income given a number — the exact crash case", () => {
    // Before the fix this threw `text.trim is not a function`, because `value`
    // arrived as 88.4 and the "was $X" indicator called a string method on it.
    expect(() => render({ field: "residual_income", value: 88.4 })).not.toThrow();
  });

  it("renders rep_split_pct given a number", () => {
    expect(() => render({ field: "rep_split_pct", value: 60 })).not.toThrow();
  });

  it("renders a null value", () => {
    expect(() => render({ value: null })).not.toThrow();
  });

  it("renders a negative number, as a clawback row carries", () => {
    expect(() => render({ value: -18.5 })).not.toThrow();
  });

  it("renders an integer, which is what a whole-dollar figure arrives as", () => {
    // PostgREST sends numeric(14,2) 60.00 as `60`, so the input must cope with a
    // value that has no decimal part.
    expect(() => render({ value: 60 })).not.toThrow();
  });

  it("puts the stored number in the input, not [object Object] or NaN", () => {
    const html = render({ value: 88.4 });
    expect(html).toContain('value="88.4"');
    expect(html).not.toContain("NaN");
    expect(html).not.toContain("object");
  });

  it("leaves the input empty for a null figure, rather than showing 'null'", () => {
    const html = render({ value: null });
    expect(html).toContain('value=""');
    expect(html).not.toContain("null");
  });

  it("does NOT show the 'was' indicator when the input matches what is stored", () => {
    // The old comparison was `text.trim() !== value`, string against string. Even
    // without the type bug that was wrong: a stored 88.40 rendered as "88.4" would
    // not match the string "88.40" and the indicator showed spuriously. Comparing
    // parsed numbers fixes it, and this pins that.
    expect(render({ value: 88.4 })).not.toContain("was ");
    expect(render({ value: 60 })).not.toContain("was ");
  });

  it("labels the input with the merchant, so 40 rows are distinguishable", () => {
    expect(render({ merchantName: "Corner Mart" })).toContain("Corner Mart");
  });

  it("renders when the merchant name is null", () => {
    expect(() => render({ merchantName: null })).not.toThrow();
  });
});

/**
 * The value edge cases from the payouts test pass.
 *
 * Every one of these is a value the ledger can actually hold — the columns are
 * numeric(14,2) signed for the money and numeric(5,2) 0..100 for the split — so
 * each is reachable from a real processor file rather than hypothetical. They are
 * grouped separately from the crash regressions above because they are asserting a
 * different thing: not "does it throw" but "does the editable cell round-trip the
 * stored value faithfully".
 */
describe("PayoutFigureCell across the ledger's real value range", () => {
  it("renders the largest figure numeric(14,2) can hold", () => {
    // 12 digits before the point is the column's ceiling, and a single row can
    // legitimately be this big.
    const html = render({ value: 999999999999.99 });
    expect(html).toContain('value="999999999999.99"');
    expect(html).not.toContain("e+");
  });

  it("renders the largest negative figure without scientific notation", () => {
    // String(-1e21) would be "-1e+21"; this is well inside the range where
    // String() stays decimal, and that is worth pinning because the input's value
    // comes straight from String(value).
    const html = render({ value: -999999999999.99 });
    expect(html).toContain('value="-999999999999.99"');
    expect(html).not.toContain("e+");
  });

  it("renders an exact zero as 0, not as blank", () => {
    // The distinction the whole module is careful about: 0 is a figure that has
    // been worked out and is zero; null is one that has not been worked out. A
    // cell that showed blank for 0 would erase that.
    const html = render({ value: 0 });
    expect(html).toContain('value="0"');
  });

  it("distinguishes zero from null in the input", () => {
    expect(render({ value: 0 })).toContain('value="0"');
    expect(render({ value: null })).toContain('value=""');
  });

  it("renders a two-decimal value at the column's full precision", () => {
    expect(render({ value: 0.01 })).toContain('value="0.01"');
  });

  it("shows no 'was' indicator for zero, which is not a change", () => {
    // `differsFromStored` compares parsed numbers, so a stored 0 against a typed
    // "0" must be equal. A truthiness check here would treat 0 as absent.
    expect(render({ value: 0 })).not.toContain("was ");
  });

  it("shows no 'was' indicator for a negative stored value", () => {
    expect(render({ value: -820.4 })).not.toContain("was ");
  });

  it("never renders the word null or NaN for any value in range", () => {
    for (const value of [
      null, 0, 0.01, -0.01, 55, 88.4, 123.45, -820.4,
      999999999999.99, -999999999999.99,
    ]) {
      const html = render({ value });
      expect(html, `value ${String(value)}`).not.toContain("NaN");
      expect(html, `value ${String(value)}`).not.toContain(">null<");
    }
  });

  it("renders every split the constraint permits, including the bounds", () => {
    for (const value of [0, 33.33, 55, 100]) {
      expect(() =>
        render({ field: "rep_split_pct", value }),
      ).not.toThrow();
    }
  });

  it("escapes a merchant name rather than interpreting it", () => {
    // merchant_name is free text out of a processor's spreadsheet, and it reaches
    // the input's aria-label. React escapes it; this pins that it stays escaped.
    const html = render({ merchantName: "<script>alert('x')</script>" });
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

/**
 * Re-syncing when the stored value changes from outside the cell.
 *
 * renderToStaticMarkup gives a single render, so it cannot re-render an existing
 * instance with a new prop — the stale-state bug itself needs a live reconciler.
 * What it CAN pin is the shape of the fix: the value the input is given must be
 * derived from the `value` prop on every render rather than captured once, so a
 * fresh render at a new value shows the new value.
 *
 * The bug this guards, found by driving the page: PayoutBulkSplit wrote 42.5 to
 * eight rows and called router.refresh(); the server sent the new value down, the
 * generated rep_payout column updated, and every Split input kept rendering the
 * old 50 — because useState's initialiser had already run and these cells are
 * keyed on a stable row.id. The page showed 410 at 50% producing $174.25.
 */
describe("PayoutFigureCell reflects the stored value it is given", () => {
  it("renders whatever value it is handed, not a captured first value", () => {
    expect(render({ field: "rep_split_pct", value: 50 })).toContain('value="50"');
    expect(render({ field: "rep_split_pct", value: 42.5 })).toContain(
      'value="42.5"',
    );
  });

  it("shows no stale 'was' indicator at the new value", () => {
    // After a bulk split the input and the stored value agree again, so the
    // mid-edit indicator must be gone. If text had stayed stale, `differsFromStored`
    // would be true and the cell would claim an edit in progress that nobody made.
    expect(render({ value: 42.5 })).not.toContain("was ");
  });

  it("tracks the prop through a null transition in both directions", () => {
    // Clearing a figure back to null is a real admin action, and null is the
    // "not worked out yet" state the totals count as unfilled.
    expect(render({ value: null })).toContain('value=""');
    expect(render({ value: 42.5 })).toContain('value="42.5"');
  });
});
