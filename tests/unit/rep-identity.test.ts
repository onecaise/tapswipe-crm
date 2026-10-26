import { readFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  REP_IDENTITY_MAX_LENGTH,
  isRepIdentityName,
} from "../../supabase/functions/_shared/admin-users";
import {
  normalizeRepIdentityName,
  provisionUser,
  type ProvisionInput,
} from "../../supabase/functions/_shared/provision-user";

/**
 * Rep identity outside the database (phase 2 of the intake memo).
 *
 *   1. The 200-character cap exists in three places that nothing type-checks
 *      together: set_rep_identity() + the profiles CHECKs (SQL), the Edge
 *      Functions' validator, and the browser's input maxLength. Pinned here by
 *      reading the sources, so changing one without the others goes red.
 *   2. provisionUser writes the names ONLY through set_rep_identity(), on the
 *      caller-scoped client, never in the service-role profiles insert.
 */

const ROOT = path.resolve(__dirname, "../..");

async function source(file: string): Promise<string> {
  return readFile(path.join(ROOT, file), "utf8");
}

describe("the 200-character cap is one number in three places", () => {
  it("is 200 in the Edge Functions' validator", () => {
    expect(REP_IDENTITY_MAX_LENGTH).toBe(200);
  });

  it("is the cap in the migration's RPC and both CHECKs", async () => {
    const sql = await source(
      "supabase/migrations/20261026120000_rep_identity.sql",
    );
    expect(sql).toContain("length(new_legal) > 200");
    expect(sql).toContain("length(new_llc) > 200");
    expect(sql).toContain("length(legal_name) <= 200");
    expect(sql).toContain("length(llc_legal_name) <= 200");
  });

  it("is the cap in the browser copy", async () => {
    const lib = await source("lib/admin-users.ts");
    expect(lib).toMatch(/export const REP_IDENTITY_MAX_LENGTH = 200;/);
  });
});

describe("isRepIdentityName and normalizeRepIdentityName", () => {
  it("accepts 1 to 200 characters after trimming", () => {
    expect(isRepIdentityName("A")).toBe(true);
    expect(isRepIdentityName(` ${"L".repeat(200)} `)).toBe(true);
    expect(isRepIdentityName("L".repeat(201))).toBe(false);
  });

  it("refuses blank and non-strings", () => {
    for (const value of ["", "   ", "\t", null, undefined, 42, {}]) {
      expect(isRepIdentityName(value)).toBe(false);
    }
  });

  it("treats blank as not given, and trims what remains", () => {
    expect(normalizeRepIdentityName("  Ann Ito ")).toBe("Ann Ito");
    expect(normalizeRepIdentityName("\tIto LLC\n")).toBe("Ito LLC");
    for (const value of ["", "   ", null, undefined, 7]) {
      expect(normalizeRepIdentityName(value)).toBeNull();
    }
  });
});

/** Fake clients that record every call provisionUser makes. */
function fakeClients(rpcError: { message: string } | null = null) {
  const rpcCalls: { fn: string; args?: Record<string, unknown> }[] = [];
  const inserted: Record<string, unknown>[] = [];

  const supabase = {
    rpc: async (fn: string, args?: Record<string, unknown>) => {
      rpcCalls.push({ fn, args });
      return { error: rpcError };
    },
    from: () => ({
      select: () => ({
        eq: () => ({ maybeSingle: async () => ({ data: null, error: null }) }),
      }),
    }),
  };

  const supabaseAdmin = {
    auth: {
      admin: {
        createUser: async (attributes: { email: string }) => ({
          data: {
            user: {
              id: "11111111-1111-4111-8111-111111111111",
              email: attributes.email,
            },
          },
          error: null,
        }),
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

  return { supabase, supabaseAdmin, rpcCalls, inserted };
}

const BASE: ProvisionInput = {
  fullName: "Ann",
  email: "ann@tapswipe.test",
  role: "agent",
  agentNumber: null,
};

async function provision(
  input: ProvisionInput,
  rpcError: { message: string } | null = null,
) {
  const clients = fakeClients(rpcError);
  const result = await provisionUser(
    clients.supabase as never,
    clients.supabaseAdmin as never,
    "22222222-2222-4222-8222-222222222222",
    input,
  );
  return { ...clients, result };
}

describe("provisionUser writes the names through set_rep_identity only", () => {
  it("calls the RPC on the caller-scoped client after the profile exists", async () => {
    const { rpcCalls, inserted, result } = await provision({
      ...BASE,
      legalName: "Ann Ito",
      llcLegalName: "Ito Payments LLC",
    });

    expect(result.outcome).toBe("created");
    expect(rpcCalls).toEqual([
      {
        fn: "set_rep_identity",
        args: {
          user_id: "11111111-1111-4111-8111-111111111111",
          legal_name: "Ann Ito",
          llc_legal_name: "Ito Payments LLC",
        },
      },
    ]);

    const profile = inserted.find((row) => row.table === "profiles");
    expect(profile).toBeDefined();
    expect(profile).not.toHaveProperty("legal_name");
    expect(profile).not.toHaveProperty("llc_legal_name");
  });

  it("passes one name and null for the other", async () => {
    const { rpcCalls } = await provision({ ...BASE, legalName: "Ann Ito" });
    expect(rpcCalls[0].args).toMatchObject({
      legal_name: "Ann Ito",
      llc_legal_name: null,
    });
  });

  it("makes no call when neither name was given", async () => {
    const { rpcCalls, result } = await provision(BASE);
    expect(rpcCalls).toEqual([]);
    expect(result.outcome).toBe("created");
    if (result.outcome === "created") expect(result.identityWriteError).toBeNull();
  });

  it("reports a refused write without failing the created account", async () => {
    const { result } = await provision(
      { ...BASE, legalName: "Ann Ito", llcLegalName: "Ito LLC" },
      { message: "admin only" },
    );
    expect(result.outcome).toBe("created");
    if (result.outcome !== "created") return;
    expect(result.identityWriteError).toBe("admin only");
  });
});
