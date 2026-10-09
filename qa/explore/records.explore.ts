import fs from "node:fs";
import { test, type Page } from "@playwright/test";
import { storageStateFor } from "../../e2e/fixtures/seed";
import { service } from "./stack";

const log: string[] = [];
const note = (s: string) => { log.push(s); console.log(s); };
const main = async (p: Page) => (await p.locator("main:visible").innerText()).replace(/\s+/g, " ");
const WEIRD = `QA O'Brien "Café" 🍕 <b>x</b> %_ ; DROP TABLE leads;--`;
const LONG = "QA " + "Extraordinarily-long-unbroken-business-name-".repeat(6);

test("leads, ghost sheets, merchants, tickets", async ({ browser }) => {
  test.setTimeout(900_000);
  const db = service();
  await db.from("leads").delete().like("dba", "QA %");
  await db.from("ghost_sheets").delete().like("dba", "QA %");
  await db.from("support_tickets").delete().like("subject", "QA %");
  await db.from("merchants").delete().like("dba", "QA %");

  const ctx = await browser.newContext({ storageState: storageStateFor("agent"), viewport: { width: 390, height: 844 } });
  await ctx.addInitScript(() => {
    const orig = console.error;
    console.error = (...a: unknown[]) => {
      try {
        (window as unknown as { __qa: string[] }).__qa ??= [];
        (window as unknown as { __qa: string[] }).__qa.push(a.map((x) => (x instanceof Error ? x.stack : typeof x === "object" ? JSON.stringify(x) : String(x))).join(" | "));
      } catch {}
      orig(...a);
    };
  });
  const page = await ctx.newPage();
  const errs: string[] = [];
  page.on("pageerror", (e) => errs.push("PAGE " + e.message));
  page.on("console", async (m) => { if (m.type() !== "error") return; const a = await Promise.all(m.args().map((x) => x.jsonValue().catch(() => "?"))); errs.push("CONSOLE @" + page.url() + " " + a.map((v) => typeof v === "string" ? v : JSON.stringify(v)).join(" ").slice(0, 5000)); });
  page.on("response", (r) => { if (r.status() >= 400) errs.push(`HTTP ${r.status()} ${r.url().slice(0, 140)}`); });

  // ---------- Leads
  for (const dba of [WEIRD, LONG]) {
    await page.goto("/leads/new");
    await page.locator("#dba").fill(dba);
    await page.getByLabel("Contact phone", { exact: true }).fill("5555550199");
    await page.getByRole("button", { name: /Create/ }).click();
    await page.waitForTimeout(1500);
    const anyway = page.getByRole("button", { name: "Create anyway" });
    if (await anyway.count()) await anyway.click();
    await page.waitForURL(/\/leads\/\d+$/, { timeout: 15_000 }).catch(() => {});
    note(`lead create ${dba.slice(0, 20)}: url=${page.url()} | ${(await main(page)).slice(0, 250)}`);
    const sw = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
    note(`  scroll ${sw}`);
    await page.screenshot({ path: `qa/screens/rec-lead-${dba.length}.png`, fullPage: true });
  }
  const leadUrl = page.url();
  // edit: status change to lost without reason, then blank
  await page.goto(leadUrl + "/edit");
  const stage = page.getByLabel("Stage");
  note(`stage options: ${(await stage.locator("option").allInnerTexts()).join(",")}`);
  await stage.selectOption({ label: "Lost" }).catch((e) => note("no Lost " + e));
  await page.waitForTimeout(300);
  note(`lost no reason: submit enabled=${await page.getByRole("button", { name: /Save changes/ }).isEnabled()} | ${(await main(page)).slice(-300)}`);
  await page.getByLabel(/Why was it lost/).fill("QA price");
  await page.getByRole("button", { name: /Save changes/ }).click();
  await page.waitForURL(/\/leads\/\d+$/, { timeout: 15_000 }).catch(() => {});
  note(`after lost save: ${page.url()} | ${(await main(page)).slice(0, 200)}`);
  // double submit on create
  await page.goto("/leads/new");
  await page.locator("#dba").fill("QA Double Submit");
  await page.getByRole("button", { name: /Create/ }).dblclick();
  await page.waitForTimeout(4000);
  const { count: dbl } = await db.from("leads").select("*", { count: "exact", head: true }).eq("dba", "QA Double Submit");
  note(`double submit leads rows: ${dbl}`);
  // search + filters
  for (const q of ["/leads?q=O'Brien", "/leads?q=%25", "/leads?q=" + encodeURIComponent("'; select 1;--"), "/leads?status=lost", "/leads?status=bogus", "/leads?followup=overdue", "/leads?page=999", "/leads?page=-1"]) {
    await page.goto(q);
    await page.waitForLoadState("networkidle").catch(() => {});
    note(`${q}: ${(await main(page)).slice(240, 650)}`);
  }

  // ---------- Ghost sheets
  await page.goto("/ghost-sheets/new");
  note(`ghost new labels: ${(await page.locator("label").allInnerTexts()).join("|")}`);
  await page.getByLabel(/DBA/).first().fill("QA Ghost " + WEIRD);
  await page.getByRole("button", { name: /Save|Create|Add/ }).first().click();
  await page.waitForTimeout(3000);
  note(`ghost created: ${page.url()} | ${(await main(page)).slice(0, 300)}`);
  const convert = page.getByRole("button", { name: /Convert/ });
  if (await convert.count()) {
    await convert.first().click();
    await page.waitForTimeout(3000);
    note(`ghost convert: ${page.url()} | ${(await main(page)).slice(0, 300)}`);
  }

  // ---------- Merchants (agent)
  await page.goto("/merchants/new");
  await page.waitForTimeout(3000);
  note(`QA console capture @merchants/new: ${await page.evaluate(() => JSON.stringify((window as unknown as { __qa?: string[] }).__qa ?? []))}`);
  note(`merchant new: ${(await main(page)).slice(0, 300)}`);
  await page.screenshot({ path: "qa/screens/rec-merchant-new.png", fullPage: true });

  // ---------- Support ticket
  await page.goto("/support-tickets/new");
  note(`ticket labels: ${(await page.locator("label").allInnerTexts()).join("|")}`);
  await page.getByLabel(/Subject/).fill("QA ticket " + WEIRD);
  await page.getByLabel("Details").first().fill(LONG + "\n\nline two");
  await page.getByRole("button", { name: "Open ticket" }).click();
  await page.waitForTimeout(3000);
  note(`ticket: ${page.url()} | ${(await main(page)).slice(0, 300)}`);
  await page.screenshot({ path: "qa/screens/rec-ticket.png", fullPage: true });
  const sw = await page.evaluate(() => [document.documentElement.scrollWidth, document.documentElement.clientWidth]);
  note(`  ticket scroll ${sw}`);
  // reply
  const reply = page.getByLabel("Write a reply");
  if (await reply.count()) {
    await reply.fill("QA reply 🍕");
    await page.getByRole("button", { name: /reply|send/i }).first().click();
    await page.waitForTimeout(2500);
    note(`ticket after reply: ${(await main(page)).slice(-300)}`);
  }

  note(`errors: ${errs.join(" || ")}`);
  fs.writeFileSync("qa/screens/records.txt", log.join("\n"));
});
