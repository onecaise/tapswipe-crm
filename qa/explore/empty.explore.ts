import fs from "node:fs";
import { test } from "@playwright/test";
import { ensureQaUser, QA_PASSWORD } from "./stack";

const log: string[] = [];
const note = (s: string) => { log.push(s); console.log(s); };

test("empty states for a brand-new rep", async ({ browser }) => {
  test.setTimeout(600_000);
  const email = "qa-empty-rep@tapswipe.test";
  await ensureQaUser(email, {});
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  const errs: string[] = [];
  page.on("pageerror", (e) => errs.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errs.push(`@${page.url()} ${m.text().slice(0, 200)}`); });
  await page.goto("/auth/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(QA_PASSWORD);
  await page.getByRole("button", { name: "Login" }).click();
  await page.waitForURL(/dashboard/);
  fs.mkdirSync("qa/screens/empty", { recursive: true });
  for (const p of ["/dashboard", "/leads", "/ghost-sheets", "/merchants", "/pre-apps", "/support-tickets", "/documents", "/notes", "/tasks", "/payouts", "/proposals", "/marketing"]) {
    await page.goto(p);
    await page.waitForLoadState("networkidle");
    const t = (await page.locator("main:visible").innerText()).replace(/\s+/g, " ");
    const sw = await page.evaluate(() => document.documentElement.scrollWidth);
    note(`${p} [sw=${sw}]: ${t.slice(0, 260)}`);
    await page.screenshot({ path: `qa/screens/empty/${p.replace(/\//g, "_")}.png`, fullPage: true });
  }
  note(`errors: ${errs.join(" || ")}`);
  fs.writeFileSync("qa/screens/empty.txt", log.join("\n"));
});
