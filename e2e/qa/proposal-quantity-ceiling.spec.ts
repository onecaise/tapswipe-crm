import { expect, test } from "@playwright/test";

import { STORE_FIXTURE, storageStateFor } from "../fixtures/seed";
import { service } from "./qa-stack";

/**
 * QA-002. quote_line_items.quantity is an `int`, so anything above
 * 2,147,483,647 is refused by Postgres. The cart accepted such a number, priced
 * it ($1.2 trillion one-time), enabled Save, and then showed the rep the raw
 * Postgres text `value "3000000000" is out of range for type integer`.
 *
 * The claim: the cart refuses it BEFORE Save, in words, and no Postgres text
 * ever reaches the page.
 */
test.use({ storageState: storageStateFor("agent") });

const CUSTOMER = "QA quantity ceiling customer";

test.afterAll(async () => {
  await service().from("quotes").delete().eq("customer_name", CUSTOMER);
});

test("QA-002 a quantity beyond the integer column is refused in words, not by Postgres", async ({ page }) => {
  await page.goto("/proposals/new");
  await page.getByLabel("Not in the CRM — type a name").check();
  await page.getByLabel("Customer name", { exact: true }).fill(CUSTOMER);
  const builder = page.getByTestId("proposal-builder");
  await builder.getByRole("button", { name: `Add ${STORE_FIXTURE.device.name}` }).click();

  await builder
    .getByRole("spinbutton", { name: `Quantity of ${STORE_FIXTURE.device.name}` })
    .fill("3000000000");

  const save = builder.getByRole("button", { name: "Save proposal" });
  await expect(save).toBeDisabled();
  await expect(builder.getByText(/quantity/i).last()).toBeVisible();
  await expect(page.getByText(/out of range for type integer/)).toHaveCount(0);

  // The largest value the column holds is still a legal cart.
  await builder
    .getByRole("spinbutton", { name: `Quantity of ${STORE_FIXTURE.device.name}` })
    .fill("2147483647");
  await expect(save).toBeEnabled();
});
