// The running local stack refuses self-service sign-up and still accepts a
// password login. Real GoTrue over HTTP, which the hermetic config test
// (tests/unit/local-auth-config.test.ts) cannot reach.
//
// Run with:  npm run test:live
//
// Restored from tests/live/document-urls.test.ts, where these two assertions
// lived until that file was deleted with the legacy documents path.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  PASSWORD,
  PERSONA_EMAILS,
  adminClient,
  anonClient,
  provisionFixtures,
  teardownFixtures,
} from "./helpers/stack";

const WALKUP_EMAIL = "live-walkup@tapswipe.test";

beforeAll(async () => {
  await provisionFixtures();
});

afterAll(async () => {
  // If sign-up were ever open, the walk-up account would survive the run and
  // turn the NEXT run's failure into a confusing "already registered".
  const admin = adminClient();
  const { data } = await admin.auth.admin.listUsers({ perPage: 1000 });
  const walkup = (data?.users ?? []).find((u) => u.email === WALKUP_EMAIL);
  if (walkup) await admin.auth.admin.deleteUser(walkup.id);
  await teardownFixtures();
});

describe("local auth config, over HTTP", () => {
  it("accepts password sign-in for a provisioned user", async () => {
    const { data, error } = await anonClient().auth.signInWithPassword({
      email: PERSONA_EMAILS.owner,
      password: PASSWORD,
    });
    expect(error).toBeNull();
    expect(data.session?.access_token).toBeTruthy();
  });

  it("refuses self-service sign-up", async () => {
    const { data, error } = await anonClient().auth.signUp({
      email: WALKUP_EMAIL,
      password: PASSWORD,
    });
    console.log(
      `  signUp -> ${error?.status ?? 200} ${JSON.stringify({
        error: error?.message ?? null,
        user: data.user?.id ?? null,
      })}`,
    );

    // Accounts come from create-user only. A walk-up account would be an
    // auth.users row with no profiles row: able to log in, able to see nothing.
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/signups not allowed|disabled/i);
    expect(data.user).toBeNull();
  });
});
