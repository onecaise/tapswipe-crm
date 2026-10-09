import fs from "node:fs";
import { test, expect } from "@playwright/test";
import { PERSONAS, E2E_PASSWORD, storageStateFor } from "../../e2e/fixtures/seed";
import { service } from "./stack";

const QA_PW = "qa-test-password-123";
const log: string[] = [];
const note = (s: string) => { log.push(s); console.log(s); };

async function ensureUser(email: string, profile: Record<string, unknown> | null) {
  const db = service();
  const { data } = await db.auth.admin.listUsers({ perPage: 1000 });
  let user = data.users.find((u) => u.email === email);
  if (!user) {
    const created = await db.auth.admin.createUser({ email, password: QA_PW, email_confirm: true });
    if (created.error) throw created.error;
    user = created.data.user!;
  }
  await db.auth.admin.updateUserById(user.id, { password: QA_PW, ban_duration: "none" });
  if (profile) {
    await db.from("profiles").upsert({ id: user.id, email, full_name: email, role: "agent", is_active: true, must_change_password: false, ...profile });
  } else {
    await db.from("profiles").delete().eq("id", user.id);
  }
  return user.id;
}

test("auth edge cases", async ({ browser }) => {
  test.setTimeout(600_000);
  const fresh = async () => (await browser.newContext()).newPage();

  // 1. bad credentials
  let page = await fresh();
  await page.goto("/auth/login");
  await page.getByLabel("Email").fill(PERSONAS.agent.email);
  await page.getByLabel("Password").fill("wrong-password");
  await page.getByRole("button", { name: "Login" }).click();
  await page.waitForTimeout(2000);
  note(`bad creds: url=${page.url()} text=${(await page.locator("form").innerText()).replace(/\s+/g, " ").slice(0, 300)}`);
  await page.screenshot({ path: "qa/screens/auth-badcreds.png" });

  // 1b. unknown email + empty submit
  await page.getByLabel("Email").fill("nobody@tapswipe.test");
  await page.getByRole("button", { name: "Login" }).click();
  await page.waitForTimeout(1500);
  note(`unknown email: ${(await page.locator("form").innerText()).replace(/\s+/g, " ").slice(0, 200)}`);

  // 2. inactive user: profile inactive, NOT banned (half-deactivated) and banned
  const inactiveId = await ensureUser("qa-inactive@tapswipe.test", { is_active: false });
  page = await fresh();
  await page.goto("/auth/login");
  await page.getByLabel("Email").fill("qa-inactive@tapswipe.test");
  await page.getByLabel("Password").fill(QA_PW);
  await page.getByRole("button", { name: "Login" }).click();
  await page.waitForTimeout(3000);
  note(`inactive(profile only): url=${page.url()} body=${(await page.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 300)}`);
  await page.screenshot({ path: "qa/screens/auth-inactive.png" });
  await service().auth.admin.updateUserById(inactiveId, { ban_duration: "876000h" });
  page = await fresh();
  await page.goto("/auth/login");
  await page.getByLabel("Email").fill("qa-inactive@tapswipe.test");
  await page.getByLabel("Password").fill(QA_PW);
  await page.getByRole("button", { name: "Login" }).click();
  await page.waitForTimeout(3000);
  note(`inactive(banned): url=${page.url()} form=${(await page.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 300)}`);
  await page.screenshot({ path: "qa/screens/auth-banned.png" });

  // 3. no-profile
  await ensureUser("qa-noprofile@tapswipe.test", null);
  page = await fresh();
  await page.goto("/auth/login");
  await page.getByLabel("Email").fill("qa-noprofile@tapswipe.test");
  await page.getByLabel("Password").fill(QA_PW);
  await page.getByRole("button", { name: "Login" }).click();
  await page.waitForTimeout(3000);
  note(`no-profile: url=${page.url()} body=${(await page.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 300)}`);
  await page.screenshot({ path: "qa/screens/auth-noprofile.png" });
  // can they sign out from there?
  note(`no-profile has logout button: ${await page.getByRole("button", { name: /log ?out|sign ?out/i }).count()}`);

  // 4. must change password
  await ensureUser("qa-mustchange@tapswipe.test", { must_change_password: true });
  page = await fresh();
  await page.goto("/auth/login");
  await page.getByLabel("Email").fill("qa-mustchange@tapswipe.test");
  await page.getByLabel("Password").fill(QA_PW);
  await page.getByRole("button", { name: "Login" }).click();
  await page.waitForTimeout(3000);
  note(`mustchange: url=${page.url()}`);
  await page.goto("/leads");
  await page.waitForTimeout(1500);
  note(`mustchange -> /leads: url=${page.url()}`);
  await page.screenshot({ path: "qa/screens/auth-mustchange.png" });

  // 5. garbage / expired session cookie
  const ctx = await browser.newContext({ storageState: storageStateFor("agent") });
  const cookies = await ctx.cookies();
  await ctx.clearCookies();
  await ctx.addCookies(cookies.map((c) => (c.name.includes("auth-token") ? { ...c, value: "base64-eyJnYXJiYWdlIjp0cnVlfQ" } : c)));
  page = await ctx.newPage();
  const errs: string[] = [];
  page.on("pageerror", (e) => errs.push(e.message));
  await page.goto("/leads");
  await page.waitForTimeout(1500);
  note(`garbage cookie: url=${page.url()} errs=${errs.join("|")}`);

  // 6. logged-in user visiting /auth/login
  const ctx2 = await browser.newContext({ storageState: storageStateFor("agent") });
  page = await ctx2.newPage();
  await page.goto("/auth/login");
  await page.waitForTimeout(1000);
  note(`logged-in at /auth/login: url=${page.url()}`);

  // 7. open redirect on /auth/confirm
  const db = service();
  const link = await db.auth.admin.generateLink({ type: "magiclink", email: "qa-mustchange@tapswipe.test" });
  const hashed = link.data?.properties?.hashed_token;
  page = await fresh();
  const resp = await page.request.get(`/auth/confirm?token_hash=${hashed}&type=magiclink&next=https://example.com/phish`, { maxRedirects: 0 });
  note(`confirm next=external: status=${resp.status()} location=${resp.headers()["location"]}`);
  const resp2 = await page.request.get(`/auth/confirm?token_hash=bogus&type=email`, { maxRedirects: 0 });
  note(`confirm bad token: status=${resp2.status()} location=${resp2.headers()["location"]}`);

  // 8. forgot password with unknown email
  page = await fresh();
  await page.goto("/auth/forgot-password");
  await page.getByLabel("Email").fill("nobody@tapswipe.test");
  await page.getByRole("button").first().click();
  await page.waitForTimeout(2500);
  note(`forgot unknown: ${(await page.locator("body").innerText()).replace(/\s+/g, " ").slice(0, 250)}`);

  // 9. login page signup link / dead links
  page = await fresh();
  await page.goto("/auth/login");
  const hrefs = await page.locator("a").evaluateAll((as) => as.map((a) => (a as HTMLAnchorElement).getAttribute("href")));
  note(`login links: ${hrefs.join(", ")}`);

  fs.writeFileSync("qa/screens/auth.txt", log.join("\n"));
  expect(E2E_PASSWORD).toBeTruthy();
});
