import fs from "node:fs";
import { test, type Browser, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { PERSONAS, PERIODS, storageStateFor } from "../../e2e/fixtures/seed";
import { idsFor, service, type Ids } from "./stack";

/**
 * Visit every route as admin, agent and logged out, at three viewports.
 * Records final URL, h1, not-found, console errors, page errors, failed
 * requests, horizontal overflow and (1440 only) axe serious/critical
 * violations. Screenshots to qa/screens/<who>/. Observations only.
 *
 *   QA_WHO=agent,admin,anon QA_VP=390,768,1440
 */
const VIEWPORTS = [
  { name: "390", width: 390, height: 844 },
  { name: "768", width: 768, height: 1024 },
  { name: "1440", width: 1440, height: 900 },
];
const ONLY = process.env.QA_WHO?.split(",");
const VP = process.env.QA_VP?.split(",");

async function ensureGhost(personaId: string, persona: string): Promise<number> {
  const db = service();
  const dba = `E2E-QA-GHOST-${persona}`;
  const found = await db.from("ghost_sheets").select("id").eq("agent_id", personaId).eq("dba", dba).maybeSingle();
  if (found.data) return found.data.id as number;
  const { data, error } = await db
    .from("ghost_sheets")
    .insert({ agent_id: personaId, dba, contact_name: "QA Ghost" })
    .select("id")
    .single();
  if (error) throw error;
  return data.id as number;
}

type Extra = Record<string, string | number | null | undefined>;

function routes(own: Ids, other: Ids, extra: Extra) {
  const r = (path: string, tag: string) => ({ path, tag });
  const list = [
    r("/", "root"), r("/dashboard", "page"), r("/leads", "page"), r("/leads/new", "page"),
    r("/ghost-sheets", "page"), r("/ghost-sheets/new", "page"), r("/merchants", "page"), r("/merchants/new", "page"),
    r("/pre-apps", "page"), r("/pre-apps/new", "page"), r("/pre-apps/blank-form", "page"),
    r("/support-tickets", "page"), r("/support-tickets/new", "page"), r("/documents", "page"),
    r("/notes", "page"), r("/tasks", "page"), r("/payouts", "page"), r("/payouts/import", "admin"),
    r(`/payouts/${PERIODS.many}`, "page"), r(`/payouts/${PERIODS.many}/summary/${own.personaId}`, "own"),
    r(`/payouts/${PERIODS.many}/summary/${other.personaId}`, "other"),
    r("/marketing", "page"), r("/marketing/manage", "admin"), r("/proposals", "page"), r("/proposals/new", "page"),
    r("/admin/users", "admin"), r("/admin/users/new", "admin"), r("/admin/users/import", "admin"),
    r("/admin/products", "admin"), r("/admin/products/unbranded", "admin"), r(`/admin/products/${extra.brandId}`, "admin"),
    r("/admin/bug-reports", "admin"),
    r(`/leads/${own.lead}`, "own"), r(`/leads/${own.lead}/edit`, "own"),
    r(`/merchants/${own.merchant}`, "own"), r(`/merchants/${own.merchant}/edit`, "own"), r(`/merchants/${own.merchant}/print`, "own"),
    r(`/pre-apps/${own.preApp}`, "own"), r(`/pre-apps/${own.preApp}/edit`, "own"),
    r(`/support-tickets/${own.ticket}`, "own"), r(`/support-tickets/${own.ticket}/edit`, "own"),
    r(`/ghost-sheets/${own.ghost}`, "own"), r(`/ghost-sheets/${own.ghost}/edit`, "own"),
    r(`/leads/${other.lead}`, "other"), r(`/leads/${other.lead}/edit`, "other"),
    r(`/merchants/${other.merchant}`, "other"), r(`/merchants/${other.merchant}/edit`, "other"), r(`/merchants/${other.merchant}/print`, "other"),
    r(`/pre-apps/${other.preApp}`, "other"), r(`/pre-apps/${other.preApp}/edit`, "other"),
    r(`/support-tickets/${other.ticket}`, "other"), r(`/support-tickets/${other.ticket}/edit`, "other"),
    r(`/ghost-sheets/${other.ghost}`, "other"), r(`/ghost-sheets/${other.ghost}/edit`, "other"),
    r("/leads/999999", "missing"), r("/merchants/abc", "missing"),
    r("/proposals/00000000-0000-0000-0000-000000000000", "missing"), r("/proposals/not-a-uuid", "missing"),
    r("/does-not-exist", "missing"),
    r("/auth/login", "auth"), r("/auth/forgot-password", "auth"), r("/auth/update-password", "auth"),
    r("/auth/error?error=no-profile", "auth"),
  ];
  if (own.proposalGroup) list.push(r(`/proposals/${own.proposalGroup}`, "own"), r(`/proposals/${own.proposalGroup}/print`, "own"));
  if (other.proposalGroup) list.push(r(`/proposals/${other.proposalGroup}`, "other"), r(`/proposals/${other.proposalGroup}/print`, "other"));
  if (extra.importBatch) list.push(r(`/admin/users/import/${extra.importBatch}`, "admin"));
  if (extra.payoutBatch) list.push(r(`/payouts/import/${extra.payoutBatch}`, "admin"));
  return list;
}

async function visit(page: Page, path: string, shotDir: string, vp: string, doAxe: boolean) {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const failed: string[] = [];
  const onConsole = (m: { type(): string; text(): string }) => {
    if (m.type() === "error" || m.type() === "warning") consoleErrors.push(`${m.type()}: ${m.text().slice(0, 300)}`);
  };
  const onPageErr = (e: Error) => pageErrors.push(String(e.message).slice(0, 300));
  const onResp = (r: { status(): number; url(): string }) => {
    if (r.status() >= 400) failed.push(`${r.status()} ${r.url().slice(0, 160)}`);
  };
  const onReqFail = (r: { url(): string; failure(): { errorText: string } | null }) =>
    failed.push(`FAIL ${r.failure()?.errorText} ${r.url().slice(0, 160)}`);
  page.on("console", onConsole);
  page.on("pageerror", onPageErr);
  page.on("response", onResp);
  page.on("requestfailed", onReqFail);
  let status = 0;
  try {
    const resp = await page.goto(path, { waitUntil: "load", timeout: 60_000 });
    status = resp?.status() ?? 0;
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => {});
    await page.waitForTimeout(300);
  } catch (e) {
    pageErrors.push(`NAV ${String(e).slice(0, 200)}`);
  }
  const info = await page
    .evaluate(() => {
      const d = document.documentElement;
      const overflowers: string[] = [];
      if (d.scrollWidth > d.clientWidth + 1) {
        for (const el of Array.from(document.querySelectorAll("body *"))) {
          const r = (el as HTMLElement).getBoundingClientRect();
          if (r.right > d.clientWidth + 1 && r.width > 0 && getComputedStyle(el).position !== "fixed") {
            overflowers.push(`${el.tagName.toLowerCase()}.${String((el as HTMLElement).className).slice(0, 80)} r=${Math.round(r.right)}`);
            if (overflowers.length > 5) break;
          }
        }
      }
      const h1 = document.querySelector("h1")?.textContent?.trim() ?? "";
      const text = document.body.innerText;
      return {
        scrollWidth: d.scrollWidth,
        clientWidth: d.clientWidth,
        overflowers,
        h1,
        notFound: /not found|could not be found|404/i.test(text.slice(0, 3000)),
        errorish:
          /(something went wrong|unexpected error|application error|PGRST|violates|syntax error|\bundefined\b|\bNaN\b|\[object Object\]|Invalid Date)/i.exec(text)?.[0] ?? null,
      };
    })
    .catch(() => null);
  const file = `${shotDir}/${path.replace(/[^a-z0-9]+/gi, "_").slice(0, 80) || "root"}_${vp}.png`;
  await page.screenshot({ path: file, fullPage: true }).catch(() => {});
  let axe: string[] = [];
  if (doAxe) {
    try {
      const res = await new AxeBuilder({ page }).withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"]).analyze();
      axe = res.violations
        .filter((v) => v.impact === "serious" || v.impact === "critical")
        .map((v) => `${v.id}(${v.impact}) x${v.nodes.length}: ${v.nodes.slice(0, 3).map((n) => n.target.join(" ")).join(" | ")}`);
    } catch (e) {
      axe = [`AXE-FAIL ${String(e).slice(0, 100)}`];
    }
  }
  page.off("console", onConsole);
  page.off("pageerror", onPageErr);
  page.off("response", onResp);
  page.off("requestfailed", onReqFail);
  return { path, vp, status, url: page.url().replace("http://localhost:3000", ""), ...info, consoleErrors, pageErrors, failed, axe };
}

async function crawl(browser: Browser, who: string, storage: string | undefined, own: Ids, other: Ids, extra: Extra) {
  const dir = `qa/screens/${who}`;
  fs.mkdirSync(dir, { recursive: true });
  const out: unknown[] = [];
  for (const vp of VIEWPORTS.filter((v) => !VP || VP.includes(v.name))) {
    const ctx = await browser.newContext({ storageState: storage, viewport: { width: vp.width, height: vp.height } });
    const page = await ctx.newPage();
    for (const { path, tag } of routes(own, other, extra)) {
      const res = await visit(page, path, dir, vp.name, vp.name === "1440");
      out.push({ who, tag, ...res });
    }
    await ctx.close();
  }
  fs.writeFileSync(`qa/screens/crawl-${who}.json`, JSON.stringify(out, null, 1));
}

test("crawl every route", async ({ browser }) => {
  test.setTimeout(3_600_000);
  const db = service();
  const admin = await idsFor(PERSONAS.admin.email, "admin");
  const agent = await idsFor(PERSONAS.agent.email, "agent");
  const agent2 = await idsFor(PERSONAS.agent2.email, "agent2");
  admin.ghost = await ensureGhost(admin.personaId, "admin");
  agent.ghost = await ensureGhost(agent.personaId, "agent");
  agent2.ghost = await ensureGhost(agent2.personaId, "agent2");
  const brandId = (await db.from("brands").select("id").limit(1).single()).data?.id;
  const importBatch =
    (await db.from("user_import_batches").select("id").order("id", { ascending: false }).limit(1).maybeSingle()).data?.id ?? null;
  const payoutBatch =
    (await db.from("rep_payout_batches").select("id").order("id", { ascending: false }).limit(1).maybeSingle()).data?.id ?? null;
  const extra = { brandId, importBatch, payoutBatch };
  fs.mkdirSync("qa/screens", { recursive: true });
  fs.writeFileSync("qa/screens/ids.json", JSON.stringify({ admin, agent, agent2, extra }, null, 1));

  const plan: [string, string | undefined, Ids, Ids][] = [
    ["agent", storageStateFor("agent"), agent, agent2],
    ["admin", storageStateFor("admin"), admin, agent],
    ["anon", undefined, agent, agent2],
  ];
  for (const [who, storage, own, other] of plan) {
    if (ONLY && !ONLY.includes(who)) continue;
    await crawl(browser, who, storage, own, other, extra);
  }
});
