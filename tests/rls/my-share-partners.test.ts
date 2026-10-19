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
  seedPayouts,
  type TestDb,
} from "../helpers/db";

/**
 * my_share_partners() (20261019120000; phase 6 of
 * docs/design/residual-splits.md, §8): the ONE way a rep learns who they share
 * an account with.
 *
 * The rule: each party sees the partner's NAME and their OWN share and period.
 * Nothing else: not the partner's share, rate or payout, not the merchant.
 * The function is `security definer` because merchant_rep_shares is admin-only
 * and profiles shows a rep only themselves, so every limit on what it returns
 * is written by hand, and a hand-written limit that is deleted fails open
 * without a sound. Each one is asserted here, and the last describe block
 * rebuilds the function with each guard removed and shows the matching
 * assertion's probe then sees the leak (a revert check that stays in the
 * suite rather than one done once by hand).
 *
 * Personas:
 *   SIGNER   = AGENT_ID        "Agent User", 40 of the 50 on share A
 *   PARTNER  = PARTNER_ID      "Pat Partner", 10 of the 50 on share A
 *   THIRD    = OTHER_AGENT_ID  a party to a DIFFERENT share (B), none of A
 *   B_PARTNER                  the other party to B
 *   LONER                      an active rep on no share at all
 *   ADMIN                      not a party to anything
 *
 * Share A carries a real shared ledger pair with distinctive figures, so
 * "the partner's payout never appears" is checked against a payout that
 * exists rather than against an empty ledger.
 */

const PARTNER_ID = "44444444-4444-4444-4444-444444444444";
const B_PARTNER_ID = "55555555-5555-5555-5555-555555555555";
const LONER_ID = "66666666-6666-6666-6666-666666666666";

const SHARE_MONTH = "2026-08-01";
// round(1234.56 * 50 / 100, 2) = 617.28 for the account; the partner's 10/50
// of that is 123.46 and the signer's 493.82. None of these strings can occur
// by accident in an id, a date or a percentage.
const ACCOUNT_RESIDUAL = "1234.56";
const PARTNER_PAYOUT = "123.46";
const SIGNER_PAYOUT = "493.82";

const MIGRATION = "20261019120000_my_share_partners.sql";

type Entry = Record<string, unknown>;
type DbError = { code?: string; message: string };

let db: TestDb;
let shareA: number;
let shareB: number;
let merchantA: number;

beforeAll(async () => {
  db = await createTestDb();
});

afterAll(async () => {
  await db.close();
});

async function merchantId(mid: string): Promise<number> {
  await asPlatform(db);
  const [row] = await rows<{ id: number }>(
    db,
    `select id from merchants where mid = '${mid}'`,
  );
  return row.id;
}

async function setShare(
  merchant: number,
  primary: string,
  secondary: string,
  a: string,
  b: string,
): Promise<number> {
  await asUser(db, ADMIN_ID);
  const [{ id }] = await rows<{ id: number }>(
    db,
    `select set_merchant_rep_share(${merchant}, '${primary}', '${secondary}',
                                   ${a}, ${b}, '${SHARE_MONTH}') as id`,
  );
  await asPlatform(db);
  return id;
}

beforeEach(async () => {
  await resetData(db);
  await seedPayouts(db);
  await asPlatform(db);
  await db.exec(`
    insert into auth.users (id, email) values
      ('${PARTNER_ID}', 'partner@tapswipe.test'),
      ('${B_PARTNER_ID}', 'bpartner@tapswipe.test'),
      ('${LONER_ID}', 'loner@tapswipe.test');
    insert into profiles (id, full_name, role, is_active) values
      ('${PARTNER_ID}', 'Pat Partner', 'agent', true),
      ('${B_PARTNER_ID}', 'Bea Bpartner', 'agent', true),
      ('${LONER_ID}', 'Lou Loner', 'agent', true);
  `);

  merchantA = await merchantId("MID-AGENT-2");
  shareA = await setShare(merchantA, AGENT_ID, PARTNER_ID, "40", "10");
  shareB = await setShare(
    await merchantId("MID-OTHER-2"),
    OTHER_AGENT_ID,
    B_PARTNER_ID,
    "30",
    "20",
  );

  // Share A's ledger pair for August, as commit_residual_import_v2 and
  // set_shared_residual would leave it: both lines carry the snapshot and the
  // account residual; each carries its own piece. Inserted as the owner (the
  // shared-line guard is an UPDATE trigger), with the pieces computed by
  // shared_part() itself so the CHECK on them holds.
  await db.exec(`
    insert into rep_payout_rows
      (agent_id, period, mid, merchant_name, merchant_id, rep_split_pct,
       rep_share_id, share_role, primary_rep_pct, secondary_rep_pct,
       account_residual_income, residual_income)
    values
      ('${AGENT_ID}', '${SHARE_MONTH}', 'MID-AGENT-2', 'Agent Inactive Co',
        ${merchantA}, 50, ${shareA}, 'primary', 40, 10, ${ACCOUNT_RESIDUAL},
        ${ACCOUNT_RESIDUAL} - shared_part(${ACCOUNT_RESIDUAL}, 10, 50)),
      ('${PARTNER_ID}', '${SHARE_MONTH}', 'MID-AGENT-2', 'Agent Inactive Co',
        ${merchantA}, 50, ${shareA}, 'secondary', 40, 10, ${ACCOUNT_RESIDUAL},
        shared_part(${ACCOUNT_RESIDUAL}, 10, 50));
    delete from audit_log;
  `);
});

/** Calls my_share_partners as `userId`; returns the parsed array. */
async function partnersOf(
  userId: string | null,
  merchant?: number,
): Promise<Entry[]> {
  await asUser(db, userId);
  try {
    const [{ result }] = await rows<{ result: Entry[] }>(
      db,
      `select my_share_partners(${merchant ?? "null"}) as result`,
    );
    return result;
  } finally {
    await asPlatform(db);
  }
}

/** Runs one statement as `userId`; returns the error, or null on success. */
async function attempt(userId: string | null, sql: string): Promise<DbError | null> {
  await asUser(db, userId);
  try {
    await db.query(sql);
    return null;
  } catch (error) {
    return error as DbError;
  } finally {
    await asPlatform(db);
  }
}

describe("what each party sees", () => {
  it("the signer gets the partner's name and their own 40, and nothing else", async () => {
    expect(await partnersOf(AGENT_ID)).toEqual([
      {
        rep_share_id: shareA,
        partner_name: "Pat Partner",
        own_rep_pct: 40,
        effective_from: SHARE_MONTH,
        effective_to: null,
      },
    ]);
  });

  it("the partner gets the signer's name and their own 10, and nothing else", async () => {
    expect(await partnersOf(PARTNER_ID)).toEqual([
      {
        rep_share_id: shareA,
        partner_name: "Agent User",
        own_rep_pct: 10,
        effective_from: SHARE_MONTH,
        effective_to: null,
      },
    ]);
  });

  it("returns exactly five keys: the others are ABSENT, not null", async () => {
    for (const caller of [AGENT_ID, PARTNER_ID]) {
      const [entry] = await partnersOf(caller);
      expect(Object.keys(entry).sort()).toEqual([
        "effective_from",
        "effective_to",
        "own_rep_pct",
        "partner_name",
        "rep_share_id",
      ]);
      for (const forbidden of [
        "partner_rep_pct",
        "partner_id",
        "partner_payout",
        "rep_payout",
        "rep_split_pct",
        "primary_rep_pct",
        "secondary_rep_pct",
        "merchant_id",
        "mid",
        "dba",
      ]) {
        expect(entry).not.toHaveProperty(forbidden);
      }
    }
  });

  it("never carries the partner's payout, rate, id or the merchant's data anywhere in the text", async () => {
    // Belt and braces over the key test: a value smuggled inside an allowed
    // key (a partner_name built as "Pat Partner (10%)") would pass that one.
    const signerText = JSON.stringify(await partnersOf(AGENT_ID));
    const partnerText = JSON.stringify(await partnersOf(PARTNER_ID));

    for (const text of [signerText, partnerText]) {
      expect(text).not.toContain(PARTNER_PAYOUT);
      expect(text).not.toContain(SIGNER_PAYOUT);
      expect(text).not.toContain(ACCOUNT_RESIDUAL);
      expect(text).not.toContain("617.28");
      expect(text).not.toContain("MID-AGENT-2");
      expect(text).not.toContain("Agent Inactive Co");
      expect(text).not.toContain("Nashville");
    }
    expect(signerText).not.toContain(PARTNER_ID);
    expect(partnerText).not.toContain(AGENT_ID);
    // Each side's text carries its own figure and not the other's.
    expect(signerText).toContain('"own_rep_pct":40');
    expect(signerText).not.toMatch(/:10[,}]/);
    expect(partnerText).toContain('"own_rep_pct":10');
    expect(partnerText).not.toMatch(/:40[,}]/);
  });

  it("the payouts asserted absent really exist on the ledger", async () => {
    // Without this the absence checks above could pass against a ledger the
    // fixture failed to fill.
    const pair = await rows<{ share_role: string; rep_payout: string }>(
      db,
      `select share_role, rep_payout::text from rep_payout_rows
        where rep_share_id = ${shareA} order by share_role`,
    );
    expect(pair).toEqual([
      { share_role: "primary", rep_payout: SIGNER_PAYOUT },
      { share_role: "secondary", rep_payout: PARTNER_PAYOUT },
    ]);
  });

  it("lists every share a rep is party to, newest first, and an ended one keeps its end", async () => {
    // The signer is also the partner on a second, ended share elsewhere.
    await asUser(db, ADMIN_ID);
    await db.query(`select end_merchant_rep_share(${shareB}, '2026-11-01')`);
    const shareC = await setShare(
      await merchantId("MID-OTHER-1"),
      LONER_ID,
      AGENT_ID,
      "25",
      "25",
    );
    // MID-OTHER-1 has July committed, so that share starts August as A does;
    // order then falls to id, newest first.
    expect((await partnersOf(AGENT_ID)).map((e) => e.rep_share_id)).toEqual([
      shareC,
      shareA,
    ]);
    expect(await partnersOf(B_PARTNER_ID)).toEqual([
      {
        rep_share_id: shareB,
        partner_name: "Other Agent",
        own_rep_pct: 20,
        effective_from: SHARE_MONTH,
        effective_to: "2026-11-01",
      },
    ]);
  });

  it("filters by merchant without echoing it", async () => {
    expect(await partnersOf(AGENT_ID, merchantA)).toHaveLength(1);
    expect(await partnersOf(AGENT_ID, await merchantId("MID-OTHER-2"))).toEqual([]);
    // A party filtering on their own share's merchant learns what their
    // ledger line already says; a non-party learns nothing either way.
    expect(await partnersOf(OTHER_AGENT_ID, merchantA)).toEqual([]);
  });
});

describe("who gets nothing", () => {
  it("a third rep, party to a different share, sees only that one", async () => {
    const third = await partnersOf(OTHER_AGENT_ID);
    expect(third.map((e) => e.rep_share_id)).toEqual([shareB]);
    expect(JSON.stringify(third)).not.toContain("Pat Partner");
    expect(JSON.stringify(third)).not.toContain(String(shareA) + ",");
  });

  it("an unrelated rep gets an empty list", async () => {
    expect(await partnersOf(LONER_ID)).toEqual([]);
  });

  it("an admin who is not a party gets an empty list, not every share", async () => {
    // Party-only for every caller (decided 19 Oct 2026): admins read the
    // table directly under its own policy.
    expect(await partnersOf(ADMIN_ID)).toEqual([]);
  });

  it("a deactivated party is refused, PT403, though their JWT still works", async () => {
    await db.exec(`update profiles set is_active = false where id = '${PARTNER_ID}'`);
    const error = await attempt(PARTNER_ID, `select my_share_partners()`);
    expect(error?.code).toBe("PT403");
  });

  it("a caller with no identity is refused", async () => {
    const error = await attempt(null, `select my_share_partners()`);
    expect(error?.code).toBe("PT403");
  });
});

describe("no other door is open", () => {
  it("neither party can read merchant_rep_shares directly", async () => {
    for (const caller of [AGENT_ID, PARTNER_ID, OTHER_AGENT_ID]) {
      await asUser(db, caller);
      const visible = await rows<{ n: number }>(
        db,
        `select count(*)::int as n from merchant_rep_shares`,
      );
      expect(visible).toEqual([{ n: 0 }]);
    }
    await asPlatform(db);
  });

  it("nobody but the RPCs can write merchant_rep_shares", async () => {
    for (const sql of [
      `insert into merchant_rep_shares (merchant_id, primary_agent_id, secondary_agent_id,
         primary_rep_pct, secondary_rep_pct, effective_from)
       values (${merchantA}, '${PARTNER_ID}', '${AGENT_ID}', 25, 25, '2027-01-01')`,
      `update merchant_rep_shares set secondary_rep_pct = 40, primary_rep_pct = 10`,
      `delete from merchant_rep_shares`,
    ]) {
      expect((await attempt(PARTNER_ID, sql))?.code).toBe("42501");
    }
  });

  it("the partner gets no access to the merchant record, or the signer's profile", async () => {
    await asUser(db, PARTNER_ID);
    expect(
      await rows(db, `select id from merchants where id = ${merchantA}`),
    ).toEqual([]);
    expect(
      await rows(db, `select id from profiles where id = '${AGENT_ID}'`),
    ).toEqual([]);
    // Their own line is readable, and only theirs.
    const lines = await rows<{ share_role: string }>(
      db,
      `select share_role from rep_payout_rows where rep_share_id = ${shareA}`,
    );
    expect(lines).toEqual([{ share_role: "secondary" }]);
    await asPlatform(db);
  });

  it("no policy on merchants (or anything else) reads shares: no RLS widening", async () => {
    const policies = await rows<{ tablename: string; policyname: string }>(
      db,
      `select tablename, policyname from pg_policies
        where qual ilike '%share%' or with_check ilike '%share%'
           or tablename = 'merchant_rep_shares'`,
    );
    expect(policies).toEqual([
      { tablename: "merchant_rep_shares", policyname: "admin only select" },
    ]);
  });
});

describe("the catalog", () => {
  it("is security definer, stable, with search_path pinned", async () => {
    const [f] = await rows<{
      prosecdef: boolean;
      provolatile: string;
      proconfig: string[];
    }>(
      db,
      `select prosecdef, provolatile, proconfig from pg_proc
        where proname = 'my_share_partners'`,
    );
    expect(f.prosecdef).toBe(true);
    expect(f.provolatile).toBe("s");
    expect(f.proconfig).toEqual(["search_path=public"]);
  });

  it("resolves once, and only authenticated and service_role may execute it", async () => {
    const [{ n }] = await rows<{ n: number }>(
      db,
      `select count(*)::int as n from pg_proc where proname = 'my_share_partners'`,
    );
    expect(n).toBe(1);
    const grantees = await rows<{ role: string; ok: boolean }>(
      db,
      `select r as role,
              has_function_privilege(r, 'public.my_share_partners(int)', 'execute') as ok
         from unnest(array['anon', 'authenticated', 'service_role']) r
        order by r`,
    );
    expect(grantees).toEqual([
      { role: "anon", ok: false },
      { role: "authenticated", ok: true },
      { role: "service_role", ok: true },
    ]);
  });

  it("the guard is the first statement of the body", async () => {
    const [{ src }] = await rows<{ src: string }>(
      db,
      `select prosrc as src from pg_proc where proname = 'my_share_partners'`,
    );
    const body = src.slice(src.indexOf("begin"));
    expect(body).toMatch(
      /^begin\s+if caller is null or not is_active_agent\(\) then\s+raise exception 'not authorised' using errcode = 'PT403';/,
    );
  });
});

/**
 * Revert checks, kept in the suite. Each rebuilds the function from the
 * migration's own text with ONE guard removed, runs the probe the matching
 * assertion above uses, and requires the leak to appear. If one of these goes
 * red, the assertion it pairs with has stopped testing anything. Each replace
 * must match exactly once, so a reworded migration fails here loudly rather
 * than quietly checking an unchanged function.
 */
describe("each guard is load-bearing", () => {
  async function functionSql(): Promise<string> {
    const text = await readMigration(MIGRATION);
    const start = text.indexOf("create or replace function my_share_partners");
    const end = text.indexOf("$$;", start) + 3;
    expect(start).toBeGreaterThan(-1);
    return text.slice(start, end);
  }

  async function withReverted(
    find: string | RegExp,
    replace: string,
    probe: () => Promise<void>,
  ): Promise<void> {
    const original = await functionSql();
    const matches = original.match(
      typeof find === "string"
        ? new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "g")
        : new RegExp(find.source, "g"),
    );
    expect(matches, `revert fragment must occur exactly once`).toHaveLength(1);
    await asPlatform(db);
    await db.exec(original.replace(find, replace));
    try {
      await probe();
    } finally {
      await asPlatform(db);
      await db.exec(original);
    }
  }

  it("without the active-caller guard, a deactivated party is answered", async () => {
    await db.exec(`update profiles set is_active = false where id = '${PARTNER_ID}'`);
    await withReverted(
      /if caller is null or not is_active_agent\(\) then\s+raise exception 'not authorised' using errcode = 'PT403';\s+end if;/,
      "",
      async () => {
        expect(await partnersOf(PARTNER_ID)).toHaveLength(1);
      },
    );
    expect((await attempt(PARTNER_ID, `select my_share_partners()`))?.code).toBe("PT403");
  });

  it("without the party filter, the third rep, the loner and the admin see share A", async () => {
    await withReverted(
      /where \(s\.primary_agent_id = caller or s\.secondary_agent_id = caller\)\s+and /,
      "where ",
      async () => {
        for (const caller of [OTHER_AGENT_ID, LONER_ID, ADMIN_ID]) {
          expect(
            (await partnersOf(caller)).map((e) => e.rep_share_id),
          ).toContain(shareA);
        }
      },
    );
    expect(await partnersOf(LONER_ID)).toEqual([]);
  });

  it("with the own/partner case inverted, each party is shown the other's share", async () => {
    // own_rep_pct is the one figure that differs between the parties, so the
    // case choosing it is the line that decides whether a rep sees their own
    // share or their partner's.
    await withReverted(
      "then s.primary_rep_pct\n                                 else s.secondary_rep_pct end",
      "then s.secondary_rep_pct\n                                 else s.primary_rep_pct end",
      async () => {
        const [signer] = await partnersOf(AGENT_ID);
        expect(signer.own_rep_pct).toBe(10);
      },
    );
  });

  it("with a partner key added, the exact-shape assertion would fail", async () => {
    await withReverted(
      "'partner_name', p.full_name,",
      "'partner_name', p.full_name, 'partner_rep_pct', s.secondary_rep_pct,",
      async () => {
        const [entry] = await partnersOf(AGENT_ID);
        expect(entry).toHaveProperty("partner_rep_pct");
      },
    );
  });

  it("as security invoker it returns nothing to a party, so the definer is not decoration", async () => {
    // Under invoker the caller's own policies apply: merchant_rep_shares is
    // admin-only, so the party's row is filtered away. (Under this suite's
    // auth shim it fails earlier still -- authenticated has no usage on the
    // shim's auth schema -- so either outcome is accepted: what matters is
    // that the party does NOT get their share back.)
    await withReverted("security definer", "security invoker", async () => {
      let answer: Entry[] | null = null;
      try {
        answer = await partnersOf(AGENT_ID);
      } catch {
        answer = null;
      }
      expect(answer === null || answer.length === 0).toBe(true);
    });
  });
});
