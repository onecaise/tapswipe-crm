import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ADMIN_ID,
  AGENT_ID,
  OTHER_AGENT_ID,
  asPlatform,
  asUser,
  createTestDb,
  resetData,
  rows,
  type TestDb,
} from "../helpers/db";

/**
 * Pre-apps: the parent plus its three non-secret children and its three
 * secrets tables.
 *
 * Nothing covered pre-app rows before this file — the policies existed in two
 * migrations with no test exercising a single one of them. The child tables
 * are the interesting half: they reach their access check through
 * `exists (select 1 from pre_apps ...)` on the parent, with is_active_agent()
 * wrapping the exists() rather than sitting inside it, and that shape has more
 * ways to be subtly wrong than a flat `agent_id = auth.uid()`.
 */

type CountRow = { n: number };
type StatusRow = { id: number; status: string };

/**
 * Fixture ids, resolved as the owner in beforeEach.
 *
 * Resolved once, up front, rather than inlined as
 * `(select id from pre_apps where dba_name = '…')` — and that matters more
 * than it looks. A subquery like that, evaluated in a query running AS an
 * agent, is scoped by RLS: the other agent's pre_apps row is invisible, so it
 * yields NULL, and `where pre_app_id = NULL` matches nothing. The assertion
 * then passes because it looked at no rows at all, not because the policy
 * held. Worse, `insert ... values (NULL)` fails on the not-null constraint
 * rather than on RLS, so a test meant to prove "cross-agent insert is
 * refused" would pass while proving nothing about the policy.
 *
 * The load-bearing test at the bottom of this file is what caught that.
 */
let agentDraftId: number;
let otherDraftId: number;

const CHILD_TABLES = [
  "pre_app_owners",
  "pre_app_terminal",
  "pre_app_business_profile",
] as const;

const SECRETS_TABLES = [
  "pre_app_owner_secrets",
  "pre_app_banking_secrets",
  "pre_app_terminal_secrets",
] as const;

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

beforeEach(async () => {
  await resetData(db);

  await asPlatform(db);
  const preApps = await rows<{ id: number; dba_name: string }>(
    db,
    `select id, dba_name from pre_apps order by id`,
  );
  const byName = new Map(preApps.map((p) => [p.dba_name, p.id]));
  agentDraftId = byName.get("Agent Draft App")!;
  otherDraftId = byName.get("Other Draft App")!;
});

afterAll(async () => {
  await db?.close();
});

describe("pre_apps row scoping", () => {
  it("returns only the agent's own pre-apps", async () => {
    await asUser(db, AGENT_ID);

    const result = await rows<StatusRow>(
      db,
      `select id, status from pre_apps order by id`,
    );

    expect(result).toHaveLength(2);
    expect(result.map((r) => r.status)).toEqual(["draft", "submitted"]);
  });

  it("returns every pre-app for an admin", async () => {
    await asUser(db, ADMIN_ID);

    const result = await rows<CountRow>(
      db,
      `select count(*)::int as n from pre_apps`,
    );

    expect(result[0].n).toBe(3);
  });

  it("returns nothing to an unauthenticated caller", async () => {
    await asUser(db, null);

    const result = await rows<CountRow>(
      db,
      `select count(*)::int as n from pre_apps`,
    );

    expect(result[0].n).toBe(0);
  });

  it("returns nothing to a deactivated agent", async () => {
    // Deactivation has to gate own-row access, not just admin status: a
    // deactivated agent keeps a valid token until it expires, so the check
    // has to happen per request rather than at sign-in.
    await asPlatform(db);
    await db.exec(`update profiles set is_active = false where id = '${AGENT_ID}'`);

    await asUser(db, AGENT_ID);
    const result = await rows<CountRow>(
      db,
      `select count(*)::int as n from pre_apps`,
    );

    expect(result[0].n).toBe(0);
  });

  it("refuses an insert that assigns the pre-app to another agent", async () => {
    await asUser(db, AGENT_ID);

    await expect(
      db.exec(`
        insert into pre_apps (agent_id, dba_name, legal_business_name)
        values ('${OTHER_AGENT_ID}', 'Smuggled', 'Smuggled LLC')
      `),
    ).rejects.toThrow(/row-level security/i);
  });

  it("refuses to reassign one of its own pre-apps to another agent", async () => {
    // This is what the `with check` half of the update policy is for. Without
    // it the USING clause would allow the update (the row is currently mine)
    // and the row would leave my book on the way out.
    await asUser(db, AGENT_ID);

    await expect(
      db.exec(
        `update pre_apps set agent_id = '${OTHER_AGENT_ID}' where id = ${agentDraftId}`,
      ),
    ).rejects.toThrow(/row-level security/i);
  });

  it("does not let an agent delete a pre-app", async () => {
    await asUser(db, AGENT_ID);

    await db.exec(`delete from pre_apps where id = ${agentDraftId}`);

    await asPlatform(db);
    const result = await rows<CountRow>(
      db,
      `select count(*)::int as n from pre_apps`,
    );
    // RLS filters rather than raising, so the delete is a silent no-op. This
    // is exactly why the app has to check the affected-row count.
    expect(result[0].n).toBe(3);
  });
});

describe("pre_apps status is a real column constraint", () => {
  it("rejects a null status", async () => {
    // A CHECK constraint passes when it evaluates to NULL, so before `not
    // null` was added `status = null` was accepted and produced a pre-app that
    // could never be submitted or approved, with nothing explaining why.
    await asPlatform(db);

    await expect(
      db.exec(`update pre_apps set status = null where id = ${agentDraftId}`),
    ).rejects.toThrow(/not-null|null value/i);
  });

  it("rejects a status outside the vocabulary", async () => {
    await asPlatform(db);

    await expect(
      db.exec(`update pre_apps set status = 'pending' where id = ${agentDraftId}`),
    ).rejects.toThrow(/check constraint/i);
  });
});

describe("pre_apps commission split", () => {
  it("defaults to an even 50/50 split", async () => {
    await asPlatform(db);
    const result = await rows<{ a: string; c: string }>(
      db,
      `insert into pre_apps (agent_id, dba_name, legal_business_name)
       values ('${AGENT_ID}', 'Default Split', 'Default Split LLC')
       returning split_agent_pct::text as a, split_company_pct::text as c`,
    );

    expect(result[0]).toEqual({ a: "50.00", c: "50.00" });
  });

  it("accepts a 100/0 split, for a sale the CEO is on", async () => {
    await asUser(db, AGENT_ID);

    await db.exec(
      `update pre_apps set split_agent_pct = 100, split_company_pct = 0
       where id = ${agentDraftId}`,
    );

    const result = await rows<{ a: string }>(
      db,
      `select split_agent_pct::text as a from pre_apps where id = ${agentDraftId}`,
    );
    expect(result[0].a).toBe("100.00");
  });

  it("rejects a split that does not total 100", async () => {
    await asUser(db, AGENT_ID);

    await expect(
      db.exec(
        `update pre_apps set split_agent_pct = 60, split_company_pct = 50
         where id = ${agentDraftId}`,
      ),
    ).rejects.toThrow(/pre_apps_split_sums_to_100/);
  });
});

describe("pre-app child tables reach their check through the parent", () => {
  for (const table of CHILD_TABLES) {
    it(`${table}: the owning agent sees their own rows`, async () => {
      await asUser(db, AGENT_ID);

      const result = await rows<CountRow>(
        db,
        `select count(*)::int as n from ${table}`,
      );

      expect(result[0].n).toBeGreaterThan(0);
    });

    it(`${table}: another agent sees none of them`, async () => {
      await asUser(db, OTHER_AGENT_ID);

      const result = await rows<CountRow>(
        db,
        `select count(*)::int as n from ${table} where pre_app_id = ${agentDraftId}`,
      );

      expect(result[0].n).toBe(0);
    });

    it(`${table}: a deactivated owner sees none of them`, async () => {
      await asPlatform(db);
      await db.exec(
        `update profiles set is_active = false where id = '${AGENT_ID}'`,
      );

      await asUser(db, AGENT_ID);
      const result = await rows<CountRow>(
        db,
        `select count(*)::int as n from ${table}`,
      );

      expect(result[0].n).toBe(0);
    });

    it(`${table}: an admin sees rows belonging to every agent`, async () => {
      await asUser(db, ADMIN_ID);

      const result = await rows<CountRow>(
        db,
        `select count(*)::int as n from ${table}`,
      );

      expect(result[0].n).toBeGreaterThan(0);
    });

    it(`${table}: an agent cannot insert against another agent's pre-app`, async () => {
      await asUser(db, AGENT_ID);

      await expect(
        db.exec(`insert into ${table} (pre_app_id) values (${otherDraftId})`),
      ).rejects.toThrow(/row-level security/i);
    });
  }

  it("pre_app_owners: an agent cannot re-parent a row onto another agent's pre-app", async () => {
    // The update policy omits `with check`, so Postgres reuses the USING
    // expression for it. That already blocks this, and the migration now
    // writes the clause out explicitly. Either way, the property is what
    // matters, so it is pinned here rather than assumed.
    await asUser(db, AGENT_ID);

    await expect(
      db.exec(
        `update pre_app_owners set pre_app_id = ${otherDraftId}
         where pre_app_id = ${agentDraftId}`,
      ),
    ).rejects.toThrow(/row-level security/i);
  });
});

describe("pre-app children can be deleted by their owner", () => {
  // These three policies did not exist before this migration. Without them
  // "remove this owner" in the wizard is impossible: delete was granted but no
  // policy permitted a row, so every attempt was a silent no-op.
  it("lets the owning agent delete one of their own owner rows", async () => {
    await asUser(db, AGENT_ID);

    await db.exec(
      `delete from pre_app_owners where owner_name = 'Ben Minor'`,
    );

    const result = await rows<CountRow>(
      db,
      `select count(*)::int as n from pre_app_owners where pre_app_id = ${agentDraftId}`,
    );
    expect(result[0].n).toBe(1);
  });

  it("does not let another agent delete them", async () => {
    await asUser(db, OTHER_AGENT_ID);

    await db.exec(`delete from pre_app_owners where owner_name = 'Ben Minor'`);

    await asPlatform(db);
    const result = await rows<CountRow>(
      db,
      `select count(*)::int as n from pre_app_owners where owner_name = 'Ben Minor'`,
    );
    expect(result[0].n).toBe(1);
  });

  it("does not let a deactivated owner delete them", async () => {
    await asPlatform(db);
    await db.exec(
      `update profiles set is_active = false where id = '${AGENT_ID}'`,
    );

    await asUser(db, AGENT_ID);
    await db.exec(`delete from pre_app_owners where owner_name = 'Ben Minor'`);

    await asPlatform(db);
    const result = await rows<CountRow>(
      db,
      `select count(*)::int as n from pre_app_owners where owner_name = 'Ben Minor'`,
    );
    expect(result[0].n).toBe(1);
  });

  it("cascades the SSN away when its owner row goes", async () => {
    // pre_app_owner_secrets is granted to nobody, so a client cannot clear it
    // first. The cascade runs as the constraint owner and bypasses RLS, which
    // is the only reason this delete can succeed at all.
    await asUser(db, AGENT_ID);
    await db.exec(`delete from pre_app_owners where owner_name = 'Ada Owner'`);

    await asPlatform(db);
    const result = await rows<CountRow>(
      db,
      `select count(*)::int as n from pre_app_owner_secrets`,
    );
    expect(result[0].n).toBe(0);
  });
});

describe("an admin can delete a whole pre-app", () => {
  it("succeeds and takes every child row with it", async () => {
    // Before the cascade this raised a foreign-key violation the moment a
    // pre-app had any child row, and no client could clear the children first
    // because the secrets tables are granted to nobody. The admin DELETE
    // policy existed and was unusable.
    await asUser(db, ADMIN_ID);

    await db.exec(`delete from pre_apps where id = ${agentDraftId}`);

    await asPlatform(db);
    for (const table of CHILD_TABLES) {
      const result = await rows<CountRow>(
        db,
        `select count(*)::int as n from ${table} where pre_app_id = ${agentDraftId}`,
      );
      expect(result[0].n, `${table} should have no rows left`).toBe(0);
    }

    // The SSN hung off pre_app_owners, so it goes via a two-level cascade:
    // pre_apps -> pre_app_owners -> pre_app_owner_secrets.
    for (const table of SECRETS_TABLES) {
      const result = await rows<CountRow>(
        db,
        `select count(*)::int as n from ${table}`,
      );
      expect(result[0].n, `${table} should be empty`).toBe(0);
    }

    // Scoped, not indiscriminate: the other agent's pre-app and its owner row
    // are untouched. Without this the test would still pass if the cascade
    // somehow emptied the table.
    const survivors = await rows<CountRow>(
      db,
      `select count(*)::int as n from pre_app_owners where pre_app_id = ${otherDraftId}`,
    );
    expect(survivors[0].n).toBe(1);
  });

  it("lets a lead be deleted without taking its pre-app with it", async () => {
    // lead_id records provenance, so SET NULL rather than CASCADE: deleting a
    // lead must never destroy a merchant application. Before this, the delete
    // failed outright.
    await asPlatform(db);
    await db.exec(
      `update pre_apps set lead_id = (select id from leads where dba = 'Agent Lead A')
       where dba_name = 'Agent Draft App'`,
    );

    await asUser(db, ADMIN_ID);
    await db.exec(`delete from leads where dba = 'Agent Lead A'`);

    await asPlatform(db);
    const result = await rows<{ lead_id: number | null }>(
      db,
      `select lead_id from pre_apps where dba_name = 'Agent Draft App'`,
    );
    expect(result).toHaveLength(1);
    expect(result[0].lead_id).toBeNull();
  });
});

describe("one row per pre-app on the single-section tables", () => {
  it("rejects a second pre_app_terminal row", async () => {
    // This is what lets autosave upsert. Without the constraint a debounced
    // save could leave two terminal rows and nothing would say which is live.
    await asPlatform(db);

    await expect(
      db.exec(`insert into pre_app_terminal (pre_app_id) values (${agentDraftId})`),
    ).rejects.toThrow(/pre_app_terminal_pre_app_id_key/);
  });

  it("rejects a second pre_app_business_profile row", async () => {
    await asPlatform(db);

    await expect(
      db.exec(
        `insert into pre_app_business_profile (pre_app_id) values (${agentDraftId})`,
      ),
    ).rejects.toThrow(/pre_app_business_profile_pre_app_id_key/);
  });

  it("rejects a second banking secrets row", async () => {
    await asPlatform(db);

    await expect(
      db.exec(
        `insert into pre_app_banking_secrets
           (pre_app_id, aba_routing_encrypted, account_number_encrypted)
         values (${agentDraftId}, decode('99','hex'), decode('99','hex'))`,
      ),
    ).rejects.toThrow(/pre_app_banking_secrets_pre_app_id_key/);
  });

  it("rejects a second SSN for the same owner", async () => {
    await asPlatform(db);

    await expect(
      db.exec(
        `insert into pre_app_owner_secrets (pre_app_owner_id, ssn_encrypted)
         values ((select id from pre_app_owners where owner_name = 'Ada Owner'),
                 decode('99','hex'))`,
      ),
    ).rejects.toThrow(/pre_app_owner_secrets_pre_app_owner_id_key/);
  });

  it("still allows many owners on one pre-app", async () => {
    // The one child table that deliberately has no unique constraint.
    await asUser(db, AGENT_ID);

    await db.exec(
      `insert into pre_app_owners (pre_app_id, owner_name, percent_owned)
       values (${agentDraftId}, 'Cid Third', 0)`,
    );

    const result = await rows<CountRow>(
      db,
      `select count(*)::int as n from pre_app_owners where pre_app_id = ${agentDraftId}`,
    );
    expect(result[0].n).toBe(3);
  });
});

describe("the secrets tables stay unreachable", () => {
  for (const table of SECRETS_TABLES) {
    it(`${table}: has no policies at all`, async () => {
      await asPlatform(db);

      const result = await rows<CountRow>(
        db,
        `select count(*)::int as n
           from pg_policy p join pg_class c on c.oid = p.polrelid
          where c.relname = '${table}'`,
      );

      // Zero, on purpose. Adding a policy here is the mistake CLAUDE.md
      // singles out by name, and nothing else in the suite would catch it.
      expect(result[0].n).toBe(0);
    });

    it(`${table}: is readable by neither anon nor authenticated`, async () => {
      await asPlatform(db);

      const result = await rows<{ anon: boolean; auth: boolean }>(
        db,
        `select has_table_privilege('anon','${table}','select') as anon,
                has_table_privilege('authenticated','${table}','select') as auth`,
      );

      expect(result[0]).toEqual({ anon: false, auth: false });
    });
  }

  it("keeps the agent out even though they own the parent pre-app", async () => {
    await asUser(db, AGENT_ID);

    await expect(
      db.exec(`select count(*) from pre_app_banking_secrets`),
    ).rejects.toThrow(/permission denied/i);
  });

  it("stamps a key_version, so ciphertext can be rotated later", async () => {
    await asPlatform(db);

    const result = await rows<{ key_version: number }>(
      db,
      `select key_version from pre_app_banking_secrets limit 1`,
    );

    expect(result[0].key_version).toBe(1);
  });
});

describe("the child scoping tests are load-bearing", () => {
  it("would catch a child policy that stopped checking the parent's owner", async () => {
    // The same technique documents.test.ts uses: break the policy on purpose
    // and prove the assertion above notices. Without this, a test that passes
    // because it queries nothing looks identical to one that passes because
    // the policy works.
    await asPlatform(db);
    await db.exec(`
      drop policy "select via parent pre_app" on pre_app_owners;
      create policy "select via parent pre_app" on pre_app_owners
        for select using (true);
    `);

    await asUser(db, OTHER_AGENT_ID);
    const result = await rows<CountRow>(
      db,
      `select count(*)::int as n from pre_app_owners where pre_app_id = ${agentDraftId}`,
    );

    // With the policy broken the other agent can now see the agent's owners —
    // which is precisely what the real assertion asserts is impossible.
    expect(result[0].n).toBeGreaterThan(0);
  });
});
