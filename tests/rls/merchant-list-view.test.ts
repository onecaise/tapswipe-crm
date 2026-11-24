import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ADMIN_ID,
  AGENT_ID,
  OTHER_AGENT_ID,
  asPlatform,
  asUser,
  createTestDb,
  readMigration,
  resetData,
  rows,
  type TestDb,
} from "../helpers/db";
import { MERCHANT_LIST_COLUMNS, MERCHANT_SORT_COLUMN } from "@/lib/merchants";

/**
 * The `merchant_list` view (20261124120000, phase 1a of
 * docs/design/merchants-and-dashboard.md): the merchants list reads one page at
 * a time through it.
 *
 * The one property that matters is that it is `security_invoker`. A Postgres
 * view runs as its OWNER by default, and the owner bypasses RLS — so a view
 * created without the option would give every rep every merchant and every
 * owner's name, while reading exactly like this one. Everything below is
 * asserted as `authenticated` through asUser(); as the owner the policies
 * would not apply and every assertion would pass regardless. The last block
 * recreates the view WITHOUT the option on a throwaway database and shows the
 * rep assertions are the ones that catch it.
 */

const COLUMNS = MERCHANT_LIST_COLUMNS;

type ListRow = {
  id: number;
  agent_id: string;
  dba: string;
  agent_name: string | null;
};

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

beforeEach(async () => {
  await resetData(db);
});

afterAll(async () => {
  await db?.close();
});

const listAll = (database: TestDb) =>
  rows<ListRow>(database, `select ${COLUMNS} from merchant_list order by id`);

describe("merchant_list is security_invoker", () => {
  it("says so in its reloptions", async () => {
    await asPlatform(db);
    const [view] = await rows<{ relkind: string; reloptions: string[] | null }>(
      db,
      `select relkind, reloptions from pg_class
        where oid = 'public.merchant_list'::regclass`,
    );
    expect(view.relkind).toBe("v");
    expect(view.reloptions).toContain("security_invoker=true");
  });

  it("gives a rep their own merchants only, with their own name", async () => {
    await asUser(db, AGENT_ID);
    const result = await listAll(db);

    expect(result.map((r) => r.dba).sort()).toEqual([
      "Agent Active Co",
      "Agent Inactive Co",
    ]);
    expect(result.every((r) => r.agent_id === AGENT_ID)).toBe(true);
    // The join goes through the caller's profiles policy too: their own name,
    // and no row of anyone else's to name.
    expect(result.every((r) => r.agent_name === "Agent User")).toBe(true);
    expect(result.map((r) => r.agent_id)).not.toContain(OTHER_AGENT_ID);
  });

  it("gives an admin every merchant with every owner's name", async () => {
    await asUser(db, ADMIN_ID);
    const result = await listAll(db);

    expect(result).toHaveLength(4);
    expect(
      Object.fromEntries(result.map((r) => [r.dba, r.agent_name])),
    ).toEqual({
      "Agent Active Co": "Agent User",
      "Agent Inactive Co": "Agent User",
      "Other Active Co": "Other Agent",
      "Other Other Co": "Other Agent",
    });
  });

  it("gives a deactivated rep nothing", async () => {
    await asPlatform(db);
    await db.exec(`update profiles set is_active = false where id = '${AGENT_ID}'`);
    await asUser(db, AGENT_ID);
    expect(await listAll(db)).toEqual([]);
  });

  it("keeps a rep's narrowing to another rep empty, not widened", async () => {
    // The page never sends this for a rep (the parser drops ?agent=), but if
    // it did, the filter is ANDed with the policy and can only empty the list.
    await asUser(db, AGENT_ID);
    const result = await rows<ListRow>(
      db,
      `select ${COLUMNS} from merchant_list where agent_id = '${OTHER_AGENT_ID}'`,
    );
    expect(result).toEqual([]);
  });
});

describe("merchant_list privileges", () => {
  async function privileges(role: string): Promise<string[]> {
    await asPlatform(db);
    const result = await rows<{ p: string }>(
      db,
      `select p from unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) p
        where has_table_privilege('${role}', 'public.merchant_list', p)
        order by p`,
    );
    return result.map((r) => r.p);
  }

  it("is SELECT only for authenticated", async () => {
    expect(await privileges("authenticated")).toEqual(["SELECT"]);
  });

  it("gives anon nothing", async () => {
    expect(await privileges("anon")).toEqual([]);
  });

  it("gives service_role nothing (no Edge Function reads it)", async () => {
    expect(await privileges("service_role")).toEqual([]);
  });

  it("is not a write path into merchants, even for an admin", async () => {
    // Two layers refuse, and either message is a refusal: today the join makes
    // the view not auto-updatable ("cannot update view"), which Postgres says
    // before it checks the grant; were the join ever dropped, the missing
    // UPDATE grant above ("permission denied") still would.
    await asUser(db, ADMIN_ID);
    await expect(
      db.exec(`update merchant_list set dba = 'Renamed' where dba = 'Agent Active Co'`),
    ).rejects.toThrow(/cannot update view|permission denied/);
    await asPlatform(db);
    const [row] = await rows<{ n: number }>(
      db,
      `select count(*)::int as n from merchants where dba = 'Agent Active Co'`,
    );
    expect(row.n).toBe(1);
  });
});

describe("merchant_list sort keys", () => {
  it("has every column the page orders by", async () => {
    await asUser(db, ADMIN_ID);
    const keys = [...new Set(Object.values(MERCHANT_SORT_COLUMN))].join(", ");
    // Throws (column does not exist) if the view and lib/merchants.ts drift.
    await rows(db, `select ${keys} from merchant_list limit 1`);
  });

  it("sorts DBA case-insensitively and MIDs as text by mid_key", async () => {
    await asPlatform(db);
    await db.exec(`
      insert into merchants (agent_id, mid, dba, status, split_agent_pct, split_company_pct, city, state)
      values
        ('${AGENT_ID}', ' 000123 ', 'acme lower', 'active', 50, 50, 'Nashville', 'TN'),
        ('${AGENT_ID}', 'AB00123',  'Zeta Upper', 'active', 50, 50, 'Nashville', 'TN'),
        ('${AGENT_ID}', '9123',     'Beta',       'active', 50, 50, 'Nashville', 'TN');
    `);
    await asUser(db, ADMIN_ID);

    const byDba = await rows<{ dba: string }>(
      db,
      `select dba from merchant_list
        where dba in ('acme lower', 'Zeta Upper', 'Beta')
        order by dba_sort, id desc`,
    );
    expect(byDba.map((r) => r.dba)).toEqual(["acme lower", "Beta", "Zeta Upper"]);

    // Lexicographic on mid_key (trimmed, upper-case): leading zeros kept and
    // meaningful, letters allowed — "000123" < "9123" < "AB00123", where a
    // numeric order would put 123 before 9123 and could not place AB00123.
    const byMid = await rows<{ mid_sort: string }>(
      db,
      `select mid_sort from merchant_list
        where dba in ('acme lower', 'Zeta Upper', 'Beta')
        order by mid_sort, id desc`,
    );
    expect(byMid.map((r) => r.mid_sort)).toEqual(["000123", "9123", "AB00123"]);
  });
});

describe("the mutation: the same view without security_invoker", () => {
  it("leaks every merchant to a rep, which the rep test above would catch", async () => {
    const mutant = await createTestDb();
    try {
      await resetData(mutant);
      await asPlatform(mutant);
      // The migration's own view body, with the one option removed.
      const migration = await readMigration("20261124120000_merchant_list_view.sql");
      expect(migration).toMatch(/with \(security_invoker = true\)/);
      const body = migration.slice(
        migration.indexOf("create view merchant_list"),
        migration.indexOf("left join profiles p on p.id = m.agent_id;") +
          "left join profiles p on p.id = m.agent_id;".length,
      );
      await mutant.exec(`
        drop view merchant_list;
        ${body.replace("with (security_invoker = true)", "")}
        grant select on merchant_list to authenticated;
      `);

      await asUser(mutant, AGENT_ID);
      const leaked = await listAll(mutant);
      // Four, including the other rep's two and their name: exactly what
      // "gives a rep their own merchants only" refuses.
      expect(leaked).toHaveLength(4);
      expect(leaked.map((r) => r.agent_name)).toContain("Other Agent");
    } finally {
      await mutant.close();
    }
  });
});
