import { expect, test } from "@playwright/test";

import {
  PERIODS,
  SHARE_FIXTURE,
  publicStackConfig,
  storageStateFor,
} from "./fixtures/seed";

/**
 * A committed payout line is never edited (phase 11 of
 * docs/design/intake-and-reports.md, 20261102140000) -- not by an admin
 * either. This file used to drive the inline figure cell and the per-rep bulk
 * split; both are gone, with the account-total control on a shared pair. A
 * fix is a replace of the processor-month until it is marked paid, or an
 * adjustment line after (payouts-paid.spec.ts, payouts-adjustments.spec.ts).
 *
 * What only a browser shows: that an ADMIN -- the one role that used to be
 * offered the controls -- now gets none, on an ordinary period and on a
 * shared pair; and that the session the browser holds cannot edit a line
 * through the API either. payouts-roles.spec.ts covers a rep.
 */

test.use({ storageState: storageStateFor("admin") });

/** The access token the signed-in browser holds (see payouts-roles.spec.ts). */
async function accessTokenFrom(page: import("@playwright/test").Page): Promise<string | null> {
  const cookies = await page.context().cookies();
  const authCookie = cookies.find((c) => c.name.endsWith("-auth-token"));
  if (!authCookie) return null;
  const raw = authCookie.value.startsWith("base64-")
    ? Buffer.from(authCookie.value.slice("base64-".length), "base64").toString("utf8")
    : decodeURIComponent(authCookie.value);
  try {
    return (JSON.parse(raw) as { access_token?: string }).access_token ?? null;
  } catch {
    return null;
  }
}

test("an admin is offered no way to edit a figure: no inputs, no bulk split", async ({ page }) => {
  await page.goto(`/payouts/${PERIODS.many}`);
  // The page is the ledger: it rendered, with its figures as text.
  await expect(page.getByRole("row", { name: /E2E-A1000/ })).toContainText("55%");

  await expect(page.getByRole("textbox")).toHaveCount(0);
  await expect(page.getByLabel(/^Residual income for /)).toHaveCount(0);
  await expect(page.getByLabel(/^Rep split for /)).toHaveCount(0);
  await expect(page.getByLabel(/^Split percentage for all of /)).toHaveCount(0);
  for (const name of ["Apply", "Set split", "Save"]) {
    await expect(page.getByRole("button", { name, exact: true }), name).toHaveCount(0);
  }
});

test("on a shared pair, the admin sees both parties and the account residual, and no control sets it", async ({ page }) => {
  await page.goto(`/payouts/${SHARE_FIXTURE.period}`);
  const markers = page.getByTestId("payout-share-marker");
  await expect(markers).toHaveCount(2);
  await expect(markers.first()).toContainText("account residual $1,234.56");
  await expect(page.getByTestId("shared-residual-control")).toHaveCount(0);
  await expect(page.getByRole("button", { name: /account total/i })).toHaveCount(0);
  await expect(page.getByRole("textbox")).toHaveCount(0);
});

test("the admin's own session cannot edit a line through the API: refused (403, 42501), nothing changes", async ({ page, request }) => {
  await page.goto(`/payouts/${PERIODS.many}`);
  const { apiUrl, publishableKey } = publicStackConfig();
  const token = await accessTokenFrom(page);
  expect(token, "the signed-in page should hold an access token").toBeTruthy();

  for (const data of [{ rep_split_pct: 99 }, { residual_income: 1 }]) {
    const response = await request.patch(`${apiUrl}/rest/v1/rep_payout_rows?mid=eq.E2E-A1000`, {
      headers: {
        apikey: publishableKey,
        Authorization: `Bearer ${token as string}`,
        "Content-Type": "application/json",
        Prefer: "count=exact",
      },
      data,
    });
    // Refused, not filtered: no client holds UPDATE on the ledger any more.
    expect(response.status(), JSON.stringify(data)).toBe(403);
    expect((await response.json()).code).toBe("42501");
  }

  await page.reload();
  await expect(page.getByRole("row", { name: /E2E-A1000/ })).toContainText("55%");
});
