import { expect, test } from "@playwright/test";

import {
  batchConfirmations,
  commitEvidence,
  createCommittableBatch,
  storageStateFor,
} from "./fixtures/seed";

/**
 * Committing an import, and committing it exactly once.
 *
 * The RPC's own guards are asserted in tests/rls/commit-residual-import-v3.test.ts
 * (including the sequential double-commit). What these add is the click: that
 * the UI cannot produce a second commit, that a committed batch reports itself
 * honestly afterwards, and that the review screen's Yes reaches the database
 * (v3 refuses a warning type it was not given).
 *
 * Each spec creates its OWN batch, because a commit is destructive to its batch —
 * sharing one would make the second spec depend on the first not having run.
 *
 * Note what is NOT here: the concurrent-commit case. Two overlapping
 * transactions is what the `for update` lock in 20260821171000 exists for, and
 * reproducing it needs two held-open database transactions — which no browser
 * can arrange, since each PostgREST request is its own transaction. That property
 * is pinned by grep in tests/rls/commit-residual-import.test.ts, with the
 * reproduction written up in the migration.
 */

test.use({ storageState: storageStateFor("admin") });

test("commits a clean batch and lands on its commit result", async ({ page }) => {
  const batchId = await createCommittableBatch("2027-06", 3);
  await page.goto(`/payouts/import/${batchId}`);

  await expect(page.getByText("Review")).toBeVisible();
  await page.getByRole("button", { name: /commit 3 rows/i }).click();
  await page.getByRole("button", { name: "Commit import" }).click();

  // The button lands on the batch, whose committed page reports what was
  // imported, read back from the batch.
  await expect(page).toHaveURL(new RegExp(`/payouts/import/${batchId}$`));
  await expect(
    page.locator('[data-slot="stat-card"]').filter({ hasText: "Rows imported" }),
  ).toContainText("3");
  // Nothing was skipped, so there is nothing to review.
  await expect(page.getByTestId("residual-skips-notice")).toHaveCount(0);
  await expect(page.getByText("Rows skipped")).toHaveCount(0);

  const evidence = await commitEvidence(batchId);
  expect(evidence).toEqual({
    auditRows: 1,
    ledgerRows: 3,
    status: "committed",
    stagingLeft: 0,
  });
});

test("a Yes on the review screen is what lets the commit through", async ({ page }) => {
  // The first row is a negative-volume refund month: the bad_numbers warning.
  const batchId = await createCommittableBatch("2027-09", 2, { badNumbers: true });
  await page.goto(`/payouts/import/${batchId}`);

  const block = page.getByRole("group", {
    name: "Volume is negative, or the residual is more than the volume",
  });
  await expect(block).toContainText("Row 2");
  // No commit until the type is answered.
  await expect(page.getByRole("button", { name: /commit 2 rows/i })).toHaveCount(0);
  await block.getByRole("button", { name: "Yes" }).click();

  await page.getByRole("button", { name: /commit 2 rows/i }).click();
  await page.getByRole("button", { name: "Commit import" }).click();
  await expect(
    page.locator('[data-slot="stat-card"]').filter({ hasText: "Rows imported" }),
  ).toContainText("2");

  // v3 recomputed the warning and accepted it only because the button sent
  // the Yes; the batch keeps what was confirmed, with its row.
  expect(await batchConfirmations(batchId)).toEqual({ bad_numbers: [2] });
  expect(await commitEvidence(batchId)).toMatchObject({ auditRows: 1, ledgerRows: 2, status: "committed" });
});

test("a double-click commits exactly once", async ({ page }) => {
  const batchId = await createCommittableBatch("2027-07", 2);
  await page.goto(`/payouts/import/${batchId}`);

  await page.getByRole("button", { name: /commit 2 rows/i }).click();

  // A real double-click on the confirm control. Three things stand between this
  // and a double commit, and all three should hold: the button's own busy flag,
  // the confirm step unmounting after the first click, and the RPC's status
  // check behind a row lock.
  await page.getByRole("button", { name: "Commit import" }).dblclick();

  await expect(page).toHaveURL(new RegExp(`/payouts/import/${batchId}$`));
  // The commit result is the page the button was already on, so the URL alone
  // proves nothing: wait for the committed figures to render.
  await expect(
    page.locator('[data-slot="stat-card"]').filter({ hasText: "Rows imported" }),
  ).toBeVisible();

  const evidence = await commitEvidence(batchId);
  // One audit row is the assertion that matters. Two would mean the trail claims
  // one batch was committed twice, in the table whose whole job is being the
  // authoritative record.
  expect(evidence.auditRows).toBe(1);
  expect(evidence.ledgerRows).toBe(2);
  expect(evidence.status).toBe("committed");
  expect(evidence.stagingLeft).toBe(0);
});

test("two tabs cannot both commit the same batch", async ({ browser }) => {
  const batchId = await createCommittableBatch("2027-08", 2);

  // Two independent contexts, both signed in as the admin, both looking at the
  // same batch — the "I left it open in another tab" case.
  const contextA = await browser.newContext({
    storageState: storageStateFor("admin"),
  });
  const contextB = await browser.newContext({
    storageState: storageStateFor("admin"),
  });
  const pageA = await contextA.newPage();
  const pageB = await contextB.newPage();

  await pageA.goto(`/payouts/import/${batchId}`);
  await pageB.goto(`/payouts/import/${batchId}`);

  // Both reach the confirm step while the batch is still in review.
  await pageA.getByRole("button", { name: /commit 2 rows/i }).click();
  await pageB.getByRole("button", { name: /commit 2 rows/i }).click();

  await pageA.getByRole("button", { name: "Commit import" }).click();
  await expect(pageA).toHaveURL(new RegExp(`/payouts/import/${batchId}$`));
  // The commit result is the page the button was already on, so the URL alone
  // proves nothing: wait for the committed figures to render.
  await expect(
    pageA.locator('[data-slot="stat-card"]').filter({ hasText: "Rows imported" }),
  ).toBeVisible();

  // The second tab's button is still sitting there, against a batch that is now
  // committed. Clicking it must be refused rather than doing it again.
  await pageB.getByRole("button", { name: "Commit import" }).click();
  await expect(pageB.getByText(/already committed/i)).toBeVisible();

  const evidence = await commitEvidence(batchId);
  expect(evidence.auditRows).toBe(1);
  expect(evidence.ledgerRows).toBe(2);

  await contextA.close();
  await contextB.close();
});

test("a committed batch offers no way to commit it again", async ({ page }) => {
  const batchId = await createCommittableBatch("2027-10", 1);
  await page.goto(`/payouts/import/${batchId}`);
  await page.getByRole("button", { name: /commit 1 row/i }).click();
  await page.getByRole("button", { name: "Commit import" }).click();
  await expect(page).toHaveURL(new RegExp(`/payouts/import/${batchId}$`));
  // The commit result is the page the button was already on, so the URL alone
  // proves nothing: wait for the committed figures to render.
  await expect(
    page.locator('[data-slot="stat-card"]').filter({ hasText: "Rows imported" }),
  ).toBeVisible();

  // Back to the batch, now settled. Matching the STATUS BADGE, whose DOM text is
  // the raw lowercase status ("committed", capitalised by CSS) — not the
  // "Committed" stat-card label added alongside it, which would otherwise make
  // this ambiguous.
  await page.goto(`/payouts/import/${batchId}`);
  await expect(page.getByText("committed", { exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: /commit/i })).toHaveCount(0);
});

test("a committed batch reports the rows it imported, not zero", async ({
  page,
}) => {
  const batchId = await createCommittableBatch("2027-11", 3);
  await page.goto(`/payouts/import/${batchId}`);
  await page.getByRole("button", { name: /commit 3 rows/i }).click();
  await page.getByRole("button", { name: "Commit import" }).click();
  await expect(page).toHaveURL(new RegExp(`/payouts/import/${batchId}$`));
  // The commit result is the page the button was already on, so the URL alone
  // proves nothing: wait for the committed figures to render.
  await expect(
    page.locator('[data-slot="stat-card"]').filter({ hasText: "Rows imported" }),
  ).toBeVisible();

  await page.goto(`/payouts/import/${batchId}`);

  // The regression: the review counts derive from staging rows, which commit
  // deletes — so this page read "Rows in the file 0 / Ready 0 / Blocked 0",
  // making a successful import of three rows look like an empty one. Exactly the
  // confusion the RPC's `staged = 0` guard exists to prevent, reintroduced on the
  // page that reports the result.
  const imported = page
    .locator('[data-slot="stat-card"]')
    .filter({ hasText: "Rows imported" });
  await expect(imported).toBeVisible();
  await expect(imported).toContainText("3");

  // And the review-only figures are gone rather than showing misleading zeroes.
  await expect(page.getByText("Rows in the file")).toHaveCount(0);
  // "Refused" since phase 7 (the review-only count was "Blocked").
  await expect(page.getByText("Refused")).toHaveCount(0);
  await expect(page.getByText("Blocked")).toHaveCount(0);
});
