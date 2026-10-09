import fs from "node:fs";
import { test } from "@playwright/test";
import { storageStateFor } from "../../e2e/fixtures/seed";

const paths = (process.env.QA_PATHS ?? "/leads/new,/ghost-sheets/new,/merchants/new,/support-tickets/new,/leads,/ghost-sheets,/support-tickets,/dashboard,/tasks,/notes,/documents,/proposals/new,/marketing,/pre-apps/new").split(",");

test("find hydration mismatches", async ({ browser }) => {
  test.setTimeout(900_000);
  const out: string[] = [];
  for (const who of ["agent", "admin"] as const) {
    for (const vp of [{ width: 390, height: 844 }, { width: 1440, height: 900 }]) {
      const ctx = await browser.newContext({ storageState: storageStateFor(who), viewport: vp });
      const page = await ctx.newPage();
      let current = "";
      page.on("console", (m) => {
        if (m.type() === "error" && /hydrat/i.test(m.text())) out.push(`${who} ${vp.width} ${current}\n${m.text().slice(0, 3000)}\n`);
      });
      for (const p of paths) {
        current = p;
        await page.goto(p);
        await page.waitForLoadState("networkidle").catch(() => {});
        await page.waitForTimeout(500);
      }
      await ctx.close();
    }
  }
  fs.writeFileSync("qa/screens/hydration.txt", out.join("\n----\n") || "none");
});
