import { randomUUID } from "node:crypto";

import { expect, test } from "@playwright/test";

import { storageStateFor } from "../fixtures/seed";
import { service } from "./qa-stack";

/**
 * C3b (D-07). After creating a record, Back returned to the still-filled
 * create form, and a second Create made a second record (caught for leads by
 * the duplicate warning, not prevented). The create forms now router.replace
 * to the new record, so the form is not in history: Back goes to the page the
 * rep came from.
 */
test.use({ storageState: storageStateFor("agent") });

const created: { table: "leads" | "support_tickets"; id: number }[] = [];

test.afterAll(async () => {
  const db = service();
  for (const { table, id } of created) {
    await db.from(table).delete().eq("id", id);
    // The service-role delete is logged as a cross-agent write; drop it.
    await db.from("audit_log").delete().eq("table_name", table).eq("row_id", String(id));
  }
});

test("C3b Back after creating a lead does not return to the filled form", async ({ page }) => {
  await page.goto("/leads");
  await page.getByRole("link", { name: "New lead" }).click();
  await expect(page).toHaveURL(/\/leads\/new$/);

  await page.getByLabel("DBA").fill(`QA C3 ${randomUUID()}`);
  const create = page.getByRole("button", { name: /^Create (lead|anyway)$/ });
  await create.click();
  if (await page.getByRole("button", { name: "Create anyway" }).isVisible().catch(() => false)) {
    await page.getByRole("button", { name: "Create anyway" }).click();
  }
  await expect(page).toHaveURL(/\/leads\/\d+$/);
  created.push({ table: "leads", id: Number(page.url().split("/").pop()) });

  await page.goBack();
  await expect(page).toHaveURL(/\/leads$/);
});

test("C3b Back after opening a ticket does not return to the filled form", async ({ page }) => {
  await page.goto("/support-tickets");
  await page.getByRole("link", { name: "New ticket" }).click();
  await expect(page).toHaveURL(/\/support-tickets\/new$/);

  await page.getByLabel("Subject *").fill(`QA C3 ticket ${randomUUID()}`);
  await page.getByRole("button", { name: "Open ticket" }).click();
  await expect(page).toHaveURL(/\/support-tickets\/\d+$/);
  created.push({ table: "support_tickets", id: Number(page.url().split("/").pop()) });

  await page.goBack();
  await expect(page).toHaveURL(/\/support-tickets$/);
});
