import { expect, test, type Page } from "@playwright/test";

import { storageStateFor } from "./fixtures/seed";

/**
 * The md-and-up "hide the sidebar" toggle (SidebarCollapseToggle in
 * components/sidebar-drawer.tsx), in a browser.
 *
 * Browser-only claims: that the panel actually disappears and the content takes
 * the width, that the choice survives a reload WITHOUT React's help (the
 * pre-paint script, proven here by refusing the app's JavaScript), and that a
 * phone is untouched by a choice made at desktop width.
 *
 * Each test gets a fresh browser context, so localStorage starts empty and no
 * test inherits another's choice. The agent persona is enough: the toggle is
 * the same for every role.
 */

test.use({ storageState: storageStateFor("agent") });

const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };

const sidebar = (page: Page) => page.locator("#app-sidebar");
const hideButton = (page: Page) => page.getByRole("button", { name: "Hide menu" });
const showButton = (page: Page) => page.getByRole("button", { name: "Show menu" });

async function mainBox(page: Page) {
  const box = await page.locator("main").boundingBox();
  if (!box) throw new Error("main has no box");
  return box;
}

test("hides and shows the sidebar on a desktop, and the content takes the width", async ({
  page,
}) => {
  await page.setViewportSize(DESKTOP);
  await page.goto("/dashboard");

  await expect(sidebar(page)).toBeVisible();
  await expect(hideButton(page)).toHaveAttribute("aria-expanded", "true");
  await expect(hideButton(page)).toHaveAttribute("aria-controls", "app-sidebar");
  // The phone hamburger is not the desktop control.
  await expect(page.getByRole("button", { name: "Open navigation" })).toBeHidden();

  const before = await mainBox(page);
  expect(before.x).toBeGreaterThanOrEqual(240);

  await hideButton(page).click();

  await expect(sidebar(page)).toBeHidden();
  await expect(showButton(page)).toHaveAttribute("aria-expanded", "false");
  // Not icon-only while it is the only way back.
  await expect(showButton(page)).toContainText("Menu");

  const after = await mainBox(page);
  expect(after.x).toBe(0);
  expect(after.width).toBeGreaterThan(before.width + 240);

  await showButton(page).click();
  await expect(sidebar(page)).toBeVisible();
  await expect(page.getByRole("navigation")).toBeVisible();
  await expect(hideButton(page)).toHaveAttribute("aria-expanded", "true");
});

test("works from the keyboard", async ({ page }) => {
  await page.setViewportSize(DESKTOP);
  await page.goto("/dashboard");

  await hideButton(page).focus();
  await page.keyboard.press("Enter");
  await expect(sidebar(page)).toBeHidden();

  // Focus stays on the control, which is now the way back.
  await expect(showButton(page)).toBeFocused();
  await page.keyboard.press("Space");
  await expect(sidebar(page)).toBeVisible();
  await expect(hideButton(page)).toBeFocused();
});

test("remembers the choice across a reload, applied before any app script runs", async ({
  page,
}) => {
  await page.setViewportSize(DESKTOP);
  await page.goto("/dashboard");
  await hideButton(page).click();
  await expect(sidebar(page)).toBeHidden();

  await page.reload();
  await expect(sidebar(page)).toBeHidden();
  await expect(showButton(page)).toBeVisible();

  // The no-flash claim. With every Next chunk refused, React never hydrates,
  // so nothing but the inline pre-paint script can be hiding the panel — the
  // server-rendered <aside> is in the HTML and would otherwise show.
  await page.route("**/_next/static/chunks/**", (route) => route.abort());
  await page.goto("/dashboard");
  await expect(sidebar(page)).toBeAttached();
  await expect(sidebar(page)).toBeHidden();
  await page.unroute("**/_next/static/chunks/**");

  // Shown again is remembered too.
  await page.goto("/dashboard");
  await showButton(page).click();
  await page.reload();
  await expect(sidebar(page)).toBeVisible();
  await expect(hideButton(page)).toBeVisible();
});

test("a phone keeps its drawer, even after hiding the sidebar at desktop width", async ({
  page,
}) => {
  await page.setViewportSize(DESKTOP);
  await page.goto("/dashboard");
  await hideButton(page).click();
  await expect(sidebar(page)).toBeHidden();

  await page.setViewportSize(PHONE);
  await page.reload();

  // The desktop toggle is absent; the hamburger is the control, as before.
  await expect(hideButton(page)).toBeHidden();
  await expect(showButton(page)).toBeHidden();
  const hamburger = page.getByRole("button", { name: "Open navigation" });
  await expect(hamburger).toBeVisible();

  // Parked off-canvas (invisible), and opened by the hamburger as always.
  await expect(sidebar(page)).toBeHidden();
  await hamburger.click();
  await expect(sidebar(page)).toBeVisible();
  await expect(page.getByRole("navigation")).toBeVisible();
  await expect(sidebar(page)).toHaveCSS("display", "flex");

  await page.getByRole("button", { name: "Close navigation" }).click();
  await expect(sidebar(page)).toBeHidden();
});

test("still works when storage is unavailable", async ({ page }) => {
  await page.addInitScript(() => {
    const fail = () => {
      throw new Error("storage blocked");
    };
    Storage.prototype.getItem = fail;
    Storage.prototype.setItem = fail;
    Storage.prototype.removeItem = fail;
  });

  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));

  await page.setViewportSize(DESKTOP);
  await page.goto("/dashboard");
  await expect(sidebar(page)).toBeVisible();

  await hideButton(page).click();
  await expect(sidebar(page)).toBeHidden();
  await showButton(page).click();
  await expect(sidebar(page)).toBeVisible();

  expect(errors).toEqual([]);
});
