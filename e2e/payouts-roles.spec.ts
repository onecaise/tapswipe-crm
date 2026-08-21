import { expect, test } from "@playwright/test";

import {
  PERIODS,
  PERSONAS,
  publicStackConfig,
  storageStateFor,
  type PersonaKey,
} from "./fixtures/seed";

/**
 * A rep group's heading is the name and the agent number run together
 * ("E2E Agent9002"), so a loose regex on the name matches "E2E Agent Two" as
 * well and trips strict mode. Anchored on both ends instead.
 */
const repHeading = (persona: PersonaKey): RegExp =>
  new RegExp(`^${PERSONAS[persona].fullName}${PERSONAS[persona].agentNumber}$`);

/**
 * The access token the signed-in browser is actually holding.
 *
 * From the COOKIE, not localStorage. This app uses @supabase/ssr, whose whole
 * purpose is a cookie-backed session so the server can read it too — so there is
 * nothing in localStorage to find (the first version of this helper looked there
 * and got null). The cookie is one `sb-<ref>-auth-token`, whose value is the
 * literal prefix "base64-" followed by base64 of the session JSON.
 *
 * Worth the decoding rather than just signing in over the API for a fresh token:
 * this proves the credential the browser is CURRENTLY carrying cannot do the
 * thing, which is the question someone with devtools open is really asking.
 */
async function accessTokenFrom(
  page: import("@playwright/test").Page,
): Promise<string | null> {
  const cookies = await page.context().cookies();
  const authCookie = cookies.find((c) => c.name.endsWith("-auth-token"));
  if (!authCookie) return null;

  const raw = authCookie.value.startsWith("base64-")
    ? Buffer.from(authCookie.value.slice("base64-".length), "base64").toString(
        "utf8",
      )
    : decodeURIComponent(authCookie.value);

  try {
    return (JSON.parse(raw) as { access_token?: string }).access_token ?? null;
  } catch {
    return null;
  }
}

/**
 * Who sees what, and who can do what, on the period ledger.
 *
 * RLS is asserted properly in tests/rls — as SQL, per policy, which is both
 * faster and more precise than a browser. What these specs add is the layer
 * above it: that the PAGE asks the scoped question, and that the affordances
 * match. A page can hold a perfectly scoped policy and still render an edit
 * control to someone whose write will be filtered to nothing, which is a
 * different bug from a policy bug and invisible to a SQL test.
 *
 * The direct-API spec is here rather than in tests/live for one reason: it
 * borrows the browser's real session cookie, so it asks "can the logged-in agent
 * bypass the UI" rather than "can a hand-made JWT". That is the question someone
 * with devtools open actually asks.
 */

test.describe("as an agent", () => {
  test.use({ storageState: storageStateFor("agent") });

  test("sees only their own lines, never another rep's", async ({ page }) => {
    await page.goto(`/payouts/${PERIODS.many}`);

    // Their own seven.
    await expect(page.getByRole("cell", { name: "E2E-A1000" })).toBeVisible();
    await expect(page.getByText("7 merchants")).toBeVisible();

    // The other rep's four and the admin's one, absent. Asserted by MID rather
    // than by a count so a failure names what leaked.
    for (const foreign of ["E2E-B2000", "E2E-B2001", "E2E-C3000"]) {
      await expect(page.getByRole("cell", { name: foreign })).toHaveCount(0);
    }

    // And no group heading for anyone else. The page groups by rep, so a
    // leak would show up as a second section rather than as stray rows.
    await expect(
      page.getByRole("heading", { name: repHeading("agent2") }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: repHeading("agent") }),
    ).toBeVisible();
  });

  test("is offered no admin affordance anywhere on the page", async ({ page }) => {
    await page.goto(`/payouts/${PERIODS.many}`);

    // Delete the period, and set a rep's split in bulk: both admin-only.
    await expect(
      page.getByRole("button", { name: /delete period/i }),
    ).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Apply" })).toHaveCount(0);

    // The two hand-entered figures render as text, not inputs. This is the
    // affordance half of the check — the write is refused either way (below),
    // but offering a control that cannot work is its own defect.
    await expect(page.getByRole("textbox")).toHaveCount(0);

    // Export is deliberately NOT admin-only: it is RLS-scoped, so a rep
    // exporting gets their own book. Asserted so a future tightening that
    // hides it has to be a decision rather than a side effect.
    await expect(
      page.getByRole("button", { name: /export xlsx/i }),
    ).toBeVisible();
  });

  test("cannot edit a payout row by calling the API directly", async ({
    page,
    request,
  }) => {
    await page.goto(`/payouts/${PERIODS.many}`);

    const { apiUrl, publishableKey } = publicStackConfig();
    const token = await accessTokenFrom(page);
    expect(token, "the signed-in page should hold an access token").toBeTruthy();

    const response = await request.patch(
      `${apiUrl}/rest/v1/rep_payout_rows?mid=eq.E2E-A1000`,
      {
        headers: {
          apikey: publishableKey,
          Authorization: `Bearer ${token as string}`,
          "Content-Type": "application/json",
          Prefer: "count=exact",
        },
        data: { rep_split_pct: 99 },
      },
    );

    // RLS FILTERS rather than erroring: the update policy on rep_payout_rows is
    // admin-only, so the statement succeeds against zero rows. The affected
    // count is the assertion, NOT the status code — a 204 here would look like
    // success to anyone reading only the status, which is exactly why
    // PayoutFigureCell passes count: "exact" and treats 0 as a failure.
    expect(response.status()).toBe(204);
    expect(response.headers()["content-range"]).toBe("*/0");

    // And the figure is untouched on reload.
    await page.reload();
    const row = page.getByRole("row", { name: /E2E-A1000/ });
    await expect(row).toContainText("55%");
  });

  test("cannot commit an import by calling the RPC directly", async ({
    page,
    request,
  }) => {
    await page.goto(`/payouts/${PERIODS.many}`);

    const { apiUrl, publishableKey } = publicStackConfig();
    const token = await accessTokenFrom(page);
    expect(token, "the signed-in page should hold an access token").toBeTruthy();

    const response = await request.post(
      `${apiUrl}/rest/v1/rpc/commit_residual_import`,
      {
        headers: {
          apikey: publishableKey,
          Authorization: `Bearer ${token as string}`,
          "Content-Type": "application/json",
        },
        data: { batch_id_input: 1 },
      },
    );

    // Refused outright, not filtered — the RPC carries its own is_admin() check
    // because `security definer` means RLS is not doing the work.
    expect(response.status()).toBe(403);
    expect(await response.json()).toMatchObject({
      code: "PT403",
      message: "admin only",
    });
  });

  test("cannot reach another rep's payout summary", async ({ page }) => {
    await page.goto(`/payouts/${PERIODS.many}`);
    const ownSummary = page.getByRole("link", { name: "Payout summary" });
    await expect(ownSummary).toBeVisible();

    const href = await ownSummary.getAttribute("href");
    expect(href).toBeTruthy();

    // Swap the agent id in the URL for a well-formed one that is not theirs.
    const foreign = (href as string).replace(
      /[0-9a-f-]{36}$/i,
      "00000000-0000-0000-0000-000000000001",
    );
    await page.goto(foreign);

    // Not-yours and does-not-exist are the same answer, so the URL is no oracle.
    await expect(
      page.getByRole("heading", { name: /couldn.t find that/i }),
    ).toBeVisible();
  });
});

test.describe("as an admin", () => {
  test.use({ storageState: storageStateFor("admin") });

  test("sees every rep's lines, grouped and totalled", async ({ page }) => {
    await page.goto(`/payouts/${PERIODS.many}`);

    // 7 + 4 + 1 across three reps.
    await expect(page.getByText("12", { exact: true })).toBeVisible();

    for (const persona of ["admin", "agent", "agent2"] as PersonaKey[]) {
      await expect(
        page.getByRole("heading", { name: repHeading(persona) }),
      ).toBeVisible();
    }
    for (const mid of ["E2E-A1000", "E2E-B2000", "E2E-C3000"]) {
      await expect(page.getByRole("cell", { name: mid })).toBeVisible();
    }
  });

  test("groups are ordered by rep name, not by the file's order", async ({
    page,
  }) => {
    await page.goto(`/payouts/${PERIODS.many}`);

    const headings = await page
      .getByRole("heading", { level: 2 })
      .allInnerTexts();
    const names = headings.map((h) => h.replace(/\s*\d+\s*$/, "").trim());

    // Alphabetical, so an admin reading a long period gets a stable order
    // rather than whatever the processor's spreadsheet happened to be sorted by.
    expect(names).toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });

  test("is offered the admin affordances", async ({ page }) => {
    await page.goto(`/payouts/${PERIODS.many}`);

    await expect(
      page.getByRole("button", { name: /delete period/i }),
    ).toBeVisible();
    // One bulk-split control per rep group.
    await expect(page.getByRole("button", { name: "Apply" })).toHaveCount(3);
    // Two editable figures per row across 12 rows, plus one bulk-split box per
    // rep group.
    await expect(page.getByRole("textbox")).toHaveCount(12 * 2 + 3);
  });
});
