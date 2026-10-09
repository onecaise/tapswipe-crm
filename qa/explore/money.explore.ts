import fs from "node:fs";
import { test } from "@playwright/test";
import { STORE_FIXTURE, storageStateFor } from "../../e2e/fixtures/seed";
import { service } from "./stack";

const log: string[] = [];
const note = (s: string) => { log.push(s); console.log(s); };

test("proposal builder edge cases", async ({ browser }) => {
  test.setTimeout(600_000);
  const ctx = await browser.newContext({ storageState: storageStateFor("agent") });
  const page = await ctx.newPage();
  const errs: string[] = [];
  page.on("pageerror", (e) => errs.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errs.push(m.text().slice(0, 200)); });

  const start = async (customer: string) => {
    await page.goto("/proposals/new");
    await page.getByLabel("Not in the CRM — type a name").check();
    const name = page.getByLabel("Customer name", { exact: true });
    await name.fill(customer);
  };

  // A. huge quantity
  await start("QA Huge Qty Co");
  await page.getByRole("button", { name: `Add ${STORE_FIXTURE.device.name}` }).click();
  const qty = page.getByRole("spinbutton", { name: `Quantity of ${STORE_FIXTURE.device.name}` });
  await qty.fill("3000000000");
  await page.waitForTimeout(300);
  note(`huge qty totals: ${(await page.locator("dl").last().innerText()).replace(/\s+/g, " ")}`);
  await page.getByRole("button", { name: /Save proposal/ }).click();
  await page.waitForTimeout(2500);
  note(`huge qty save: url=${page.url()} msg=${(await page.getByTestId("proposal-builder").innerText()).split("\n").slice(-3).join(" | ")}`);
  await page.screenshot({ path: "qa/screens/money-hugeqty.png", fullPage: true });

  // B. decimal and negative typing
  await qty.fill("2.5");
  await page.waitForTimeout(200);
  note(`after 2.5: input=${await qty.inputValue()}`);
  await qty.fill("-3");
  await page.waitForTimeout(200);
  note(`after -3: input=${await qty.inputValue()}`);

  // C. blank title + quotes/emoji/sql in customer
  await start(`O'Brien "Café" 🍕; DROP TABLE quotes;--`);
  await page.getByRole("button", { name: `Add ${STORE_FIXTURE.device.name}` }).click();
  await page.getByRole("button", { name: /Add .* to / }).first().click().catch(() => note("no addon button"));
  note(`totals: ${(await page.locator("dl").last().innerText()).replace(/\s+/g, " ")}`);
  // double click save
  await page.getByRole("button", { name: /Save proposal/ }).dblclick();
  await page.waitForURL(/\/proposals\/[0-9a-f-]{36}/, { timeout: 15_000 }).catch(() => {});
  await page.waitForTimeout(1500);
  note(`after save: url=${page.url()} h1=${await page.locator("h1").innerText().catch(() => "")}`);
  await page.screenshot({ path: "qa/screens/money-weirdname.png", fullPage: true });
  const db = service();
  const { data: rows } = await db.from("quotes").select("id, title, version, customer_name").eq("customer_name", `O'Brien "Café" 🍕; DROP TABLE quotes;--`);
  note(`rows saved for weird customer: ${JSON.stringify(rows)}`);

  // D. revise to v2 and check version list / print
  const revise = page.getByRole("button", { name: /revise|new version|edit/i }).first();
  note(`revise buttons: ${await page.getByRole("button").allInnerTexts()}`);
  if (await revise.count()) {
    await revise.click();
    await page.waitForTimeout(500);
    await page.getByRole("button", { name: `Increase quantity of ${STORE_FIXTURE.device.name}` }).first().click();
    await page.getByRole("button", { name: /Save new version/ }).click();
    await page.waitForTimeout(2500);
    note(`after v2: ${(await page.locator("main").innerText()).replace(/\s+/g, " ").slice(0, 600)}`);
    await page.screenshot({ path: "qa/screens/money-v2.png", fullPage: true });
  }
  // print
  await page.goto(page.url().split("?")[0] + "/print");
  await page.waitForTimeout(1000);
  note(`print: ${(await page.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 700)}`);
  await page.screenshot({ path: "qa/screens/money-print.png", fullPage: true });

  note(`errors: ${errs.join(" || ")}`);
  await db.from("quotes").delete().in("customer_name", [`O'Brien "Café" 🍕; DROP TABLE quotes;--`, "QA Huge Qty Co"]);
  fs.writeFileSync("qa/screens/money.txt", log.join("\n"));
});
