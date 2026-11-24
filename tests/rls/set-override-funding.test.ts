/**
 * scripts/set-override-funding.sql and its counts file, hermetic half (PGlite,
 * every migration).
 *
 * The file is run exactly as Owen pastes it into the SQL Editor, with only the
 * do_commit literal flipped by string replacement, the way he would.
 * tests/live/set-override-funding.test.ts repeats the core claims as the
 * non-superuser `postgres` role the editor uses.
 *
 * The fixture is the owner's decision in miniature at full size: 88 Plumlee
 * LLC merchants with Bruce's (103) 5%, three of Bruce's merchants with
 * Sherwin's (105) 5%, and Lamar County Justice Court (Bruce's) with Plumlee's
 * (108) 25%: 92 overrides, all owner-funded, as the migration leaves them.
 * Two months are committed through the real v3. The script must change the 91
 * and leave Lamar, or change nothing and say why.
 *
 * Every refusal is checked two ways: the script's own message (not an
 * incidental error), and overrides and audit_log exactly as they were. Every
 * message is checked for an email or a uuid.
 */
import { readFile } from "node:fs/promises";

import { beforeEach, describe, expect, it } from "vitest";

import { asPlatform, asUser, createTestDb, freeBatchMonth, insertBatch, rows, stageForCommit, type TestDb } from "../helpers/db";

const SCRIPT = "scripts/set-override-funding.sql";
const COUNTS = "scripts/set-override-funding-counts.sql";
const COMMIT_OFF = "do_commit       boolean := false;";
const COMMIT_ON = "do_commit       boolean := true;";

const ADMIN = "d0000000-0000-4000-8000-000000000001";
const BRUCE = "d0000000-0000-4000-8000-000000000003";
const SHERWIN = "d0000000-0000-4000-8000-000000000005";
const PLUMLEE = "d0000000-0000-4000-8000-000000000008";
const OTHER_REP = "d0000000-0000-4000-8000-000000000009";
const LAMAR_MID = "30119964826";

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

async function script(commit = false): Promise<string> {
  const sql = (await readFile(SCRIPT, "utf8")).replace(/\r\n/g, "\n");
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

/** merchant_overrides, audit_log and the ledger, as one comparable string. */
async function state(db: TestDb): Promise<string> {
  await asPlatform(db);
  const [r] = await rows<{ s: string }>(
    db,
    `select (select count(*) || ':' || coalesce(md5(string_agg(md5(o::text), ',' order by o.id)), '') from merchant_overrides o)
         || '|' || (select count(*) || ':' || coalesce(md5(string_agg(md5(a::text), ',' order by a.id)), '') from audit_log a)
         || '|' || (select count(*) || ':' || coalesce(md5(string_agg(md5(l::text), ',' order by l.id)), '') from rep_payout_rows l)
       as s`,
  );
  return r.s;
}

const tally = (db: TestDb) =>
  rows<{ agent_number: string; funded_by: string; n: number }>(
    db,
    `select p.agent_number, o.funded_by, count(*)::int as n
       from merchant_overrides o join profiles p on p.id = o.recipient_id
      group by 1, 2 order by 1, 2`,
  );

let db: TestDb;
let months: string[];

beforeEach(async () => {
  db = await createTestDb();
  await asPlatform(db);
  await db.exec(`
    insert into auth.users (id, email) values
      ('${ADMIN}', 'owen@tapswipellc.com'),
      ('${BRUCE}', 'bruce@tapswipe.test'),
      ('${SHERWIN}', 'sherwin@tapswipe.test'),
      ('${PLUMLEE}', 'plumlee@tapswipe.test'),
      ('${OTHER_REP}', 'other@tapswipe.test');
    insert into profiles (id, full_name, role, is_active, email, agent_number, llc_legal_name) values
      ('${ADMIN}', 'Owen Admin', 'admin', true, 'owen@tapswipellc.com', null, null),
      ('${BRUCE}', 'Bruce Rozar', 'agent', true, 'bruce@tapswipe.test', '103', null),
      ('${SHERWIN}', 'Sherwin Anderson', 'agent', true, 'sherwin@tapswipe.test', '105', 'Dubble Bubbles Distributing Company LLC'),
      ('${PLUMLEE}', 'John Rhys Plumlee', 'agent', true, 'plumlee@tapswipe.test', '108', 'Plumlee LLC'),
      ('${OTHER_REP}', 'Other Rep', 'agent', true, 'other@tapswipe.test', '120', null);
    -- 88 Plumlee merchants, Bruce's 5% on each.
    insert into merchants (agent_id, mid, dba, status, processor, split_agent_pct, split_company_pct, city, state)
    select '${PLUMLEE}', 'PL' || lpad(g::text, 4, '0'), 'Smokes #' || g, 'active', 'TSYS', 50, 50, 'Hattiesburg', 'MS'
      from generate_series(1, 88) g;
    insert into merchant_overrides (merchant_id, recipient_id, override_pct, effective_from, funded_by)
    select id, '${BRUCE}', 5, '2026-01-01', 'owner' from merchants where agent_id = '${PLUMLEE}';
    -- Three of Bruce's merchants with Sherwin's 5%, and Lamar with Plumlee's 25%.
    insert into merchants (agent_id, mid, dba, status, processor, split_agent_pct, split_company_pct, city, state) values
      ('${BRUCE}', '30119944356', 'Brian Giant Sub''s', 'active', 'TSYS', 50, 50, 'Macon', 'GA'),
      ('${BRUCE}', '201100279984', 'Heart of GA Primary', 'active', 'TSYS', 50, 50, 'Macon', 'GA'),
      ('${BRUCE}', '201100279968', 'Heart of GA Primary', 'active', 'TSYS', 50, 50, 'Macon', 'GA'),
      ('${BRUCE}', '${LAMAR_MID}', 'Lamar County Justice Court', 'active', 'TSYS', 50, 50, 'Barnesville', 'GA');
    insert into merchant_overrides (merchant_id, recipient_id, override_pct, effective_from, funded_by)
    select id, '${SHERWIN}', 5, '2026-01-01', 'owner' from merchants where agent_id = '${BRUCE}' and mid <> '${LAMAR_MID}';
    insert into merchant_overrides (merchant_id, recipient_id, override_pct, effective_from, funded_by)
    select id, '${PLUMLEE}', 25, '2026-01-01', 'owner' from merchants where mid = '${LAMAR_MID}';`);

  // Two committed months (inside the import window), each carrying lines of
  // all three kinds of override.
  months = [];
  for (let i = 0; i < 2; i += 1) {
    const [{ m }] = await rows<{ m: string }>(db, `select ${freeBatchMonth("TSYS")}::text as m`);
    const batch = await insertBatch(db, { extra: { processor: "'TSYS'", period: `'${m}'`, imported_by: `'${ADMIN}'` } });
    await stageForCommit(db, batch, [
      { mid: "PL0001", residual: "100.00" },
      { mid: "PL0002", residual: "39.00" },
      { mid: "30119944356", residual: "274.10" },
      { mid: LAMAR_MID, residual: "324.42" },
    ]);
    await asUser(db, ADMIN);
    await db.query(`select commit_residual_import_v3(${batch}, '{}'::text[])`);
    await asPlatform(db);
    months.push(m);
  }
  months.sort();
  await db.exec(`delete from audit_log`);
}, 60_000);

describe("dry run (as shipped)", () => {
  it("passes every check, reports the tally and the months to replace, and changes nothing", async () => {
    const before = await state(db);
    const message = await run(db);
    expect(message).toMatch(/^DRY RUN: rolled back, nothing was changed\. Every check passed\./);
    expect(message).toContain("overrides by recipient (agent 103 / 105 / 108 / total): 88 / 3 / 1 / 92");
    expect(message).toContain("would change to company-funded: 91");
    expect(message).toContain("left owner-funded: Lamar County Justice Court (agent 108, 25%)");
    expect(message).toContain("final tally: 91 company, 1 owner, 92 in total");
    expect(message).toContain("by recipient: 103 company 88, 105 company 3, 108 owner 1");
    // Lamar's lines are not stale: only the 91's are. 3 overrides per month here.
    expect(message).toContain(`committed months to REPLACE (override count): TSYS ${months[0].slice(0, 7)} (3), TSYS ${months[1].slice(0, 7)} (3)`);
    expect(await state(db)).toBe(before);
  });
});

describe("commit", () => {
  it("changes the 91 through the audited function as the admin, leaves Lamar, and returns the final tally", async () => {
    const ledger = await rows(db, `select md5(string_agg(md5(l::text), ',' order by l.id)) as s from rep_payout_rows l`);
    await asPlatform(db);
    const results = await db.exec(await script(true));
    const grid = results.at(-1)!.rows;
    expect(grid).toEqual([{
      changed: 91, company: 91, owner: 1, total: 92,
      replace: `TSYS ${months[0].slice(0, 7)} (3), TSYS ${months[1].slice(0, 7)} (3)`,
    }]);
    expect(await tally(db)).toEqual([
      { agent_number: "103", funded_by: "company", n: 88 },
      { agent_number: "105", funded_by: "company", n: 3 },
      { agent_number: "108", funded_by: "owner", n: 1 },
    ]);
    expect(await rows(db, `select count(*)::int as n, count(distinct row_id)::int as d,
                                   bool_and(actor_id = '${ADMIN}') as admin,
                                   bool_and(detail like 'owner -> company; replace: %; reason: Owner decision 16 Nov 2026:%') as detail
                              from audit_log where action = 'set_override_funding'`))
      .toEqual([{ n: 91, d: 91, admin: true, detail: true }]);
    expect(await rows(db, `select count(*)::int as n from audit_log`)).toEqual([{ n: 91 }]);
    // The ledger is a snapshot: committed months change only by replace.
    expect(await rows(db, `select md5(string_agg(md5(l::text), ',' order by l.id)) as s from rep_payout_rows l`)).toEqual(ledger);
    // And the editor's identity is back.
    expect(await rows(db, `select current_user as u, coalesce(current_setting('request.jwt.claims', true), '') as c`))
      .toEqual([{ u: "postgres", c: "" }]);
  });

  it("a second run is nothing to do, in either mode, and changes nothing", async () => {
    await asPlatform(db);
    await db.exec(await script(true));
    const after = await state(db);
    expect(await run(db)).toMatch(/^DRY RUN: rolled back, nothing was changed\.\n.*\n  nothing to do: the 91 are company-funded already and Lamar County Justice Court is owner-funded\.$/);
    await asPlatform(db);
    const results = await db.exec(await script(true));
    expect(results.at(-1)!.rows).toEqual([{ changed: 0, company: 91, owner: 1, total: 92, replace: null }]);
    expect(await state(db)).toBe(after);
  });

  it("the counts file reads the before and the after", async () => {
    const counts = async () => {
      const sql = (await readFile(COUNTS, "utf8")).replace(/\r\n/g, "\n")
        .replace("date '2026-08-01'", `date '${months[0]}'`).replace("date '2026-09-01'", `date '${months[1]}'`);
      await asPlatform(db);
      return rows<{ section: string; item: string; n: string; amount: string | null }>(db, sql);
    };
    const pick = (grid: Awaited<ReturnType<typeof counts>>, section: string) =>
      grid.filter((r) => r.section === section).map((r) => [r.item, Number(r.n), r.amount === null ? null : Number(r.amount)]);
    const m0 = months[0].slice(0, 7);
    const m1 = months[1].slice(0, 7);

    const before = await counts();
    expect(pick(before, "1 overrides")).toEqual([["103 owner", 88, null], ["105 owner", 3, null], ["108 owner", 1, null], ["total", 92, null]]);
    expect(pick(before, "2 plumlee")).toEqual([["103 on Plumlee LLC merchants", 88, null], ["108 on Lamar County Justice Court", 1, null]]);
    expect(pick(before, "4 touched")).toEqual([[`TSYS ${m0}`, 3, null], [`TSYS ${m1}`, 3, null]]);
    expect(pick(before, "5 pending")).toEqual([]);
    expect(pick(before, "6 adjustments")).toEqual([]);
    expect(pick(before, "7 drift")).toEqual([]);
    // Bruce funds Sherwin's 5% and Plumlee's 25%; Plumlee funds Bruce's 5%.
    expect(pick(before, "8 debits")).toEqual([
      [`103 ${m0}`, 2, -(13.71 + 81.11)], [`103 ${m1}`, 2, -(13.71 + 81.11)],
      [`108 ${m0}`, 2, -(5 + 1.95)], [`108 ${m1}`, 2, -(5 + 1.95)],
    ].map(([k, n, a]) => [k, n, Math.round((a as number) * 100) / 100]));

    await asPlatform(db);
    await db.exec(await script(true));
    const after = await counts();
    expect(pick(after, "1 overrides")).toEqual([["103 company", 88, null], ["105 company", 3, null], ["108 owner", 1, null], ["total", 92, null]]);
    expect(pick(after, "5 pending")).toEqual([[`TSYS ${m0}`, 3, null], [`TSYS ${m1}`, 3, null]]);
  });
});

describe("refusals: each raises its own message and changes nothing", () => {
  async function refused(expected: RegExp | string): Promise<void> {
    const before = await state(db);
    const message = await run(db, true);
    if (typeof expected === "string") expect(message).toContain(expected);
    else expect(message).toMatch(expected);
    expect(await state(db)).toBe(before);
  }

  it("one Bruce override fewer: found 87, expected 88 -- per line, and the total", async () => {
    await asPlatform(db);
    await db.exec(`delete from merchant_overrides where id = (
                     select o.id from merchant_overrides o join merchants m on m.id = o.merchant_id
                      where m.mid = 'PL0088')`);
    await db.exec(`delete from audit_log`);
    const before = await state(db);
    const message = await run(db, true);
    expect(message).toMatch(/^set-override-funding: ABORTED, nothing was changed\. The overrides on this project are not the expected ones:/);
    expect(message).toContain("overrides to agent 103: found 87, expected 88");
    expect(message).toContain("overrides to agent 103 on Plumlee LLC merchants: found 87, expected 88");
    expect(message).toContain("overrides in total: found 91, expected 92");
    expect(await state(db)).toBe(before);
  });

  it("an override to anyone else: found 93, expected 92", async () => {
    await asPlatform(db);
    await db.exec(`
      insert into merchants (agent_id, mid, dba, status, processor, split_agent_pct, split_company_pct, city, state)
      values ('${PLUMLEE}', 'XX0001', 'Extra', 'active', 'TSYS', 50, 50, 'Hattiesburg', 'MS');
      insert into merchant_overrides (merchant_id, recipient_id, override_pct, effective_from, funded_by)
      select id, '${OTHER_REP}', 5, '2026-01-01', 'owner' from merchants where mid = 'XX0001';
      delete from audit_log;`);
    await refused("overrides in total: found 93, expected 92");
  });

  it("Lamar's override not on its MID: found 0, expected 1", async () => {
    await asPlatform(db);
    await db.exec(`update merchants set mid = '30119964827' where mid = '${LAMAR_MID}'; delete from audit_log;`);
    await refused(`overrides to agent 108 on MID ${LAMAR_MID}: found 0, expected 1`);
  });

  it("a paid processor-month under an override to change, naming it", async () => {
    await asUser(db, ADMIN);
    const label = new Date(`${months[1]}T00:00:00Z`).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
    await db.query(`select close_payout_period('${months[1]}', 'TSYS', 'TSYS ${label}')`);
    await asPlatform(db);
    await db.exec(`delete from audit_log`);
    await refused(`These processor-months are marked paid and carry lines of overrides to change: TSYS ${months[1].slice(0, 7)}.`);
  });

  it("Lamar already company-funded", async () => {
    await asPlatform(db);
    await db.exec(`update merchant_overrides set funded_by = 'company'
                    where merchant_id = (select id from merchants where mid = '${LAMAR_MID}')`);
    await refused("The Lamar County Justice Court override is company-funded; it must stay owner-funded.");
  });

  it("a half-applied state", async () => {
    await asPlatform(db);
    await db.exec(`update merchant_overrides set funded_by = 'company'
                    where merchant_id = (select id from merchants where mid = 'PL0050')`);
    await refused("1 of the 91 overrides to change are company-funded already; a half-applied state is a question, not a re-run.");
  });

  it("no admin account by that email, or one that is not an active admin", async () => {
    await asPlatform(db);
    await db.exec(`update profiles set role = 'agent' where id = '${ADMIN}'`);
    await refused("the admin_email account is not an active admin");
    await db.exec(`update auth.users set email = 'someone@tapswipe.test' where id = '${ADMIN}'`);
    await refused("expected exactly one account with the admin_email set in this script, found 0");
  });

  it("no agent 103, or no agent 105 (agent numbers are unique, so never two)", async () => {
    await asPlatform(db);
    await db.exec(`update profiles set agent_number = null where id = '${BRUCE}'`);
    await refused("expected exactly one profile with agent_number 103, found 0");
    await db.exec(`update profiles set agent_number = '103' where id = '${BRUCE}';
                   update profiles set agent_number = null where id = '${SHERWIN}'`);
    await refused("expected exactly one profile with agent_number 105, found 0");
  });
});

describe("the write path", () => {
  it("goes through set_merchant_override_funding and never writes merchant_overrides itself", async () => {
    const sql = await script();
    expect(sql).toContain("set_merchant_override_funding(override_ref, 'company', reason)");
    expect(sql).not.toMatch(/update\s+merchant_overrides/i);
    expect(sql).not.toMatch(/insert\s+into\s+merchant_overrides/i);
    expect(sql).not.toMatch(/exception\s+when/i);
  });
});
