import { expect, test } from "@playwright/test";

import { PERSONAS, storageStateFor } from "../fixtures/seed";
import { idsFor, service } from "./qa-stack";

/**
 * A2. The SSN, ABA routing and account number inputs on the secrets step set
 * no autocomplete hints at all, so a browser could offer to remember a
 * merchant's SSN and later suggest it in an unrelated field, and a phone's
 * keyboard would autocorrect and capitalise digits it does not recognise.
 *
 * The claim: each of those three carries autocomplete=off, spellcheck=false,
 * autocorrect=off, autocapitalize=off and inputmode=numeric — and the RP
 * password keeps autocomplete=new-password (Chrome ignores "off" on a password
 * input; see the comment in secrets-step.tsx).
 *
 * The fixture pre-app has no owners, and with none the SSN input does not
 * render at all — so this spec gives it one, or the SSN half would pass by
 * asserting nothing. Likewise the business tax ID input (20261026140000)
 * renders only once an EIN type is chosen, so the spec sets one and puts the
 * fixture's value back afterwards.
 */
test.use({ storageState: storageStateFor("agent") });

const OWNER_NAME = "QA A2 Owner";
let ownerId: number | null = null;
let einTypeBefore: string | null = null;

test.beforeAll(async () => {
  const { preApp } = await idsFor(PERSONAS.agent.email, "agent");
  const db = service();
  await db.from("pre_app_owners").delete().eq("pre_app_id", preApp).eq("owner_name", OWNER_NAME);
  const { data, error } = await db
    .from("pre_app_owners")
    .insert({ pre_app_id: preApp, owner_name: OWNER_NAME })
    .select("id")
    .single();
  if (error) throw new Error(error.message);
  ownerId = data.id as number;

  const { data: row } = await db.from("pre_apps").select("ein_type").eq("id", preApp).single();
  einTypeBefore = (row?.ein_type as string | null) ?? null;
  const { error: typeError } = await db.from("pre_apps").update({ ein_type: "EIN" }).eq("id", preApp);
  if (typeError) throw new Error(typeError.message);
});

test.afterAll(async () => {
  const { preApp } = await idsFor(PERSONAS.agent.email, "agent");
  const { error: typeError } = await service()
    .from("pre_apps")
    .update({ ein_type: einTypeBefore })
    .eq("id", preApp);
  if (typeError) throw new Error(typeError.message);
  // The two service-role updates are cross-agent writes on the rep's pre-app.
  await service()
    .from("audit_log")
    .delete()
    .eq("table_name", "pre_apps")
    .eq("row_id", String(preApp))
    .like("action", "cross_agent_%");
  if (ownerId !== null) {
    const { error } = await service().from("pre_app_owners").delete().eq("id", ownerId);
    if (error) throw new Error(error.message);
  }
  // The service-role insert/delete are logged as cross-agent writes on the
  // rep's pre-app child; clear them so no other spec reads them.
  await service().from("audit_log").delete().eq("table_name", "pre_app_owners").eq("row_id", String(ownerId));
});

test("A2 SSN, tax ID, routing and account inputs opt out of autofill, spellcheck and autocorrect", async ({ page }) => {
  const { preApp } = await idsFor(PERSONAS.agent.email, "agent");
  await page.goto(`/pre-apps/${preApp}/edit?step=secrets`);

  const fields = [
    page.getByRole("textbox", { name: OWNER_NAME }),
    page.getByRole("textbox", { name: "EIN", exact: true }),
    page.getByRole("textbox", { name: "ABA routing number" }),
    page.getByRole("textbox", { name: "Account number" }),
  ];
  for (const field of fields) {
    await expect(field).toBeVisible();
    await expect(field).toHaveAttribute("autocomplete", "off");
    await expect(field).toHaveAttribute("spellcheck", "false");
    await expect(field).toHaveAttribute("autocorrect", "off");
    await expect(field).toHaveAttribute("autocapitalize", "off");
    await expect(field).toHaveAttribute("inputmode", "numeric");
  }

  await expect(page.getByLabel("RP password")).toHaveAttribute("autocomplete", "new-password");
});
