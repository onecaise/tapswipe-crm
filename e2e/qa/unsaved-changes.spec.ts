import { expect, test, type Page } from "@playwright/test";

import { PERSONAS, storageStateFor } from "../fixtures/seed";
import { idsFor, service } from "./qa-stack";

/**
 * C3a (D-07). Refreshing or closing a half-filled form lost what was typed,
 * with no warning. Forms with typed input now ask the browser to confirm
 * leaving while they hold unsaved input — and keep NOTHING in browser storage
 * to do it: no localStorage, sessionStorage or cookie, above all on the
 * pre-app secrets step, which holds SSNs and bank numbers.
 *
 * "Would the page warn" is read by dispatching a cancelable beforeunload and
 * checking whether a listener cancelled it — deterministic, unlike waiting on
 * a native dialog. One spec also drives the real dialog, so the synthetic
 * check cannot be passing on its own.
 */
test.use({ storageState: storageStateFor("agent") });

async function wouldWarn(page: Page): Promise<boolean> {
  return page.evaluate(() => {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event.defaultPrevented;
  });
}

/** Every storage the browser offers this origin, searched for the typed value. */
async function expectNotStored(page: Page, needles: string[]) {
  const dump = await page.evaluate(() => {
    const read = (s: Storage) =>
      Array.from({ length: s.length }, (_, i) => {
        const k = s.key(i)!;
        return `${k}=${s.getItem(k)}`;
      }).join("\n");
    return { local: read(localStorage), session: read(sessionStorage), cookie: document.cookie };
  });
  const cookies = (await page.context().cookies()).map((c) => `${c.name}=${c.value}`).join("\n");
  for (const needle of needles) {
    expect(dump.local, `localStorage holds ${needle}`).not.toContain(needle);
    expect(dump.session, `sessionStorage holds ${needle}`).not.toContain(needle);
    expect(dump.cookie, `document.cookie holds ${needle}`).not.toContain(needle);
    expect(cookies, `a cookie holds ${needle}`).not.toContain(needle);
  }
}

test("C3a the new-lead form warns only once something is typed, and stores nothing", async ({ page }) => {
  await page.goto("/leads/new");
  await expect(page.getByLabel("DBA")).toBeVisible();
  expect(await wouldWarn(page)).toBe(false);

  await page.getByLabel("DBA").fill("QA C3a unsaved lead zq81");
  expect(await wouldWarn(page)).toBe(true);
  await expectNotStored(page, ["zq81"]);
});

test("C3a the browser really shows its leave-page dialog", async ({ page }) => {
  await page.goto("/support-tickets/new");
  await page.getByLabel("Subject *").fill("QA C3a unsaved ticket");
  const dialog = page.waitForEvent("dialog");
  await page.close({ runBeforeUnload: true });
  const shown = await dialog;
  expect(shown.type()).toBe("beforeunload");
  await shown.accept();
});

// /merchants/new is admin-only since 20261021120000 (a rep is redirected),
// so it is checked as the admin; the rest of the file stays the agent's.
for (const [path, label, persona] of [
  ["/merchants/new", "DBA *", "admin"],
  ["/ghost-sheets/new", "DBA", "agent"],
] as const) {
  test.describe(`as the ${persona}`, () => {
    test.use({ storageState: storageStateFor(persona) });

    test(`C3a ${path} warns once typed in`, async ({ page }) => {
      await page.goto(path);
      const field = page.getByLabel(label, { exact: true }).first();
      await expect(field).toBeVisible();
      expect(await wouldWarn(page)).toBe(false);
      await field.fill("QA C3a typed");
      expect(await wouldWarn(page)).toBe(true);
    });
  });
}

test.describe("the pre-app secrets step", () => {
  const OWNER = "QA C3a Owner";
  let ownerId: number | null = null;

  test.beforeAll(async () => {
    const { preApp } = await idsFor(PERSONAS.agent.email, "agent");
    const db = service();
    await db.from("pre_app_owners").delete().eq("pre_app_id", preApp).eq("owner_name", OWNER);
    const { data, error } = await db
      .from("pre_app_owners")
      .insert({ pre_app_id: preApp, owner_name: OWNER })
      .select("id")
      .single();
    if (error) throw new Error(error.message);
    ownerId = data.id as number;
  });

  test.afterAll(async () => {
    if (ownerId !== null) await service().from("pre_app_owners").delete().eq("id", ownerId);
  });

  test("C3a warns while sensitive values are typed but unsaved, and stores none of them", async ({ page }) => {
    const { preApp } = await idsFor(PERSONAS.agent.email, "agent");
    await page.goto(`/pre-apps/${preApp}/edit?step=secrets`);
    const ssn = page.getByRole("textbox", { name: OWNER });
    await expect(ssn).toBeVisible();
    expect(await wouldWarn(page)).toBe(false);

    await ssn.fill("987654321");
    await page.getByRole("textbox", { name: "ABA routing number" }).fill("021000021");
    await page.getByRole("textbox", { name: "Account number" }).fill("55512340099");
    expect(await wouldWarn(page)).toBe(true);
    await expectNotStored(page, ["987654321", "987-65-4321", "021000021", "55512340099"]);

    // Cleared again: nothing unsaved, so no warning.
    await ssn.fill("");
    await page.getByRole("textbox", { name: "ABA routing number" }).fill("");
    await page.getByRole("textbox", { name: "Account number" }).fill("");
    expect(await wouldWarn(page)).toBe(false);
  });
});
