import { expect, test, type Page, type Request } from "@playwright/test";

import {
  clearAdminReveals,
  clearSecretsDrafts,
  PERSONAS,
  revealAuditRows,
  SECRETS_FIXTURE,
  secretsPreApp,
  storageStateFor,
} from "../fixtures/seed";
import { idsFor } from "./qa-stack";

/**
 * Phase 5 (docs/design/intake-and-reports.md §1.E, A24) in a browser: the
 * pre-app detail page's "Sensitive data" section.
 *
 * tests/live/pre-app-secrets.test.ts owns the function (tiers, the 403 for a
 * rep, the audit row, fails-closed, the rate limit). What only a browser shows:
 *
 *   - the rep sees the last four of every secret, presence for the password,
 *     and no Show; the server HTML holds no digit of any of it;
 *   - the admin sees the same masked view by default; Show reveals ONE value,
 *     writes ONE audit row, and the value is in no URL, no request body, no
 *     storage and no console line;
 *   - it is masked again after 30 seconds, when the tab is hidden, on
 *     navigation and before printing, and a print never shows it;
 *   - the server-rendered pages (detail, wizard, blank form, a print page)
 *     never contain a full value.
 */

const F = SECRETS_FIXTURE;
const FULL = [F.ssn, F.routing, F.account, F.rpPassword, F.ein];
const LAST4 = {
  ssn: F.ssn.slice(-4),
  routing: F.routing.slice(-4),
  account: F.account.slice(-4),
  ein: F.ein.slice(-4),
};

function carries(request: Request, needle: string): boolean {
  return request.url().includes(needle) || (request.postData() ?? "").includes(needle);
}

/** The section, once its client fetch has answered. */
async function section(page: Page) {
  const region = page.getByRole("region", { name: "Sensitive data" });
  await expect(region.getByText(`····${LAST4.ein}`)).toBeVisible();
  return region;
}

async function serverHtml(page: Page, path: string): Promise<string> {
  const res = await page.request.get(path);
  expect(res.status(), path).toBe(200);
  return res.text();
}

async function storageDump(page: Page): Promise<string> {
  return page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
}

let preAppId: number;
let ownerId: number;

test.beforeAll(async () => {
  ({ id: preAppId, ownerId } = await secretsPreApp());
});

test.afterAll(async () => {
  await clearAdminReveals();
  await clearSecretsDrafts();
});

test.describe("as the rep", () => {
  test.use({ storageState: storageStateFor("agent") });

  test("sees the last four of every secret, presence for the password, and no Show", async ({ page }) => {
    await page.goto(`/pre-apps/${preAppId}`);
    const region = await section(page);

    await expect(region.getByText(`SSN — ${F.ownerName}`)).toBeVisible();
    for (const last4 of Object.values(LAST4)) {
      await expect(region.getByText(`····${last4}`, { exact: true })).toBeVisible();
    }
    await expect(region.getByText("On file", { exact: true })).toBeVisible();
    await expect(region.getByRole("button", { name: /^Show/ })).toHaveCount(0);

    const dom = await page.content();
    for (const value of FULL) expect(dom, value).not.toContain(value);

    // Client-fetched: the server's HTML has not even the masked form.
    const raw = await serverHtml(page, `/pre-apps/${preAppId}`);
    expect(raw).not.toContain("····");
    for (const value of FULL) expect(raw, value).not.toContain(value);
  });
});

test.describe("as an admin", () => {
  test.use({ storageState: storageStateFor("admin") });

  test.beforeEach(async () => {
    await clearAdminReveals();
  });

  test("sees the same masked view by default, with a Show per field and no full value", async ({ page }) => {
    // What the default read sends this admin, not just what the page draws.
    const bodies: Promise<string>[] = [];
    page.on("response", (res) => {
      if (res.url().includes("/functions/v1/read-pre-app-secrets")) bodies.push(res.text());
    });
    await page.goto(`/pre-apps/${preAppId}`);
    const region = await section(page);
    expect(bodies.length).toBeGreaterThan(0);
    for (const body of await Promise.all(bodies)) {
      expect(body).toContain('"tier":"last4"');
      for (const value of FULL) expect(body, value).not.toContain(value);
    }
    for (const name of [
      "Show tax ID",
      `Show SSN for ${F.ownerName}`,
      "Show routing number",
      "Show account number",
      "Show RP password",
    ]) {
      await expect(region.getByRole("button", { name, exact: true })).toBeVisible();
    }
    const dom = await page.content();
    for (const value of FULL) expect(dom, value).not.toContain(value);
    expect(await revealAuditRows(preAppId)).toEqual([]);
  });

  test("Show reveals one value and writes exactly one audit row; the value goes nowhere else", async ({ page }) => {
    const { personaId: adminId } = await idsFor(PERSONAS.admin.email, "admin");
    const requests: Request[] = [];
    const consoleLines: string[] = [];
    page.on("request", (r) => requests.push(r));
    page.on("console", (m) => consoleLines.push(m.text()));

    await page.goto(`/pre-apps/${preAppId}`);
    const region = await section(page);

    await region.getByRole("button", { name: `Show SSN for ${F.ownerName}`, exact: true }).click();
    await expect(region.getByText(F.ssn, { exact: true })).toBeVisible();
    // Only that one: the other values stay masked.
    for (const other of FULL.filter((v) => v !== F.ssn)) {
      expect(await page.content(), other).not.toContain(other);
    }

    expect(await revealAuditRows(preAppId)).toEqual([
      { actor_id: adminId, action: `read_pre_app_secrets:reveal:owner_ssn:${ownerId}` },
    ]);

    expect(page.url()).not.toContain(F.ssn.slice(-4));
    expect(await storageDump(page)).not.toContain(F.ssn);
    expect(requests.filter((r) => carries(r, F.ssn) || carries(r, F.ssn.replace(/-/g, "")))).toEqual([]);
    expect(consoleLines.filter((line) => line.includes(F.ssn))).toEqual([]);

    // Hide masks it at once, and a second Show is a second row.
    await region.getByRole("button", { name: `Hide SSN for ${F.ownerName}`, exact: true }).click();
    await expect(region.getByText(F.ssn, { exact: true })).toHaveCount(0);
    await region.getByRole("button", { name: `Show SSN for ${F.ownerName}`, exact: true }).click();
    await expect(region.getByText(F.ssn, { exact: true })).toBeVisible();
    expect(await revealAuditRows(preAppId)).toHaveLength(2);
  });

  test("masks the value again after 30 seconds", async ({ page }) => {
    await page.clock.install();
    await page.goto(`/pre-apps/${preAppId}`);
    const region = await section(page);
    await region.getByRole("button", { name: "Show account number", exact: true }).click();
    await expect(region.getByText(F.account, { exact: true })).toBeVisible();

    await page.clock.fastForward(29_000);
    await expect(region.getByText(F.account, { exact: true })).toBeVisible();
    await page.clock.fastForward(2_000);
    await expect(region.getByText(F.account, { exact: true })).toHaveCount(0);
    await expect(region.getByText(`····${LAST4.account}`, { exact: true })).toBeVisible();
  });

  test("masks the value again when the tab is hidden", async ({ page }) => {
    await page.goto(`/pre-apps/${preAppId}`);
    const region = await section(page);
    await region.getByRole("button", { name: "Show RP password", exact: true }).click();
    await expect(region.getByText(F.rpPassword, { exact: true })).toBeVisible();

    await page.evaluate(() => {
      Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect(region.getByText(F.rpPassword, { exact: true })).toHaveCount(0);
    expect(await page.content()).not.toContain(F.rpPassword);
  });

  test("masks the value again on navigation, and it is not there on the way back", async ({ page }) => {
    await page.goto(`/pre-apps/${preAppId}`);
    let region = await section(page);
    await region.getByRole("button", { name: "Show tax ID", exact: true }).click();
    await expect(region.getByText(F.ein, { exact: true })).toBeVisible();

    await page.getByRole("link", { name: "Back to pre-apps" }).click();
    await expect(page).toHaveURL(/\/pre-apps$/);
    await expect(page.getByRole("heading", { name: "Pre-Apps", exact: true })).toBeVisible();
    // Next 16 with cacheComponents keeps the route just left in the document,
    // hidden (React <Activity>), with its state. The mask runs in the effect
    // cleanup that hiding triggers, so the value must leave the WHOLE
    // document, hidden subtree included.
    await expect.poll(() => page.content(), { timeout: 5_000 }).not.toContain(F.ein);

    await page.goBack();
    region = await section(page);
    await expect(region.getByText(F.ein, { exact: true })).toHaveCount(0);
    expect(await page.content()).not.toContain(F.ein);
  });

  test("a revealed value never prints, and printing masks it", async ({ page }) => {
    await page.goto(`/pre-apps/${preAppId}`);
    const region = await section(page);
    await region.getByRole("button", { name: "Show routing number", exact: true }).click();
    const value = region.getByText(F.routing, { exact: true });
    await expect(value).toBeVisible();

    // Print media alone (no beforeprint): the value is hidden and the masked
    // form prints in its place.
    await page.emulateMedia({ media: "print" });
    await expect(value).toBeHidden();
    await expect(region.getByText(`····${LAST4.routing}`, { exact: true })).toBeVisible();
    const printed = await page.locator("main").innerText();
    expect(printed).not.toContain(F.routing);

    // And the print itself masks it in state, not just on paper.
    await page.emulateMedia({ media: "screen" });
    await page.evaluate(() => window.dispatchEvent(new Event("beforeprint")));
    await expect(value).toHaveCount(0);
  });

  test("no server-rendered page carries a full value: detail, wizard, blank form, a print page", async ({ page }) => {
    // A reveal first, so a value exists in this session to leak.
    await page.goto(`/pre-apps/${preAppId}`);
    const region = await section(page);
    await region.getByRole("button", { name: "Show tax ID", exact: true }).click();
    await expect(region.getByText(F.ein, { exact: true })).toBeVisible();

    const { merchant } = await idsFor(PERSONAS.agent.email, "agent");
    for (const path of [
      `/pre-apps/${preAppId}`,
      `/pre-apps/${preAppId}/edit?step=secrets`,
      `/pre-apps/${preAppId}/edit?step=review`,
      "/pre-apps/blank-form",
      `/merchants/${merchant}/print`,
    ]) {
      const raw = await serverHtml(page, path);
      for (const v of FULL) expect(raw, `${path}: ${v}`).not.toContain(v);
    }

    // The wizard's secrets step, rendered, shows an admin the last four only.
    await page.goto(`/pre-apps/${preAppId}/edit?step=secrets`);
    await expect(page.getByText(`EIN: on file — ····${LAST4.ein}.`)).toBeVisible();
    await expect(page.getByText(`Account: on file — ····${LAST4.account}.`)).toBeVisible();
    await expect(page.getByText("On file.", { exact: true })).toBeVisible();
    const dom = await page.content();
    for (const v of FULL) expect(dom, v).not.toContain(v);
  });
});
