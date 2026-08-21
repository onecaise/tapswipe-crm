import { expect, test } from "@playwright/test";

import {
  commitEvidence,
  createCommittableBatch,
  storageStateFor,
} from "./fixtures/seed";

/**
 * Committing an import, and committing it exactly once.
 *
 * The RPC's own guards are asserted in tests/rls (47 tests, including the
 * sequential double-commit). What these add is the click: that the UI cannot
 * produce a second commit, and that a committed batch reports itself honestly
 * afterwards.
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

test("commits a clean batch and lands on the periods list", async ({ page }) => {
  const batchId = await createCommittableBatch("2027-06", 3);
  await page.goto(`/payouts/import/${batchId}`);

  await expect(page.getByText("Review")).toBeVisible();
  await page.getByRole("button", { name: /commit 3 rows/i }).click();
  await page.getByRole("button", { name: "Commit import" }).click();

  // The RPC returns how many rows it wrote; the button carries that into the URL.
  await expect(page).toHaveURL(/\/payouts\?imported=3$/);

  const evidence = await commitEvidence(batchId);
  expect(evidence).toEqual({
    auditRows: 1,
    ledgerRows: 3,
    status: "committed",
    stagingLeft: 0,
  });
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

  await expect(page).toHaveURL(/\/payouts\?imported=/);

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
  await expect(pageA).toHaveURL(/\/payouts\?imported=2$/);

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
  await expect(page).toHaveURL(/\/payouts\?imported=/);

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
  await expect(page).toHaveURL(/\/payouts\?imported=/);

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
  await expect(page.getByText("Blocked")).toHaveCount(0);
});
