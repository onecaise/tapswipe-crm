import fs from "node:fs";
import { test } from "@playwright/test";
import { PERSONAS, STORE_FIXTURE, storageStateFor } from "../../e2e/fixtures/seed";
import { idsFor, service } from "./stack";

const log: string[] = [];
const note = (s: string) => { log.push(s); console.log(s); };

test("cross-rep proposals and documents", async ({ browser }) => {
  test.setTimeout(600_000);
  const db = service();
  const agent2 = await idsFor(PERSONAS.agent2.email, "agent2");
  const agent = await idsFor(PERSONAS.agent.email, "agent");
  const { data: dev } = await db.from("products").select("id").eq("sku", STORE_FIXTURE.device.sku).single();
  await db.from("quotes").delete().eq("title", "QA agent2 proposal");
  const { data: qid, error } = await db.rpc("create_quote_version", {
    lead_id_input: agent2.lead, merchant_id_input: null, customer_name_input: null, agent_id_input: agent2.personaId,
    quote_group_id_input: null, status_input: "draft", title_input: "QA agent2 proposal", notes_input: null,
    line_items_input: [{ product_id: dev!.id, quantity: 1 }],
  });
  if (error) throw error;
  const { data: q } = await db.from("quotes").select("quote_group_id").eq("id", qid).single();
  const g = q!.quote_group_id as string;

  const ctx = await browser.newContext({ storageState: storageStateFor("agent") });
  const page = await ctx.newPage();
  for (const path of [
    `/proposals/${g}`, `/proposals/${g}/print`, `/proposals/${g}/print?quote=${qid}`,
    `/proposals/${agent.proposalGroup}/print?quote=${qid}`,
    `/leads/${agent2.lead}/quotes/${g}/print`, `/merchants/${agent2.merchant}/quotes/${g}/print`,
    `/proposals?rep=${agent2.personaId}`, `/proposals/new?lead=${agent2.lead}`, `/proposals/new?merchant=${agent2.merchant}`,
    `/proposals/new?lead=${agent.lead}`,
    `/documents?q=E2E-DOC-agent2`, `/notes?owner=lead&id=${agent2.lead}`,
  ]) {
    await page.goto(path);
    await page.waitForLoadState("networkidle").catch(() => {});
    const body = (await page.locator("main").innerText().catch(() => page.locator("body").innerText())).replace(/\s+/g, " ");
    note(`agent ${path} -> ${page.url().replace("http://localhost:3000", "")} | leaks agent2? ${/agent2|Agent Two|QA agent2 proposal/i.test(body)} | ${body.slice(0, 220)}`);
    await page.screenshot({ path: `qa/screens/crossrep_${path.replace(/[^a-z0-9]+/gi, "_").slice(0, 60)}.png`, fullPage: true });
  }
  fs.writeFileSync("qa/screens/crossrep.txt", log.join("\n"));
});
