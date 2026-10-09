import fs from "node:fs";
import { test } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { E2E_PASSWORD, PERSONAS, storageStateFor } from "../../e2e/fixtures/seed";

const log: string[] = [];
const note = (s: string) => { log.push(s); console.log(s); };

test("keyboard, drawer, tap targets, back/refresh, axe at 390", async ({ browser }) => {
  test.setTimeout(900_000);

  // 1. Log in with the keyboard only
  const anon = await (await browser.newContext()).newPage();
  await anon.goto("/auth/login");
  await anon.keyboard.press("Tab");
  const first = await anon.evaluate(() => document.activeElement?.outerHTML.slice(0, 120));
  note(`login first tab stop: ${first}`);
  await anon.keyboard.type(PERSONAS.agent2.email);
  await anon.keyboard.press("Tab");
  await anon.keyboard.type(E2E_PASSWORD);
  await anon.keyboard.press("Enter");
  await anon.waitForURL(/dashboard/, { timeout: 15_000 }).catch(() => {});
  note(`keyboard login landed: ${anon.url()}`);

  // 2. Tab through the shell: is focus visible? where does tab order go?
  const page = await (await browser.newContext({ storageState: storageStateFor("agent"), viewport: { width: 390, height: 844 } })).newPage();
  await page.goto("/leads");
  await page.waitForLoadState("networkidle");
  const stops: string[] = [];
  for (let i = 0; i < 12; i++) {
    await page.keyboard.press("Tab");
    stops.push(await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el) return "none";
      const cs = getComputedStyle(el);
      const ring = cs.boxShadow !== "none" || (cs.outlineStyle !== "none" && cs.outlineWidth !== "0px");
      const r = el.getBoundingClientRect();
      return `${el.tagName.toLowerCase()}[${(el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 25)}] ring=${ring} visible=${r.width > 0 && r.bottom > 0 && r.top < innerHeight}`;
    }));
  }
  note(`390 /leads tab order:\n   ${stops.join("\n   ")}`);

  // 3. Mobile drawer: open with keyboard, escape closes, focus returns
  const menu = page.getByRole("button", { name: /menu|navigation/i }).first();
  note(`menu button: ${await menu.getAttribute("aria-label").catch(() => "?")} expanded=${await menu.getAttribute("aria-expanded").catch(() => "?")}`);
  await menu.focus();
  await page.keyboard.press("Enter");
  await page.waitForTimeout(500);
  note(`drawer open: expanded=${await menu.getAttribute("aria-expanded").catch(() => "?")} focus=${await page.evaluate(() => document.activeElement?.textContent?.trim().slice(0, 30))}`);
  const axeDrawer = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa"]).analyze();
  note(`axe with drawer open: ${axeDrawer.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id} x${v.nodes.length} ${v.nodes[0].target}`).join(" | ")}`);
  await page.keyboard.press("Escape");
  await page.waitForTimeout(400);
  note(`after Escape: expanded=${await menu.getAttribute("aria-expanded").catch(() => "?")} focus=${await page.evaluate(() => document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.tagName)}`);

  // 4. Tap targets under 24px at 390 on a few pages
  for (const p of ["/leads", "/dashboard", "/proposals/new", "/tasks"]) {
    await page.goto(p);
    await page.waitForLoadState("networkidle");
    const small = await page.evaluate(() =>
      Array.from(document.querySelectorAll("a, button, input, select, [role=button]"))
        .filter((el) => { const r = (el as HTMLElement).getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && (r.width < 24 || r.height < 24) && !(el as HTMLInputElement).type?.match?.(/checkbox|radio|hidden/); })
        .map((el) => { const r = (el as HTMLElement).getBoundingClientRect(); return `${el.tagName.toLowerCase()}[${((el as HTMLElement).getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 20)}] ${Math.round(r.width)}x${Math.round(r.height)}`; }),
    );
    note(`small targets ${p}: ${small.slice(0, 10).join(", ")}${small.length > 10 ? ` (+${small.length - 10})` : ""}`);
    const axe = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21aa"]).analyze();
    note(`axe 390 ${p}: ${axe.violations.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id} x${v.nodes.length} ${v.nodes[0].target}`).join(" | ")}`);
  }

  // 5. Back button after save, refresh mid-form
  await page.goto("/support-tickets/new");
  await page.getByLabel(/Subject/).fill("QA refresh mid-form");
  await page.reload();
  await page.waitForLoadState("networkidle");
  note(`after reload subject value: "${await page.getByLabel(/Subject/).inputValue()}"`);
  await page.goto("/leads/new");
  await page.locator("#dba").fill("QA back button lead");
  await page.getByRole("button", { name: /Create/ }).click();
  await page.waitForURL(/\/leads\/\d+$/, { timeout: 15_000 }).catch(() => {});
  await page.goBack();
  await page.waitForTimeout(1500);
  note(`back after create: url=${page.url()} dba="${await page.locator("#dba").inputValue().catch(() => "n/a")}"`);

  fs.writeFileSync("qa/screens/keyboard.txt", log.join("\n"));
});
