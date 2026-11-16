/**
 * scripts/add-plumlee-bruce-overrides.sql, hermetic half (PGlite, every migration).
 *
 * The file is run exactly as Owen pastes it into the SQL Editor, with only the
 * do_commit literal flipped by string replacement, the way he would. PGlite
 * runs as a superuser; tests/live/add-plumlee-bruce-overrides.test.ts repeats
 * the core claims as the non-superuser `postgres` role the editor uses, where
 * switching to `authenticated` is the part that could differ.
 *
 * Every refusal is checked two ways: it raised the script's own message (not
 * some incidental error), and overrides and audit_log are exactly what they
 * were. Every message is checked for an email or a uuid.
 */
import { readFile } from "node:fs/promises";

import { beforeEach, describe, expect, it } from "vitest";

import { asPlatform, createTestDb, rows, type TestDb } from "../helpers/db";

const SCRIPT = "scripts/add-plumlee-bruce-overrides.sql";
const COUNTS = "scripts/add-plumlee-bruce-overrides-counts.sql";
const COMMIT_OFF = "do_commit       boolean := false;";
const COMMIT_ON = "do_commit       boolean := true;";

const ADMIN = "b0000000-0000-4000-8000-000000000001";
const OTHER_ADMIN = "b0000000-0000-4000-8000-000000000002";
const PLUMLEE = "b0000000-0000-4000-8000-000000000003";
const BRUCE = "b0000000-0000-4000-8000-000000000004";
const OTHER_REP = "b0000000-0000-4000-8000-000000000005";

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

async function script(commit = false): Promise<string> {
  const sql = (await readFile(SCRIPT, "utf8")).replace(/\r\n/g, "\n");
  // Fail loudly if the switch ever moves, rather than test an unflipped file.
  expect(sql).toContain(COMMIT_OFF);
  return commit ? sql.replace(COMMIT_OFF, COMMIT_ON) : sql;
}

/** Runs the file; the error message, or null when it committed. */
async function run(db: TestDb, commit = false): Promise<string | null> {
  await asPlatform(db);
  const message = await db.exec(await script(commit)).then(
    () => null,
    (e: Error) => e.message,
  );
  if (message) {
    expect(message).not.toMatch(UUID);
    expect(message).not.toContain("@");
  }
  return message;
}

/** merchant_overrides and audit_log, as one comparable string. */
async function state(db: TestDb): Promise<string> {
  await asPlatform(db);
  const [r] = await rows<{ s: string }>(
    db,
    `select (select count(*) || ':' || coalesce(md5(string_agg(md5(o::text), ',' order by o.id)), '')
               from merchant_overrides o)
         || '|' ||
            (select count(*) || ':' || coalesce(md5(string_agg(md5(a::text), ',' order by a.id)), '')
               from audit_log a) as s`,
  );
  return r.s;
}

async function merchant(
  db: TestDb,
  dba: string,
  mid: string | null,
  fields: { owner?: string; rate?: number; status?: string } = {},
): Promise<number> {
  await asPlatform(db);
  const rate = fields.rate ?? 50;
  const [{ id }] = await rows<{ id: number }>(
    db,
    `insert into merchants (agent_id, mid, dba, status, processor, split_agent_pct, split_company_pct, city, state)
     values ('${fields.owner ?? PLUMLEE}', ${mid === null ? "null" : `'${mid}'`}, '${dba}',
             '${fields.status ?? "active"}', 'TSYS', ${rate}, ${100 - rate}, 'Nashville', 'TN')
     returning id`,
  );
  return id;
}

async function plant(db: TestDb, merchantId: number, recipient: string, pct: number, from: string): Promise<number> {
  await asPlatform(db);
  const [{ id }] = await rows<{ id: number }>(
    db,
    `insert into merchant_overrides (merchant_id, recipient_id, override_pct, effective_from)
     values (${merchantId}, '${recipient}', ${pct}, '${from}') returning id`,
  );
  return id;
}

/** A committed residual line for the MID in `period`, as v3 would leave it. */
async function importLine(db: TestDb, mid: string, period: string): Promise<void> {
  await asPlatform(db);
  await db.exec(`insert into rep_payout_rows (agent_id, period, processor, mid, residual_income, rep_split_pct)
                 values ('${PLUMLEE}', '${period}', 'TSYS', '${mid}', 10.00, 50.00)`);
}

let db: TestDb;
const ids: Record<string, number> = {};

beforeEach(async () => {
  db = await createTestDb();
  await asPlatform(db);
  await db.exec(`
    insert into auth.users (id, email) values
      ('${ADMIN}', 'owen@tapswipellc.com'),
      ('${OTHER_ADMIN}', 'second-admin@tapswipe.test'),
      ('${PLUMLEE}', 'plumlee@tapswipe.test'),
      ('${BRUCE}', 'bruce@tapswipe.test'),
      ('${OTHER_REP}', 'other@tapswipe.test');
    insert into profiles (id, full_name, role, is_active, email, agent_number, llc_legal_name) values
      ('${ADMIN}', 'Owen Admin', 'admin', true, 'owen@tapswipellc.com', null, null),
      ('${OTHER_ADMIN}', 'Second Admin', 'admin', true, 'second-admin@tapswipe.test', null, null),
      ('${PLUMLEE}', 'Pat Plumlee', 'agent', true, 'plumlee@tapswipe.test', '101', 'Plumlee LLC'),
      ('${BRUCE}', 'Bruce Rozar', 'agent', true, 'bruce@tapswipe.test', '103', null),
      ('${OTHER_REP}', 'Other Rep', 'agent', true, 'other@tapswipe.test', '104', null);`);

  // Eight Plumlee merchants of all three statuses; two already overridden.
  ids.alpha = await merchant(db, "Alpha Cafe", "PL0001");
  ids.bravo = await merchant(db, "Bravo Diner", "PL0002", { status: "inactive", rate: 30 });
  ids.charlie = await merchant(db, "Charlie Bar", "PL0003", { status: "other", rate: 5 });
  ids.delta = await merchant(db, "Delta Shop", "PL0004");
  ids.echo = await merchant(db, "Echo Store", "PL0005");
  ids.foxtrot = await merchant(db, "Foxtrot Grill", "PL0006");
  ids.golf = await merchant(db, "Golf Pub", "PL0007");
  ids.hotel = await merchant(db, "Hotel Inn", "PL0008");
  ids.zulu = await merchant(db, "Zulu Mart", "OT0001", { owner: OTHER_REP });

  ids.deltaOverride = await plant(db, ids.delta, BRUCE, 5, "2026-01-01");
  ids.echoOverride = await plant(db, ids.echo, OTHER_REP, 10, "2025-11-01");
  // A month committed BEFORE the start does not stand in the way.
  await importLine(db, "PL0001", "2025-12-01");
  await db.exec(`delete from audit_log`);
});

describe("dry run (as shipped)", () => {
  it("reports the counts and the first five names, and changes nothing", async () => {
    const before = await state(db);
    const message = await run(db);
    expect(message).toBe(
      [
        "DRY RUN: rolled back, nothing was changed. Every check passed.",
        "  Plumlee LLC merchants (every status): 8",
        "  already have a live override, skipped: 2 (to agent 103 at 5 from 2026-01: 1, other: 1)",
        "  would create (5% of the full residual to agent 103, from 2026-01): 6",
        "  first five: Alpha Cafe, Bravo Diner, Charlie Bar, Foxtrot Grill, Golf Pub",
        "  Plumlee merchants with agent 103's override from 2026-01 afterwards: 7 of 8",
      ].join("\n"),
    );
    expect(await state(db)).toBe(before);
  });
});

describe("commit", () => {
  it("creates one override per merchant through set_merchant_override, audited as the admin", async () => {
    expect(await run(db, true)).toBeNull();

    const created = await rows<{ merchant_id: number; recipient_id: string; override_pct: string; effective_from: string; effective_to: string | null }>(
      db,
      `select merchant_id, recipient_id, override_pct::text, effective_from::text, effective_to::text
         from merchant_overrides where id not in (${ids.deltaOverride}, ${ids.echoOverride})
        order by merchant_id`,
    );
    expect(created.map((o) => o.merchant_id)).toEqual(
      [ids.alpha, ids.bravo, ids.charlie, ids.foxtrot, ids.golf, ids.hotel].sort((a, b) => a - b),
    );
    for (const o of created) {
      expect([o.recipient_id, o.override_pct, o.effective_from, o.effective_to]).toEqual([
        BRUCE,
        "5.00",
        "2026-01-01",
        null,
      ]);
    }

    // The function's own audit row, actor the admin named by email (not the other admin).
    const audit = await rows<{ action: string; actor_id: string; n: number }>(
      db,
      `select action, actor_id::text, count(*)::int as n from audit_log group by 1, 2`,
    );
    expect(audit).toEqual([{ action: "set_merchant_override", actor_id: ADMIN, n: 6 }]);

    // The two that existed are untouched (nothing ended), the other book has none.
    expect(
      await rows(db, `select id, merchant_id, recipient_id::text, override_pct::text, effective_from::text, effective_to
                        from merchant_overrides where id in (${ids.deltaOverride}, ${ids.echoOverride}) order by id`),
    ).toEqual([
      { id: ids.deltaOverride, merchant_id: ids.delta, recipient_id: BRUCE, override_pct: "5.00", effective_from: "2026-01-01", effective_to: null },
      { id: ids.echoOverride, merchant_id: ids.echo, recipient_id: OTHER_REP, override_pct: "10.00", effective_from: "2025-11-01", effective_to: null },
    ]);
    expect(await rows(db, `select 1 from merchant_overrides where merchant_id = ${ids.zulu}`)).toEqual([]);

    // The trailing SELECT's source, and the identity put back.
    const [{ s, who, claims }] = await rows<{ s: string; who: string; claims: string }>(
      db,
      `select current_setting('tapswipe.plumlee_overrides') as s, current_user::text as who,
              coalesce(current_setting('request.jwt.claims', true), '') as claims`,
    );
    expect(JSON.parse(s)).toEqual({
      plumlee_merchants: 8,
      skipped_already_to_103: 1,
      skipped_other_override: 1,
      created: 6,
      first_five: "Alpha Cafe, Bravo Diner, Charlie Bar, Foxtrot Grill, Golf Pub",
      with_103_override_from_2026_01: 7,
    });
    expect(who).not.toBe("authenticated");
    expect(claims).toBe("");
  });

  it("creates nothing the second time", async () => {
    expect(await run(db, true)).toBeNull();
    const after = await state(db);

    expect(await run(db)).toMatch(/skipped: 8 \(to agent 103 at 5 from 2026-01: 7, other: 1\)\n.*would create .*: 0\n {2}first five: \(none\)\n/);
    expect(await run(db, true)).toBeNull();
    expect(await state(db)).toBe(after);
  });

  it("the counts query reads the result", async () => {
    expect(await run(db, true)).toBeNull();
    const [counts] = await rows(db, await readFile(COUNTS, "utf8"));
    expect(counts).toEqual({
      plumlee_profiles: 1,
      agent_103_profiles: 1,
      plumlee_merchants: 8,
      with_103_override_from_2026_01: 7,
      with_other_live_override: 1,
      without_live_override: 0,
      audit_rows_for_103_overrides: 6,
    });
  });
});

describe("refusals: each raises its own message and changes nothing", () => {
  const cases: [string, string, RegExp][] = [
    ["no Plumlee LLC profile", `update profiles set llc_legal_name = null where id = '${PLUMLEE}'`,
      /expected exactly one profile with llc_legal_name 'Plumlee LLC', found 0/],
    ["two Plumlee LLC profiles", `update profiles set llc_legal_name = 'Plumlee LLC' where id = '${OTHER_REP}'`,
      /expected exactly one profile with llc_legal_name 'Plumlee LLC', found 2/],
    ["no agent 103", `update profiles set agent_number = null where id = '${BRUCE}'`,
      /expected exactly one profile with agent_number 103, found 0/],
    ["agent 103 is the owner",
      `update profiles set agent_number = null where id = '${BRUCE}';
       update profiles set agent_number = '103' where id = '${PLUMLEE}'`,
      /agent 103 is the Plumlee LLC profile itself/],
    ["agent 103 deactivated", `update profiles set is_active = false where id = '${BRUCE}'`,
      /agent 103 is deactivated/],
    ["no admin account by that email", `update auth.users set email = 'someone@else.test' where id = '${ADMIN}'`,
      /expected exactly one account with the admin_email set in this script, found 0/],
    ["the account is not an admin", `update profiles set role = 'agent' where id = '${ADMIN}'`,
      /the admin_email account is not an active admin/],
    ["the admin is deactivated", `update profiles set is_active = false where id = '${ADMIN}'`,
      /the admin_email account is not an active admin/],
  ];

  for (const [name, setup, expected] of cases) {
    it(name, async () => {
      await asPlatform(db);
      await db.exec(setup);
      const before = await state(db);
      for (const commit of [false, true]) {
        const message = await run(db, commit);
        expect(message).toMatch(/^add-plumlee-bruce-overrides: /);
        expect(message).toMatch(expected);
        expect(await state(db)).toBe(before);
      }
    });
  }

  it("a merchant set_merchant_override would refuse aborts the whole run, counted by reason", async () => {
    await importLine(db, "PL0002", "2026-03-01"); // a committed month in the override's range
    await merchant(db, "No Mid Kiosk", null);
    await merchant(db, "Low Rate Stand", "PL0009", { rate: 4 });
    await merchant(db, "Share Deli", "PL0010", { rate: 40 });
    await asPlatform(db);
    await db.exec(`insert into merchant_rep_shares (merchant_id, primary_agent_id, secondary_agent_id,
                                                    primary_rep_pct, secondary_rep_pct, effective_from)
                   select id, '${PLUMLEE}', '${BRUCE}', 30, 10, '2025-06-01' from merchants where mid = 'PL0010';
                   delete from audit_log;`);
    const before = await state(db);

    for (const commit of [false, true]) {
      const message = await run(db, commit);
      expect(message).toMatch(/^add-plumlee-bruce-overrides: ABORTED, nothing was changed\. 4 Plumlee merchant\(s\) would be refused/);
      expect(message).toContain("\n  no MID: 1\n");
      expect(message).toContain("\n  no rate, or a rate below 5: 1\n");
      expect(message).toContain("\n  a residual month 2026-01 or later already committed for the MID: 1\n");
      expect(message).toContain("\n  agent 103 is a party to a share on it: 1\n");
      expect(message).toContain("\n  Plumlee LLC merchants (every status): 11\n");
      expect(await state(db)).toBe(before);
    }
  });
});

describe("the write path", () => {
  it("goes through set_merchant_override and never writes merchant_overrides itself", async () => {
    const sql = (await script()).toLowerCase();
    expect(sql).toContain("set_merchant_override(merchant_ref, recipient.id, pct, start_month)");
    expect(sql).not.toMatch(/insert\s+into\s+merchant_overrides/);
    expect(sql).not.toMatch(/update\s+merchant_overrides/);
    expect(sql).not.toMatch(/insert\s+into\s+audit_log/);
    expect(sql).not.toMatch(/\bexception\s+when\b/);
    // Identity is set transaction-local only (the third argument true).
    for (const m of sql.matchAll(/set_config\('(role|request\.jwt\.[a-z.]+)',[^;]*?,\s*(true|false)\)/g)) {
      expect(m[2]).toBe("true");
    }
  });

  it("without the admin identity the function's own guard refuses (proved on a copy)", async () => {
    const mutant = (await script(true)).replace(
      /perform set_config\('request\.jwt\.claims',\s*json_build_object\('sub', admin\.id[^;]*;/,
      `perform set_config('request.jwt.claims', json_build_object('sub', '${BRUCE}')::text, true);`,
    ).replace("perform set_config('request.jwt.claim.sub', admin.id::text, true);", "")
     .replace(/if auth\.uid\(\) is distinct from admin\.id then[\s\S]*?end if;/, "")
     .replace(/if not is_admin\(\) then[\s\S]*?end if;/, "");
    expect(mutant).not.toContain("auth.uid() is distinct from admin.id");
    expect(mutant).not.toContain("if not is_admin()");
    const before = await state(db);
    await asPlatform(db);
    const message = await db.exec(mutant).then(() => null, (e: Error) => e.message);
    expect(message).toBe("admin only");
    expect(await state(db)).toBe(before);
  });
});
