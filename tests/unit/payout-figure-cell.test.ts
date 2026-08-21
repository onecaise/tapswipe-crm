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
