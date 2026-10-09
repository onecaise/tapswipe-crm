import fs from "node:fs";
import { test } from "@playwright/test";
import { E2E_PASSWORD, PERSONAS, storageStateFor } from "../../e2e/fixtures/seed";
import { service } from "./stack";

const log: string[] = [];
const note = (s: string) => { log.push(s); console.log(s); };
const EMAIL = "qa-created-user@tapswipe.test";

async function removeUser(email: string) {
  const db = service();
  const { data } = await db.auth.admin.listUsers({ perPage: 1000 });
  const u = data.users.find((x) => x.email === email);
  if (!u) return;
  await db.from("audit_log").delete().eq("actor_id", u.id);
  await db.from("audit_log").delete().eq("row_id", u.id);
  await db.from("profiles").delete().eq("id", u.id);
  const { error } = await db.auth.admin.deleteUser(u.id);
  if (error) note(`cleanup ${email}: ${error.message}`);
}

test("admin user management", async ({ browser }) => {
  test.setTimeout(600_000);
  await removeUser(EMAIL);
  const page = await (await browser.newContext({ storageState: storageStateFor("admin") })).newPage();
  const errs: string[] = [];
  page.on("pageerror", (e) => errs.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errs.push(`@${page.url()} ${m.text().slice(0, 200)}`); });

  await page.goto("/admin/users/new");
  await page.getByLabel("Full name").fill(`QA O'Created "User" 🍕`);
  await page.getByLabel("Email").fill(EMAIL);
  await page.getByLabel("One-time password").fill("qa-temp-pass-1");
  await page.getByLabel("Agent # (optional)").fill(PERSONAS.agent.agentNumber); // taken
  await page.getByRole("button", { name: "Create user" }).click();
  await page.waitForTimeout(3000);
  note(`create w/ taken agent#: ${(await page.locator("main:visible .text-destructive").allInnerTexts()).join(" / ")}`);
  await page.getByLabel("Agent # (optional)").fill("");
  await page.getByRole("button", { name: "Create user" }).click();
  await page.waitForTimeout(3000);
  note(`create: ${(await page.locator("main:visible").innerText()).replace(/\s+/g, " ").slice(0, 500)}`);
  // duplicate email
  await page.goto("/admin/users/new");
  await page.getByLabel("Full name").fill("QA Dup");
  await page.getByLabel("Email").fill(PERSONAS.agent.email.toUpperCase());
  await page.getByLabel("One-time password").fill("qa-temp-pass-1");
  await page.getByRole("button", { name: "Create user" }).click();
  await page.waitForTimeout(3000);
  note(`dup email (upper): ${(await page.locator("main:visible .text-destructive").allInnerTexts()).join(" / ")}`);

  // row actions on the created user
  await page.goto("/admin/users");
  await page.waitForLoadState("networkidle");
  const row = page.getByRole("row").filter({ hasText: EMAIL }).first();
  note(`row: ${(await row.innerText().catch(() => "NO ROW")).replace(/\s+/g, " ")}`);
  await row.getByRole("button", { name: "Reset password" }).click().catch((e) => note("reset btn " + e));
  await row.getByRole("button", { name: "Confirm" }).click().catch((e) => note("confirm " + e));
  await page.waitForTimeout(3000);
  note(`after reset: ${(await row.innerText().catch(() => "?")).replace(/\s+/g, " ")}`);
  await row.getByRole("button", { name: "Done" }).click().catch(() => {});
  await row.getByRole("button", { name: /Deactivate/ }).click().catch((e) => note("deact btn " + e));
  await row.getByRole("button", { name: "Confirm" }).click().catch((e) => note("confirm2 " + e));
  await page.waitForTimeout(3000);
  note(`after deactivate: ${(await row.innerText().catch(() => "?")).replace(/\s+/g, " ")}`);
  const db = service();
  const { data: prof } = await db.from("profiles").select("is_active, must_change_password").eq("email", EMAIL).maybeSingle();
  note(`db profile: ${JSON.stringify(prof)}`);
  // admin deactivating themself?
  const me = page.getByRole("row").filter({ hasText: PERSONAS.admin.email }).first();
  note(`own row buttons: ${(await me.getByRole("button").allInnerTexts().catch(() => [])).join(" / ")} | role select disabled=${await me.locator("select").isDisabled().catch(() => "n/a")}`);
  await page.screenshot({ path: "qa/screens/users.png", fullPage: true });
  note(`errors: ${errs.join(" || ")}`);
  await removeUser(EMAIL);
  fs.writeFileSync("qa/screens/users.txt", log.join("\n"));
  void E2E_PASSWORD;
});
