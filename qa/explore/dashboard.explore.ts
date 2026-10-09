import fs from "node:fs";
import { test } from "@playwright/test";
import { PERSONAS, storageStateFor } from "../../e2e/fixtures/seed";
import { service } from "./stack";

const log: string[] = [];
const note = (s: string) => { log.push(s); console.log(s); };

test("dashboard counts vs database, search, notifications", async ({ browser }) => {
  test.setTimeout(600_000);
  const db = service();
  const { data: agent } = await db.from("profiles").select("id").eq("email", PERSONAS.agent.email).single();
  type CountQuery = ReturnType<ReturnType<typeof db.from>["select"]>;
  const count = async (t: string, f: (q: CountQuery) => CountQuery) =>
    (await f(db.from(t).select("*", { count: "exact", head: true }))).count;
  const leadIdsWithPreApp = new Set(((await db.from("pre_apps").select("lead_id").not("lead_id", "is", null)).data ?? []).map((r) => r.lead_id));
  const agentLeads = (await db.from("leads").select("id").eq("agent_id", agent!.id)).data ?? [];
  const allLeads = (await db.from("leads").select("id")).data ?? [];
  const expected = {
    agent: {
      ghost: await count("ghost_sheets", (q) => q.eq("agent_id", agent!.id)),
      unconverted: agentLeads.filter((l) => !leadIdsWithPreApp.has(l.id)).length,
      preapps: await count("pre_apps", (q) => q.eq("agent_id", agent!.id)),
      merchants: await count("merchants", (q) => q.eq("agent_id", agent!.id).eq("status", "active")),
      tickets: await count("support_tickets", (q) => q.eq("agent_id", agent!.id).eq("status", "open")),
    },
    admin: {
      ghost: await count("ghost_sheets", (q) => q),
      unconverted: allLeads.filter((l) => !leadIdsWithPreApp.has(l.id)).length,
      preapps: await count("pre_apps", (q) => q),
      merchants: await count("merchants", (q) => q.eq("status", "active")),
      tickets: await count("support_tickets", (q) => q.eq("status", "open")),
    },
  };
  for (const who of ["agent", "admin"] as const) {
    const page = await (await browser.newContext({ storageState: storageStateFor(who) })).newPage();
    await page.goto("/dashboard");
    await page.waitForLoadState("networkidle");
    const cards = await page.locator('[data-slot="stat-card"]:visible').allInnerTexts();
    note(`${who} cards: ${cards.map((c) => c.replace(/\s+/g, " ")).join(" | ")}`);
    note(`${who} expected: ${JSON.stringify(expected[who])}`);
    const badge = await page.locator("#app-sidebar").getByText(/^\d+$/).allInnerTexts();
    note(`${who} sidebar badges: ${badge}`);

    // global search
    const search = page.getByPlaceholder(/Search leads/);
    for (const q of ["E2E", "O'Brien", "%", "zzzz-nothing", "<script>", "a".repeat(300)]) {
      await search.fill(q);
      await page.waitForTimeout(1200);
      const box = await page.locator("body").innerText();
      const m = box.match(/(No (matches|results)[^\n]*|\d+ result[^\n]*)/i)?.[0];
      note(`${who} search "${q.slice(0, 12)}": ${m ?? "?"} errors=${/error|PGRST|failed/i.test(box) ? "YES" : "no"}`);
    }
    await search.press("Escape");
    // notifications
    await page.getByRole("button", { name: /notification/i }).first().click().catch((e) => note("no bell " + e));
    await page.waitForTimeout(1500);
    note(`${who} bell panel: ${(await page.locator("[role=dialog], [data-radix-popper-content-wrapper]").first().innerText().catch(() => "?")).replace(/\s+/g, " ").slice(0, 400)}`);
    await page.screenshot({ path: `qa/screens/dash-bell-${who}.png` });
  }
  fs.writeFileSync("qa/screens/dashboard.txt", log.join("\n"));
});
