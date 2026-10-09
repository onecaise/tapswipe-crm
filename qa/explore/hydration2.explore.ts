import fs from "node:fs";
import { test } from "@playwright/test";
import { storageStateFor } from "../../e2e/fixtures/seed";

test("reproduce merchants/new hydration mismatch", async ({ browser }) => {
  test.setTimeout(600_000);
  const out: string[] = [];
  const ctx = await browser.newContext({ storageState: storageStateFor("agent"), viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  page.on("console", async (m) => {
    if (m.type() !== "error") return;
    const args = await Promise.all(m.args().map((a) => a.jsonValue().catch(() => "?")));
    out.push(`@${page.url()}\n${args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join("\n").slice(0, 6000)}`);
  });
  const seqs = [
    ["/merchants/new"],
    ["/leads", "/merchants/new"],
    ["/ghost-sheets/4", "/merchants/new"],
    ["/leads/104", "/merchants/new"],
  ];
  for (const seq of seqs) {
    for (const p of seq) {
      await page.goto(p);
      await page.waitForLoadState("networkidle").catch(() => {});
      await page.waitForTimeout(800);
    }
    out.push(`== after ${seq.join(" > ")}`);
  }
  // client-side navigation via sidebar
  await page.goto("/ghost-sheets/4");
  await page.waitForLoadState("networkidle");
  await page.goto("/merchants");
  await page.waitForLoadState("networkidle");
  const newLink = page.getByRole("link", { name: /New merchant/ });
  if (await newLink.count()) { await newLink.click(); await page.waitForTimeout(2000); }
  out.push("== after client nav to /merchants/new");
  fs.writeFileSync("qa/screens/hydration2.txt", out.join("\n----\n"));
});
