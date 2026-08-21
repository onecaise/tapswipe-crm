import { expect, test } from "@playwright/test";

import { PERIODS, storageStateFor } from "./fixtures/seed";

/**
 * The period states: many rows, one row, none at all, and a malformed URL.
 *
 * The point of most of these is that the page has a defined answer rather than a
 * crash or an empty frame. An empty period in particular is a deliberate 404 and
 * not an "0 rows" table — showing which periods exist and which do not would make
 * the URL an oracle for what other reps earned, and the 404 copy says so.
 */

test.use({ storageState: storageStateFor("agent") });

test("a period with many rows renders the whole ledger", async ({ page }) => {
  await page.goto(`/payouts/${PERIODS.many}`);

  await expect(page.getByRole("heading", { name: "April 2027" })).toBeVisible();
  // Seven data rows (six ordinary, plus the long-name one) and the header row.
  await expect(page.getByRole("row")).toHaveCount(8);
  await expect(page.getByText("7 merchants")).toBeVisible();
});

test("a period with exactly one row says 'merchant', not 'merchants'", async ({
  page,
}) => {
  await page.goto(`/payouts/${PERIODS.single}`);

  await expect(page.getByRole("heading", { name: "May 2027" })).toBeVisible();
  await expect(page.getByRole("cell", { name: "E2E-SOLO" })).toBeVisible();
  // The singular. A pluralisation bug is trivial and also the kind of thing
  // nobody notices until a rep with one merchant sees it.
  await expect(page.getByText("1 merchant ·")).toBeVisible();
  await expect(page.getByText("1 merchants")).toHaveCount(0);
});

/**
 * These assert the RENDERED not-found state, not the HTTP status, and that is a
 * deliberate limitation rather than an oversight.
 *
 * `notFound()` is called inside the page's Suspense boundary, which is where
 * cacheComponents requires the dynamic read to live. By the time it runs, the
 * shell has already been streamed and the 200 header is long gone — so these
 * URLs are SOFT 404s: correct not-found UI, 200 status. Verified: /payouts/2027-13
 * responds 200 with the not-found heading.
 *
 * Left as-is rather than "fixed". Moving the query above the boundary to get a
 * real status is exactly what the comments in these pages explain they cannot
 * do, and the app is behind auth, so nothing crawls it. What would be affected is
 * monitoring — a dashboard counting 4xx will see none of these — which is worth
 * knowing and is why it is written down here rather than silently asserted away.
 */
const expectNotFoundPage = async (page: import("@playwright/test").Page) => {
  await expect(
    page.getByRole("heading", { name: /couldn.t find that/i }),
  ).toBeVisible();
};

test("a period with no rows is a not-found page with a way out, not a crash", async ({
  page,
}) => {
  await page.goto(`/payouts/${PERIODS.empty}`);

  await expectNotFoundPage(page);
  // Inside the app shell, with a route out — not a bare framework error page.
  // This is the "renders something sane" half: a crash would lose the nav.
  await expect(
    page.getByRole("link", { name: /back to dashboard/i }),
  ).toBeVisible();
  await expect(page.getByRole("navigation")).toBeVisible();

  // And no half-rendered ledger behind it.
  await expect(page.getByRole("table")).toHaveCount(0);
});

test("a malformed period segment is refused rather than falling back to a default", async ({
  page,
}) => {
  // parsePeriodParam's unit tests cover the parsing; this covers the wiring, and
  // specifically that a bad segment does not quietly render SOME period. Showing
  // one month's figures under another month's URL is the kind of wrong that gets
  // paid out before anyone notices.
  for (const bad of ["2027-13", "2027-00", "not-a-period", "2027-1"]) {
    await page.goto(`/payouts/${bad}`);
    await expectNotFoundPage(page);
    // The assertion that matters: no table, so no figures under a bogus URL.
    await expect(page.getByRole("table"), `/payouts/${bad}`).toHaveCount(0);
  }
});

test("the periods list links to each period it lists", async ({ page }) => {
  await page.goto("/payouts");

  // The three periods this suite owns that have rows for this rep.
  for (const label of ["April 2027", "May 2027", "March 2027"]) {
    await expect(page.getByRole("link", { name: label })).toBeVisible();
  }
  // And not the empty one, which has no rows for anybody.
  await expect(
    page.getByRole("link", { name: "September 2027" }),
  ).toHaveCount(0);

  await page.getByRole("link", { name: "May 2027" }).click();
  await expect(page).toHaveURL(/\/payouts\/2027-05$/);
  await expect(page.getByRole("cell", { name: "E2E-SOLO" })).toBeVisible();
});
