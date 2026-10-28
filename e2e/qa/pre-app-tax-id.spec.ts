import { expect, test, type Page, type Request } from "@playwright/test";

import { freshWizardDraft, storageStateFor } from "../fixtures/seed";
import { service } from "./qa-stack";

/**
 * The business tax ID in a browser (pre_app_tax_secrets, 20261026140000; phase
 * 3 of docs/design/intake-and-reports.md).
 *
 * tests/rls/pre-app-tax-secrets.test.ts owns the table, the grants and the
 * submit rule; tests/live/pre-app-secrets.test.ts owns the functions' tiers and
 * validators. What only a browser shows is the WIRING:
 *
 *   - the Business step asks for the EIN TYPE only, as a select that autosaves,
 *     and has no box for the number;
 *   - the number is typed on the Sensitive data step and travels in exactly one
 *     request, to submit-pre-app-secrets: never in an autosave PATCH, never in
 *     a URL, never logged to the console, and it is gone from the page once
 *     saved, which then shows the last four only;
 *   - switching the EIN type after the number was entered shows that the
 *     number must be entered again, on the secrets step and on the review step.
 *
 * Numbers no real holder has: the IRS does not assign EIN prefix 07.
 */

test.use({ storageState: storageStateFor("agent") });

const EIN = "07-1351357";
const EIN_DIGITS = "071351357";

async function setEinType(id: number, type: "EIN" | "SSN" | null): Promise<void> {
  const { error } = await service().from("pre_apps").update({ ein_type: type }).eq("id", id);
  if (error) throw new Error(error.message);
}

function carries(request: Request, needle: string): boolean {
  return (
    request.url().includes(needle) ||
    (request.postData() ?? "").includes(needle)
  );
}

/** Every request and console line from here on, to search for the number. */
function watch(page: Page) {
  const requests: Request[] = [];
  const console: string[] = [];
  page.on("request", (request) => requests.push(request));
  page.on("console", (message) => console.push(message.text()));
  return { requests, console };
}

test("the Business step asks for the EIN type only, and autosaves it", async ({ page }) => {
  const id = await freshWizardDraft({ city: "Nashville", state: "TN" });
  await page.goto(`/pre-apps/${id}/edit?step=business`);
  // See e2e/processor-select.spec.ts: a select changed in the first moment
  // after load is reset (pre-existing, recorded in the phase 1 notes).
  await page.waitForLoadState("networkidle");

  const type = page.getByRole("combobox", { name: "EIN type", exact: true });
  await expect(type.locator("option")).toHaveText(["—", "EIN", "SSN"]);
  // No box for the number on this step any more: it is a secret.
  await expect(page.getByRole("textbox", { name: "EIN", exact: true })).toHaveCount(0);

  await type.selectOption("SSN");
  await expect(page.getByText(/^Saved /)).toBeVisible({ timeout: 10_000 });
  const { data } = await service().from("pre_apps").select("ein_type").eq("id", id).single();
  expect(data?.ein_type).toBe("SSN");
});

test("the tax ID goes only to the secrets function, and comes back as the last four", async ({ page }) => {
  const id = await freshWizardDraft({ city: "Nashville", state: "TN" });
  await setEinType(id, "EIN");
  const seen = watch(page);

  await page.goto(`/pre-apps/${id}/edit?step=secrets`);
  const input = page.getByRole("textbox", { name: "EIN", exact: true });
  await expect(input).toBeVisible();
  // The same opt-outs as the SSN and bank inputs (A2).
  await expect(input).toHaveAttribute("autocomplete", "off");
  await expect(input).toHaveAttribute("inputmode", "numeric");
  await expect(page.getByText("EIN: not on file.")).toBeVisible();

  // pressSequentially does not wait for an input to be enabled, and since
  // phase 4 the wizard holds its controls disabled until it has hydrated
  // (components/pre-app-wizard-shell.tsx); typed earlier, the digits would
  // go nowhere.
  await expect(input).toBeEnabled();
  await input.pressSequentially(EIN_DIGITS);
  await expect(input).toHaveValue(EIN);
  await page.getByRole("button", { name: "Encrypt & save" }).click();
  await expect(page.getByText("Saved and cleared from this page.")).toBeVisible();

  // Cleared from the input, and shown back as the last four only.
  await expect(input).toHaveValue("");
  await expect(page.getByText("EIN: on file — ····1357.")).toBeVisible();
  const html = await page.content();
  expect(html).not.toContain(EIN);
  expect(html).not.toContain(EIN_DIGITS);

  // Exactly one request carried it: the POST to submit-pre-app-secrets.
  const carriers = seen.requests.filter(
    (r) => carries(r, EIN) || carries(r, EIN_DIGITS),
  );
  expect(carriers.map((r) => `${r.method()} ${new URL(r.url()).pathname}`)).toEqual([
    "POST /functions/v1/submit-pre-app-secrets",
  ]);
  expect(page.url()).not.toContain(EIN_DIGITS.slice(-4));
  expect(seen.console.filter((line) => line.includes(EIN) || line.includes(EIN_DIGITS))).toEqual([]);

  // The pre-app detail page shows the type only, never a digit of the number.
  await page.goto(`/pre-apps/${id}`);
  await expect(page.getByText("EIN type", { exact: true })).toBeVisible();
  const detail = await page.content();
  expect(detail).not.toContain(EIN);
  expect(detail).not.toContain("1357");
});

test("switching the EIN type after the number was entered asks for it again", async ({ page }) => {
  const id = await freshWizardDraft({ city: "Nashville", state: "TN" });
  await setEinType(id, "EIN");
  await page.goto(`/pre-apps/${id}/edit?step=secrets`);
  const ein = page.getByRole("textbox", { name: "EIN", exact: true });
  await expect(ein).toBeEnabled();
  await ein.pressSequentially(EIN_DIGITS);
  await page.getByRole("button", { name: "Encrypt & save" }).click();
  await expect(page.getByText("EIN: on file — ····1357.")).toBeVisible();

  // Switched through the real Business step, so autosave is what wrote it.
  await page.goto(`/pre-apps/${id}/edit?step=business`);
  await page.waitForLoadState("networkidle");
  await page.getByRole("combobox", { name: "EIN type", exact: true }).selectOption("SSN");
  await expect(page.getByText(/^Saved /)).toBeVisible({ timeout: 10_000 });

  const mismatch = "The tax ID on file is an EIN, but EIN type says SSN. Enter the SSN.";
  await page.goto(`/pre-apps/${id}/edit?step=secrets`);
  await expect(page.getByRole("textbox", { name: "SSN (business tax ID)" })).toBeVisible();
  await expect(page.getByText(mismatch)).toBeVisible();

  await page.goto(`/pre-apps/${id}/edit?step=review`);
  await expect(page.getByText(mismatch)).toBeVisible();
});
