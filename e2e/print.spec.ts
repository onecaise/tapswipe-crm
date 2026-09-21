import { expect, test, type Page } from "@playwright/test";

import { PERIODS, seedE2E, storageStateFor } from "./fixtures/seed";

/**
 * The printable pages: a blank application, one merchant's record, and — for
 * the letterhead only — a payout summary. The summary's own content is covered
 * by the payouts specs; it is here because the mark is shared by all three.
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
 * The Tapswipe mark at the head of all three printed documents.
 *
 * Its own describe rather than an extra assertion inside the three tests
 * above, so a failure here means one thing: the letterhead. The tests above
 * are about the chrome coming off, and a spec that can fail for two reasons is
 * worse than two that each fail for one.
 *
 * Three assertions, each pinning something different — and the third is here
 * because the second turned out not to pin what it was first written to pin:
 *
 *   - **toBeVisible** catches the class of bug this whole suite exists for — a
 *     broad print selector sweeping up something that belongs on the page, the
 *     way `header { display: none }` once took every document's own title.
 *     Measured: adding `print:hidden` to the component reds all three of these
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

  test("heads a payout summary", async ({ page }) => {
    await seedE2E();
    // Reached through the rep's own link rather than a hand-built URL, which
    // would need their uuid — and the link is what an admin or rep actually
    // clicks.
    await page.goto(`/payouts/${PERIODS.many}`);
    await page.getByRole("link", { name: "Payout summary" }).first().click();
    await expect(
      page.getByRole("heading", { name: "Payout summary" }),
    ).toBeVisible();

    await page.emulateMedia({ media: "print" });
    await expectLetterheadPrinted(page);
  });
});
