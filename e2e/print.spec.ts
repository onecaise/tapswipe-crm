import { expect, test, type Page } from "@playwright/test";

import {
  PERIODS,
  QUOTE_FIXTURE,
  QUOTE_LEAD_CONTACT,
  seedE2E,
  storageStateFor,
} from "./fixtures/seed";
import { imagesPerPage, sheetMap } from "./helpers/pdf";

/**
 * The printable pages: a blank application, one merchant's record, a quote,
 * and — for the letterhead only — a payout summary. The summary's own content
 * is covered by the payouts specs; it is here because the mark is shared by
 * all four.
 *
 * Only browser-only claims are here. Whether the field inventory covers every
 * column is settled by `satisfies` at compile time, and whether the labels match
 * the wizard's constants is settled in tests/unit/pre-app-form-fields.test.ts —
 * both are faster and more precise there, and a browser copy would just be a
 * slower duplicate.
 *
 * What genuinely needs a browser is paint under the print stylesheet. The app
 * chrome is removed by `print:hidden` on the layout's own components, and a
 * server render cannot tell you what a print stylesheet does to the result.
 * Playwright's emulateMedia is the only thing here that can ask.
 *
 * This suite has already earned its place once: it is what caught the old
 * global `header { display: none }` print rule deleting each document's OWN
 * <header>, which had been silently stripping the title, rep name, agent number
 * and period from every printed payout statement.
 */

/**
 * The shell that must not appear on paper.
 *
 * The topbar is identified by a control inside it rather than by `header`,
 * because "the first header on the page" is exactly the ambiguity that caused
 * the bug this suite exists to prevent — every printable document has a
 * <header> of its own.
 */
async function expectChromeHidden(page: Page) {
  await expect(page.locator("aside"), "sidebar printed").toBeHidden();
  await expect(
    page.getByRole("button", { name: "Log out" }),
    "topbar printed",
  ).toBeHidden();
  // Not covered by any element selector — it is a fixed overlay, and it went
  // without a print:hidden until this feature.
  await expect(
    page.getByRole("button", { name: "Report a bug" }),
    "bug bubble printed",
  ).toBeHidden();
}

test.describe("the blank application form", () => {
  test.use({ storageState: storageStateFor("agent") });

  test("drops the app chrome when printed, keeping the document", async ({
    page,
  }) => {
    await page.goto("/pre-apps/blank-form");
    await expect(
      page.getByRole("heading", { name: "Merchant application" }),
    ).toBeVisible();

    await page.emulateMedia({ media: "print" });

    await expectChromeHidden(page);
    // The control row is screen-only; the document's own header is not.
    await expect(page.getByRole("button", { name: /Print/ })).toBeHidden();
    await expect(
      page.getByRole("heading", { name: "Merchant application" }),
      "the document lost its own header",
    ).toBeVisible();
  });

  test("is paper, not a form", async ({ page }) => {
    await page.goto("/pre-apps/blank-form");

    // Scoped to the document: the topbar carries a search input, which is
    // chrome rather than part of the form.
    const doc = page.locator("article");

    // The whole point: something to write on. A stray input would look right in
    // a screenshot and be invisible to any text assertion, so it is checked
    // structurally.
    await expect(doc.locator("input")).toHaveCount(0);
    await expect(doc.locator("select")).toHaveCount(0);
    await expect(doc.locator("textarea")).toHaveCount(0);
    await expect(doc.locator("form")).toHaveCount(0);
  });

  test("carries more than one owner block and says what to do beyond them", async ({
    page,
  }) => {
    await page.goto("/pre-apps/blank-form");

    await expect(page.getByRole("heading", { name: "Owner 1" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Owner 2" })).toBeVisible();
    await expect(
      page.getByText(/Attach a further sheet/i),
      "no instruction for a third owner",
    ).toBeVisible();

    // An SSN box per owner, not one for the application — they are stored
    // against an owner id, and a sheet of SSNs away from the names is how they
    // get transcribed onto the wrong person.
    //
    // Anchored rather than `exact`, for two reasons: a field's label element
    // also carries its format hint ("… (123-45-6789)"), and the completeness
    // checklist mentions an SSN too — but that line opens "A social security
    // number …", so ^ excludes it without excluding the boxes.
    await expect(page.getByText(/^Social security number/)).toHaveCount(2);
  });
});

test.describe("a merchant's printable record", () => {
  test.use({ storageState: storageStateFor("agent") });

  test("drops the app chrome when printed, keeping the record", async ({
    page,
  }) => {
    const { docOwners } = await seedE2E();
    await page.goto(`/merchants/${docOwners.agent.merchant}/print`);

    await expect(page.getByRole("heading", { name: "Tasks" })).toBeVisible();

    await page.emulateMedia({ media: "print" });

    await expectChromeHidden(page);
    await expect(page.getByRole("heading", { name: "Notes" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Documents" })).toBeVisible();
  });

  test("shows nothing that looks like an SSN, routing or account number", async ({
    page,
  }) => {
    const { docOwners } = await seedE2E();
    await page.goto(`/merchants/${docOwners.agent.merchant}/print`);

    const body = await page.locator("article").innerText();

    // A merchant row has no such column, so this cannot fail today. It is here
    // to fail LATER, if someone wires read-pre-app-secrets into this page to
    // "complete the record" — which would add a decryption surface, and an
    // audit_log row, to a page built to be photocopied.
    expect(body, "an SSN-shaped value").not.toMatch(/\b\d{3}-\d{2}-\d{4}\b/);
    expect(body, "a routing/account-shaped run").not.toMatch(/\b\d{9,17}\b/);
    expect(body.toLowerCase()).not.toContain("routing");
    expect(body.toLowerCase()).not.toContain("social security");
  });
});

test.describe("another agent's merchant", () => {
  test.use({ storageState: storageStateFor("agent2") });

  test("refuses rather than admitting the record exists", async ({ page }) => {
    const { docOwners } = await seedE2E();

    await page.goto(`/merchants/${docOwners.agent.merchant}/print`);

    /**
     * Asserted on what renders, NOT on the HTTP status — and that is a property
     * of the app rather than a convenience.
     *
     * Under `cacheComponents` the static shell is flushed before the Suspense
     * boundary streams, so the headers are long gone by the time notFound()
     * runs: this returns **200** with not-found content in the body. Measured,
     * on this page and on /merchants/[id] alike, so it is the existing
     * behaviour of every record page rather than something new here.
     */
    await expect(page.getByText(/We couldn.t find that/)).toBeVisible();
    await expect(
      page.getByText(/belong to another rep/i),
      "the copy should not distinguish absent from not-yours",
    ).toBeVisible();

    // And none of the record leaked past the guard.
    await expect(page.getByRole("heading", { name: "Tasks" })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Documents" })).toHaveCount(0);
  });
});

/**
 * The line-items table, which is NOT the only table on a printed quote.
 *
 * components/print-document.tsx wraps every document in a real <table> so its
 * <thead> can repeat the letterhead on each sheet, so `article table` matches
 * the scaffold as well. Excluding it by its own marker attribute is exact, and
 * it fails loudly if that scaffold is ever swapped for something else rather
 * than silently starting to measure the wrong rows.
 */
const lineItems = (page: Page) =>
  page.locator("article table:not([data-print-document])");

/** "$1,446.50" as 1446.5, so a sum can be compared against a rendered figure. */
function money(text: string | null): number {
  return Number((text ?? "").replace(/[^0-9.-]/g, ""));
}

test.describe("a quote, laid out to hand to a merchant", () => {
  test.use({ storageState: storageStateFor("agent") });

  test("drops the app chrome when printed, keeping the quote", async ({
    page,
  }) => {
    const { quote } = await seedE2E();
    await page.goto(`/leads/${quote.leadId}/quotes/${quote.groupId}/print`);

    // The HEADING is the document type, not the rep's title. That is the
    // sheet saying what it is to the person holding it; "Countertop package"
    // says which one, and rides below as a subtitle.
    await expect(
      page.getByRole("heading", { name: "Hardware Proposal" }),
    ).toBeVisible();
    await expect(page.getByText(QUOTE_FIXTURE.title)).toBeVisible();

    await page.emulateMedia({ media: "print" });

    await expectChromeHidden(page);
    // The control row is screen-only; everything the merchant reads is not.
    await expect(page.getByRole("button", { name: /Print/ })).toBeHidden();
    await expect(
      page.getByRole("heading", { name: "Hardware Proposal" }),
      "the document lost its own header",
    ).toBeVisible();
    await expect(
      page.getByText(QUOTE_FIXTURE.title),
      "the rep's own title did not print",
    ).toBeVisible();
    await expect(
      page.getByText(QUOTE_LEAD_CONTACT.contact_name),
      "the merchant contact did not print",
    ).toBeVisible();
    await expect(lineItems(page)).toBeVisible();
  });

  test("prints the current version by default", async ({ page }) => {
    const { quote } = await seedE2E();
    await page.goto(`/leads/${quote.leadId}/quotes/${quote.groupId}/print`);

    // v2 by currentVersion(), with no ?quote= in the URL at all.
    await expect(page.getByText("Version 2 of 2")).toBeVisible();

    // Both of v2's lines, and not v1's single one.
    await expect(lineItems(page).locator("tbody tr")).toHaveCount(
      QUOTE_FIXTURE.v2.length,
    );
    await expect(
      page.getByText(/Superseded/),
      "the current version should not be marked superseded",
    ).toHaveCount(0);
  });

  test("prints a past version when the URL names one", async ({ page }) => {
    const { quote } = await seedE2E();
    await page.goto(
      `/leads/${quote.leadId}/quotes/${quote.groupId}/print?quote=${quote.firstId}`,
    );

    await expect(page.getByText("Version 1 of 2")).toBeVisible();
    await expect(lineItems(page).locator("tbody tr")).toHaveCount(
      QUOTE_FIXTURE.v1.length,
    );
  });

  /**
   * Its own spec rather than two assertions in the one above, and the split was
   * measured rather than assumed: dropping `quote = found` so the param is
   * ignored, and separately dropping the warning block, reddened the SAME
   * single spec. Two independent breaks landing on one spec is the shape
   * CLAUDE.md warns about — a failure there named neither cause.
   */
  test("marks a past version superseded, on the sheet itself", async ({
    page,
  }) => {
    const { quote } = await seedE2E();
    await page.goto(
      `/leads/${quote.leadId}/quotes/${quote.groupId}/print?quote=${quote.firstId}`,
    );

    // Under print media, not just on screen: a superseded version handed to a
    // merchant without this is indistinguishable from the current offer, and a
    // `print:hidden` swept onto it would be invisible to a screen assertion.
    await page.emulateMedia({ media: "print" });
    await expect(
      page.getByText(/Superseded — version 2 is the current one/),
      "a past version printed without saying so",
    ).toBeVisible();
  });

  test("totals the line items it shows", async ({ page }) => {
    const { quote } = await seedE2E();
    await page.goto(`/leads/${quote.leadId}/quotes/${quote.groupId}/print`);

    const table = lineItems(page);
    await expect(table.locator("tbody tr")).toHaveCount(QUOTE_FIXTURE.v2.length);

    // Derived from what is ON THE PAGE rather than from the fixture's
    // arithmetic, so this fails on a total that disagrees with its own lines —
    // which is the bug — rather than on the figures simply being different
    // from what this file expected.
    const rows = await table.locator("tbody tr").all();
    let summed = 0;
    for (const row of rows) {
      const cells = row.locator("td");
      const quantity = money(await cells.nth(1).textContent());
      const unitPrice = money(await cells.nth(2).textContent());
      const lineTotal = money(await cells.nth(3).textContent());

      expect(lineTotal, "a line total is not quantity × unit price").toBeCloseTo(
        quantity * unitPrice,
        2,
      );
      summed += lineTotal;
    }

    const printed = money(
      await table.locator("tfoot td").last().textContent(),
    );
    expect(printed, "the grand total is not the sum of the lines").toBeCloseTo(
      summed,
      2,
    );

    // And it is the arithmetic the fixture set up, so a page that summed a
    // completely different set of rows cannot pass the check above by being
    // internally consistent about the wrong ones.
    expect(printed).toBeCloseTo(1446.5, 2);
  });

  test("shows the price it was quoted at, not today's catalog price", async ({
    page,
  }) => {
    const { quote } = await seedE2E();
    await page.goto(`/leads/${quote.leadId}/quotes/${quote.groupId}/print`);

    const body = await page.locator("article").innerText();

    // The seed reprices both products AFTER saving the quote, so these two
    // figures can only both be checked from a browser — and a page that joined
    // `products` live would render a completely plausible document carrying
    // the second one. Nothing else in the suite would see it: no policy, type
    // or constraint is violated by printing the wrong price.
    for (const product of QUOTE_FIXTURE.products) {
      expect(
        body,
        `the snapshotted price of ${product.sku} is missing`,
      ).toContain(product.price.toFixed(2));
      expect(
        body,
        `${product.sku} printed at today's catalog price — the snapshot was ignored`,
      ).not.toContain(product.repricedTo.toFixed(2));
    }
  });
});

test.describe("another agent's quote", () => {
  test.use({ storageState: storageStateFor("agent2") });

  test("refuses rather than admitting the quote exists", async ({ page }) => {
    const { quote } = await seedE2E();

    await page.goto(`/leads/${quote.leadId}/quotes/${quote.groupId}/print`);

    // Asserted on what renders rather than on the HTTP status, for the reason
    // written up on the merchant case above: under `cacheComponents` the
    // static shell is flushed before the Suspense boundary streams, so
    // notFound() lands as 200 with not-found content in the body.
    await expect(page.getByText(/We couldn.t find that/)).toBeVisible();
    await expect(
      page.getByText(/belong to another rep/i),
      "the copy should not distinguish absent from not-yours",
    ).toBeVisible();

    // And nothing about the quote leaked past the guard — not the title, not
    // the merchant's contact, not a figure.
    await expect(page.getByText(QUOTE_FIXTURE.title)).toHaveCount(0);
    await expect(
      page.getByText(QUOTE_LEAD_CONTACT.contact_name),
    ).toHaveCount(0);
    await expect(lineItems(page)).toHaveCount(0);
  });
});

/**
 * The Tapswipe mark at the head of all four printed documents.
 *
 * Its own describe rather than an extra assertion inside the tests above, so a
 * failure here means one thing: the letterhead. The tests above are about the
 * chrome coming off, and a spec that can fail for two reasons is worse than
 * two that each fail for one.
 *
 * Three assertions, each pinning something different — and the third is here
 * because the second turned out not to pin what it was first written to pin:
 *
 *   - **toBeVisible** catches the class of bug this whole suite exists for — a
 *     broad print selector sweeping up something that belongs on the page, the
 *     way `header { display: none }` once took every document's own title.
 *     Measured: adding `print:hidden` to the component reds all four of these
 *     and nothing else.
 *   - **naturalWidth** separates a painted mark from an empty box. next/image
 *     lays out at its full size before it has any bytes, so toBeVisible passes
 *     on an image that would print as nothing.
 *   - **not lazy** is what actually pins `priority`. Deleting `priority` and
 *     re-running left the first two green: expect.poll simply waits out the
 *     fetch a top-of-page image issues anyway, and the race `priority` exists
 *     to prevent — print fired before the bytes land — is not one Playwright
 *     can stage. So the deferral is asserted directly instead.
 *
 *     Asserted as NOT "lazy" rather than as "eager", which is measured rather
 *     than assumed: Next 16 OMITS the attribute on a priority image (the
 *     rendered tag is `alt decoding="async" src srcset` and nothing else) and
 *     writes `loading="lazy"` only when it is absent. toHaveAttribute
 *     "eager" therefore reds on the correct markup — it did, once, here.
 */
async function expectLetterheadPrinted(page: Page) {
  // Scoped to the document: the sidebar renders the same file, with an empty
  // alt, and it is hidden on paper.
  const mark = page.locator("article img[alt='Tapswipe']");

  await expect(mark, "the letterhead did not print").toBeVisible();
  await expect
    .poll(
      () => mark.evaluate((img) => (img as HTMLImageElement).naturalWidth),
      { message: "the logo laid out but never loaded — it would print blank" },
    )
    .toBeGreaterThan(0);
  await expect(
    mark,
    "the logo is lazy again — it can lose a race with the print dialog",
  ).not.toHaveAttribute("loading", "lazy");
}

test.describe("the printed letterhead", () => {
  test.use({ storageState: storageStateFor("agent") });

  test("heads the blank application", async ({ page }) => {
    await page.goto("/pre-apps/blank-form");
    await expect(
      page.getByRole("heading", { name: "Merchant application" }),
    ).toBeVisible();

    await page.emulateMedia({ media: "print" });
    await expectLetterheadPrinted(page);
  });

  test("heads a merchant's record", async ({ page }) => {
    const { docOwners } = await seedE2E();
    await page.goto(`/merchants/${docOwners.agent.merchant}/print`);
    await expect(page.getByRole("heading", { name: "Tasks" })).toBeVisible();

    await page.emulateMedia({ media: "print" });
    await expectLetterheadPrinted(page);
  });

  test("heads a quote", async ({ page }) => {
    const { quote } = await seedE2E();
    await page.goto(`/leads/${quote.leadId}/quotes/${quote.groupId}/print`);
    await expect(
      page.getByRole("heading", { name: "Hardware Proposal" }),
    ).toBeVisible();

    await page.emulateMedia({ media: "print" });
    await expectLetterheadPrinted(page);
  });

  test("heads a merchant's proposal, on the route that shares the document", async ({
    page,
  }) => {
    // The fifth printable route. Worth its own letterhead check rather than
    // trusting the shared component: PrintDocument's running head is the one
    // element on these pages that must SURVIVE print media, and a route that
    // forgot to wrap its document in it would look identical on screen.
    const { merchantProposal } = await seedE2E();
    await page.goto(
      `/merchants/${merchantProposal.merchantId}/quotes/${merchantProposal.groupId}/print`,
    );
    await expect(
      page.getByRole("heading", { name: "Hardware Proposal" }),
    ).toBeVisible();

    await page.emulateMedia({ media: "print" });
    await expectLetterheadPrinted(page);
  });

  test("heads a payout summary", async ({ page }) => {
    await seedE2E();
    // Reached through the rep's own link rather than a hand-built URL, which
    // would need their uuid — and the link is what an admin or rep clicks.
    await page.goto(`/payouts/${PERIODS.many}`);
    const href = await page
      .getByRole("link", { name: "Payout summary" })
      .first()
      .getAttribute("href");
    await page.goto(href as string);
    await expect(
      page.getByRole("heading", { name: "Payout summary" }),
    ).toBeVisible();

    await page.emulateMedia({ media: "print" });
    await expectLetterheadPrinted(page);
  });

  /**
   * And on EVERY sheet, not just the first.
   *
   * The only assertion in this repo that reads a real paginated PDF, because
   * it is the only claim that has sheets in it. Everything above runs under
   * emulateMedia, which applies the print stylesheet without ever paginating,
   * so all three of those specs pass just as happily on a mark that appears
   * once and never again.
   *
   * The blank application is the subject because it is the only document here
   * that reliably runs to several sheets — six, on the fields the wizard
   * currently has. The other two are a sheet each, and a one-sheet document
   * cannot tell a running head from a static one.
   *
   * This is what pins the mechanism rather than the mark. Measured against
   * this document, `display: table-header-group` on a div repeats on no sheet
   * but the first, in every arrangement tried, and `position: fixed` drops off
   * the last — so the real <table> in components/print-document.tsx is load
   * bearing, and swapping it for either of the obvious simplifications reds
   * this and nothing else.
   */
  test("repeats on every sheet, not just the first", async ({ page }, info) => {
    // page.pdf() is headless-Chromium only. Skipped rather than failed when
    // someone runs the suite headed to watch it.
    test.skip(
      info.project.use.headless === false,
      "page.pdf() needs headless Chromium",
    );

    await page.goto("/pre-apps/blank-form");
    await expect(
      page.getByRole("heading", { name: "Merchant application" }),
    ).toBeVisible();
    await page.emulateMedia({ media: "print" });
    await expectLetterheadPrinted(page);

    const sheets = imagesPerPage(await page.pdf({ format: "Letter" }));

    expect(sheets.length, "the blank form stopped being a multi-sheet document")
      .toBeGreaterThan(1);
    expect(
      sheetMap(sheets),
      `the mark is missing from some sheets (O = has it): ${sheetMap(sheets)}`,
    ).toBe("O".repeat(sheets.length));
  });
});
