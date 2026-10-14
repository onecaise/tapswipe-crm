import { expect, test } from "@playwright/test";

import {
  clearImportedUsers,
  plantShareTeardownCase,
  shareTeardownLeftovers,
  tryDeleteMerchant,
} from "./fixtures/seed";

/**
 * NOT A BROWSER SPEC, and deliberately here anyway. CLAUDE.md keeps e2e/ for
 * what only a browser can find, and this asserts none of that: it proves the
 * shared-account block in clearImportedUsers() -- the e2e suite's own teardown
 * -- against a NON-EMPTY merchant_rep_shares, which nothing else in this suite
 * creates. A fixture helper is only ever exercised where it runs, and this one
 * runs here.
 *
 * The case: a user who owns a merchant carrying a share between two OTHER reps
 * (the e2e agent signs, agent2 is the partner), with the shared pair of ledger
 * lines. merchant_rep_shares.merchant_id and rep_payout_rows.rep_share_id are
 * both ON DELETE RESTRICT, and neither row names the user being torn down.
 *
 * clearImportedUsers never deletes merchants -- an imported rep never owns
 * one -- so the user itself survives the first pass on merchants.agent_id,
 * which has nothing to do with shares. The spec therefore asserts what the
 * share block owns (share and lines gone, merchant now deletable), then removes
 * the merchant and runs the teardown again for the user.
 */

const EMAIL = "e2e-share-teardown@tapswipe.test";

test("clearImportedUsers clears a share between two other reps on the user's own merchant", async () => {
  // Clears anything a previous failed run left behind before planting.
  const ids = await plantShareTeardownCase(EMAIL);

  // The obstacle is real: the merchant cannot be deleted while the share exists.
  expect(await tryDeleteMerchant(ids.merchantId)).toMatch(/merchant_rep_shares_merchant_id_fkey/);
  expect(await shareTeardownLeftovers(ids)).toEqual({ shares: 1, lines: 2, profiles: 1 });

  await clearImportedUsers([EMAIL], []);

  const afterShares = await shareTeardownLeftovers(ids);
  expect(afterShares.shares).toBe(0);
  expect(afterShares.lines).toBe(0);

  // With the share gone, the merchant goes; then the user does.
  expect(await tryDeleteMerchant(ids.merchantId)).toBeNull();
  await clearImportedUsers([EMAIL], []);
  expect(await shareTeardownLeftovers(ids)).toEqual({ shares: 0, lines: 0, profiles: 0 });
});
