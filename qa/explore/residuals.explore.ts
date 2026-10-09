import fs from "node:fs";
import { test } from "@playwright/test";
import { PERIODS, storageStateFor } from "../../e2e/fixtures/seed";
import { service } from "./stack";

const log: string[] = [];
const note = (s: string) => { log.push(s); console.log(s); };

test("residual import and export edges", async ({ browser }) => {
  test.setTimeout(600_000);
  const before = (await service().from("rep_payout_batches").select("id").order("id", { ascending: false }).limit(1)).data?.[0]?.id ?? 0;
  const admin = await (await browser.newContext({ storageState: storageStateFor("admin") })).newPage();
  const errs: string[] = [];
  admin.on("pageerror", (e) => errs.push(e.message));
  for (const [name, body] of [
    ["qa-not-really.xlsx", "this is plain text, not a spreadsheet"],
    ["qa-empty.xlsx", ""],
  ] as const) {
    await admin.goto("/payouts/import");
    await admin.locator('input[type="file"]').setInputFiles({ name, mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", buffer: Buffer.from(body) });
    await admin.getByRole("button", { name: "Upload" }).click();
    await admin.waitForTimeout(5000);
    note(`${name}: url=${admin.url()} ${(await admin.locator("main:visible").innerText()).replace(/\s+/g, " ").slice(0, 400)}`);
    await admin.screenshot({ path: `qa/screens/resid-${name}.png`, fullPage: true });
  }
  await admin.goto("/payouts/import");
  await admin.getByRole("button", { name: "Upload" }).click();
  await admin.waitForTimeout(500);
  note(`no file: ${(await admin.locator("main:visible").innerText()).replace(/\s+/g, " ").slice(0, 200)}`);

  // Export as agent
  const agent = await (await browser.newContext({ storageState: storageStateFor("agent"), acceptDownloads: true })).newPage();
  await agent.goto(`/payouts/${PERIODS.many}`);
  note(`agent period buttons: ${(await agent.getByRole("button").allInnerTexts()).filter(Boolean).join(" / ")}`);
  const exp = agent.getByRole("button", { name: /export/i }).first();
  if (await exp.count()) {
    const [dl] = await Promise.all([agent.waitForEvent("download", { timeout: 20_000 }).catch(() => null), exp.click()]);
    note(`agent export: ${dl ? dl.suggestedFilename() : "NO DOWNLOAD"} ${(await agent.locator("main:visible").innerText()).replace(/\s+/g, " ").slice(0, 150)}`);
    if (dl) { const p = await dl.path(); note(`size ${fs.statSync(p!).size}`); fs.copyFileSync(p!, "qa/screens/agent-export.xlsx"); }
  }
  note(`errors: ${errs.join(" | ")}`);
  const { data: newBatches } = await service().from("rep_payout_batches").select("id, file_name, status").gt("id", before);
  note(`batches created: ${JSON.stringify(newBatches)}`);
  fs.writeFileSync("qa/screens/residuals.txt", log.join("\n"));
});
