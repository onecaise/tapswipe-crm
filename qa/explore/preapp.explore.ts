import fs from "node:fs";
import { test, type Page } from "@playwright/test";
import { storageStateFor } from "../../e2e/fixtures/seed";
import { service } from "./stack";

const log: string[] = [];
const note = (s: string) => { log.push(s); console.log(s); };
const DBA = "QA-PREAPP-WALK";
const text = async (p: Page) => (await p.locator("main:visible").innerText()).replace(/\s+/g, " ");

test("walk the pre-app wizard with fake data", async ({ browser }) => {
  test.setTimeout(900_000);
  const db = service();
  const { data: old } = await db.from("pre_apps").select("id").eq("dba_name", DBA);
  for (const o of old ?? []) {
    await db.from("pre_app_owner_secrets").delete().in("pre_app_owner_id", ((await db.from("pre_app_owners").select("id").eq("pre_app_id", o.id)).data ?? []).map((r) => r.id));
    await db.from("pre_app_banking_secrets").delete().eq("pre_app_id", o.id);
    await db.from("pre_app_terminal_secrets").delete().eq("pre_app_id", o.id);
    await db.from("pre_app_owners").delete().eq("pre_app_id", o.id);
    await db.from("pre_app_terminal").delete().eq("pre_app_id", o.id);
    await db.from("pre_app_business_profile").delete().eq("pre_app_id", o.id);
    await db.from("pre_apps").delete().eq("id", o.id);
  }

  const ctx = await browser.newContext({ storageState: storageStateFor("agent") });
  const page = await ctx.newPage();
  const errs: string[] = [];
  page.on("pageerror", (e) => errs.push("PAGE " + e.message));
  page.on("console", (m) => { if (m.type() === "error") errs.push("CONSOLE " + m.text().slice(0, 200)); });
  page.on("response", (r) => { if (r.status() >= 400) errs.push(`HTTP ${r.status()} ${r.url().slice(0, 120)}`); });

  await page.goto("/pre-apps/new");
  await page.getByLabel("DBA name *").fill(DBA);
  await page.getByLabel("Legal business name *").fill("QA Pre-App Walk LLC");
  await page.getByRole("button", { name: /create|start|save/i }).first().click();
  await page.waitForURL(/\/pre-apps\/\d+\/edit/, { timeout: 20_000 });
  const id = /pre-apps\/(\d+)/.exec(page.url())![1];
  note(`created pre-app ${id}: ${page.url()}`);

  // Business
  const fill = async (label: string, value: string) => {
    const el = page.getByLabel(label, { exact: true });
    if (await el.count() !== 1) { note(`  label "${label}" count=${await el.count()}`); return; }
    await el.fill(value);
  };
  await fill("Contact name", "Pat Q. Tester 🍕");
  await fill("Contact phone", "5555550100");
  await fill("Email", "qa@example.test");
  await fill("Website", "example.test");
  await fill("Street address", `1 O'Brien "Main" St; DROP TABLE pre_apps;--`);
  await fill("City", "Testville");
  await fill("ZIP", "12345");
  await fill("EIN", "001234567");
  await fill("Agent split %", "60");
  await fill("Estimated annual volume", "1200000");
  await fill("Estimated monthly volume", "100000.5");
  await fill("Average ticket", "abc");
  await page.waitForTimeout(3500);
  note(`business: ${(await text(page)).slice(0, 200)} … status=${(await text(page)).match(/(Saved|Saving|Unsaved|Couldn.t save|failed)[^.]{0,60}/i)?.[0]}`);
  await page.screenshot({ path: "qa/screens/preapp-business.png", fullPage: true });
  const { data: row } = await db.from("pre_apps").select("*").eq("id", id).single();
  note(`db business: ${JSON.stringify(row)}`);

  // Owners
  await page.goto(`/pre-apps/${id}/edit?step=owners`);
  await page.getByRole("button", { name: "Add owner" }).click();
  await page.waitForTimeout(1500);
  await fill("Name", "Owner One");
  await fill("Ownership %", "100");
  await fill("Date of birth", "1980-02-28");
  await page.waitForTimeout(3000);
  note(`owners: ${(await text(page)).slice(0, 400)}`);
  await page.screenshot({ path: "qa/screens/preapp-owners.png", fullPage: true });

  // Profile
  await page.goto(`/pre-apps/${id}/edit?step=profile`);
  await fill("Swiped %", "70");
  await fill("Keyed %", "50");
  await page.waitForTimeout(3000);
  note(`profile: ${(await text(page)).slice(0, 300)}`);

  // Secrets
  await page.goto(`/pre-apps/${id}/edit?step=secrets`);
  await page.waitForTimeout(1500);
  const ssn = page.getByRole("textbox", { name: "Owner One" });
  if (await ssn.count()) await ssn.fill("078051120");
  await page.getByRole("textbox", { name: "ABA routing number" }).fill("123456780");
  await page.getByRole("textbox", { name: "Account number" }).fill("000123456789");
  await page.getByLabel("RP password").fill("qa-fake-rp");
  await page.getByRole("button", { name: "Encrypt & save" }).click();
  await page.waitForTimeout(4000);
  note(`secrets: ${(await text(page)).slice(0, 600)}`);
  await page.screenshot({ path: "qa/screens/preapp-secrets.png", fullPage: true });
  const { count: bank } = await db.from("pre_app_banking_secrets").select("*", { count: "exact", head: true }).eq("pre_app_id", id);
  note(`banking secret rows: ${bank}`);
  // reload — does on-file show last4 only?
  await page.reload();
  await page.waitForTimeout(2000);
  note(`secrets after reload: ${(await text(page)).slice(0, 600)}`);

  // Review
  await page.goto(`/pre-apps/${id}/edit?step=review`);
  await page.waitForTimeout(1500);
  note(`review: ${(await text(page)).slice(0, 900)}`);
  await page.screenshot({ path: "qa/screens/preapp-review.png", fullPage: true });

  // Detail page
  await page.goto(`/pre-apps/${id}`);
  await page.waitForTimeout(1500);
  note(`detail: ${(await text(page)).slice(0, 700)}`);
  await page.screenshot({ path: "qa/screens/preapp-detail.png", fullPage: true });

  note(`errors: ${errs.join(" || ")}`);
  fs.writeFileSync("qa/screens/preapp.txt", log.join("\n"));
});
