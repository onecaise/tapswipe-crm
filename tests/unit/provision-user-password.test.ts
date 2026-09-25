import { describe, expect, it } from "vitest";

import {
  provisionUser,
  type ProvisionInput,
} from "../../supabase/functions/_shared/provision-user";

/**
 * Which password provisionUser actually sets, for each of its two callers.
 *
 * This is a unit test rather than a live one on purpose, and it is the *only*
 * place this claim can be pinned cheaply. The live suite proves a chosen password
 * signs in through GoTrue, which is the fact that matters — but it cannot see the
 * batch caller's half at all, because provision-user-batch deliberately discards
 * the password it was given and returns nothing about it. With no assertion here,
 * "create-user takes the admin's password" could be implemented as "provisionUser
 * always takes the caller's password" and the generated-password path could rot
 * away unnoticed, taking the bulk import's whole no-credential-surfaces property
 * with it.
 *
 * The module is dependency-free and takes its clients as arguments, so both
 * clients are faked here and nothing is started. Same trick tests/unit/
 * residuals-parse.test.ts uses to exercise a Deno module under vitest with no
 * Deno, no Docker, and no running stack.
 */

/** Records what reached auth.admin.createUser, and succeeds. */
function fakeClients() {
  const createUserCalls: { email: string; password: string }[] = [];
  const inserted: Record<string, unknown>[] = [];

  const supabase = {
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
      }),
    }),
  };

  const supabaseAdmin = {
    auth: {
      admin: {
        createUser: async (attributes: { email: string; password: string }) => {
          createUserCalls.push({
            email: attributes.email,
            password: attributes.password,
          });
          return {
            data: {
              user: { id: "11111111-1111-4111-8111-111111111111", email: attributes.email },
            },
            error: null,
          };
        },
        updateUserById: async () => ({ error: null }),
        deleteUser: async () => ({ error: null }),
        listUsers: async () => ({ data: { users: [] }, error: null }),
      },
    },
    from: (table: string) => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
      }),
      insert: async (row: Record<string, unknown>) => {
        inserted.push({ table, ...row });
        return { error: null };
      },
    }),
  };

  return { supabase, supabaseAdmin, createUserCalls, inserted };
}

const BASE: ProvisionInput = {
  fullName: "Avery Agent",
  email: "Avery@Tapswipe.TEST",
  role: "agent",
  agentNumber: null,
};

const ACTOR = "22222222-2222-4222-8222-222222222222";

async function provision(input: ProvisionInput) {
  const clients = fakeClients();
  // The casts are the price of the module's structural client types being
  // narrower than what a fake naturally writes; the fakes do satisfy every call
  // provisionUser makes, which is the whole reason it takes clients as
  // arguments rather than importing one.
  const result = await provisionUser(
    clients.supabase as never,
    clients.supabaseAdmin as never,
    ACTOR,
    input,
  );
  return { ...clients, result };
}

describe("an admin-chosen password", () => {
  it("is the password the account is created with", async () => {
    const chosen = "chosen by the admin";
    const { createUserCalls, result } = await provision({
      ...BASE,
      password: chosen,
    });

    expect(createUserCalls).toHaveLength(1);
    expect(createUserCalls[0].password).toBe(chosen);
    // And the same value is reported back, which is what the success screen
    // shows. A response carrying something other than what was set would be the
    // worst version of this bug: the admin reads out a password that fails.
    expect(result.outcome).toBe("created");
    if (result.outcome !== "created") return;
    expect(result.temporaryPassword).toBe(chosen);
  });

  it("is used exactly as typed, with no trimming or case folding", async () => {
    // Spaces at either end are real characters of a password. Normalising them
    // away — the way the email above deliberately IS normalised — would set the
    // account to something other than what the admin is reading off the screen.
    const chosen = "  Spaced Out  ";
    const { createUserCalls } = await provision({ ...BASE, password: chosen });

    expect(createUserCalls[0].password).toBe(chosen);
  });
});

describe("no password supplied — the bulk import's path", () => {
  it("generates one instead of creating an account with none", async () => {
    const { createUserCalls, result } = await provision(BASE);

    expect(createUserCalls).toHaveLength(1);
    // 20 characters from the unambiguous alphabet in admin-users.ts. Asserted by
    // shape rather than by value because it is random by design; the point is
    // that SOMETHING strong was set, since provision-user-batch never looks at
    // it and an empty or absent password here would be invisible everywhere.
    expect(createUserCalls[0].password).toHaveLength(20);
    expect(createUserCalls[0].password).toMatch(/^[A-Za-z2-9]{20}$/);

    expect(result.outcome).toBe("created");
    if (result.outcome !== "created") return;
    expect(result.temporaryPassword).toBe(createUserCalls[0].password);
  });

  it("generates a different one each time", async () => {
    // A generated password that was constant would satisfy the test above and be
    // catastrophic: every account in a bulk import would share one credential.
    const first = await provision(BASE);
    const second = await provision(BASE);

    expect(first.createUserCalls[0].password).not.toBe(
      second.createUserCalls[0].password,
    );
  });
});

describe("either way", () => {
  it("still forces the rep to choose their own on first sign-in", async () => {
    // The property that makes an admin-chosen password acceptable at all. If
    // must_change_password ever stopped being set, a password the admin knows
    // would become the rep's permanent one.
    for (const input of [BASE, { ...BASE, password: "chosen by the admin" }]) {
      const { inserted } = await provision(input);
      expect(inserted[0]).toMatchObject({
        table: "profiles",
        must_change_password: true,
      });
    }
  });
});
