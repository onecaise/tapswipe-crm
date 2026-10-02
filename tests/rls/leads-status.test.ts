import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  AGENT_ID,
  OTHER_AGENT_ID,
  asPlatform,
  asUser,
  createTestDb,
  migrationsExcept,
  readMigration,
  resetData,
  rows,
  seed,
  type TestDb,
} from "../helpers/db";
import { LEAD_STATUSES } from "@/lib/leads";

const MIGRATION = "20261002120000_leads_status_vocabulary.sql";

type CountRow = { n: number };
type StatusRow = { dba: string; status: string };

/**
 * `leads.status` gets a real vocabulary, and the three things that makes true:
 * the backfill is right, NOT NULL and the CHECK are one mechanism rather than
 * two, and NOT VALID binds new writes while exempting the rows that predate it.
 *
 * The backfill block builds its own database from every migration EXCEPT this
 * one, seeds the mess production actually holds, and then applies the migration
 * by hand. Asserting the backfill against a database that already ran it would
 * only prove `update` works — the rows have to exist in their pre-migration
 * shape first, and a free-text column cannot be put back once it is constrained.
 */
describe("leads status backfill", () => {
  let db: TestDb;

  beforeAll(async () => {
    db = await createTestDb(await migrationsExcept(MIGRATION));
    await seed(db);

    // The three shapes the column really holds, written while it was still
    // `text default 'open'` with no check and no not-null. toPayload() in the
    // lead form maps a blank field to NULL, which is where the NULLs come from;
    // 'open' is the old default; the rest is whatever a rep typed.
    await asPlatform(db);
    await db.exec(`
      insert into leads (agent_id, dba, status) values
        ('${AGENT_ID}', 'Null Status Lead',  null),
        ('${AGENT_ID}', 'Open Status Lead',  'open'),
        ('${AGENT_ID}', 'Typed Status Lead', 'Left voicemail'),
        ('${AGENT_ID}', 'Word Lost Lead',    'lost');
    `);

    await db.exec(await readMigration(MIGRATION));
  });

  afterAll(async () => {
    await db?.close();
  });

  it("maps NULL and 'open' to 'new', and leaves rep-typed values alone", async () => {
    await asPlatform(db);
    const result = await rows<StatusRow>(
      db,
      `select dba, status from leads
        where dba in ('Null Status Lead', 'Open Status Lead', 'Typed Status Lead')
        order by dba`,
    );

    expect(result).toEqual([
      { dba: "Null Status Lead", status: "new" },
      { dba: "Open Status Lead", status: "new" },
      // Untouched on purpose. A migration cannot tell 'Left voicemail' from
      // 'dead', and mapping every unknown to 'new' would resurrect lost deals
      // into the top of the pipeline.
      { dba: "Typed Status Lead", status: "Left voicemail" },
    ]);
  });

  it("leaves every seeded lead at 'new' rather than inventing a stage", async () => {
    // seed() writes no status at all, so these rows carried the old 'open'
    // default. If the backfill had missed the default-valued rows, every lead
    // in the fixture would now be unreadable to the pipeline filter.
    await asPlatform(db);
    const [{ n }] = await rows<CountRow>(
      db,
      `select count(*)::int as n from leads where status <> 'new'
         and dba <> 'Typed Status Lead' and dba <> 'Word Lost Lead'`,
    );
    expect(n).toBe(0);
  });

  it("keeps the rows that would fail the new constraints, rather than deleting them", async () => {
    // The point of NOT VALID: nothing is destroyed and nothing is rewritten.
    // Both of these are what the review query in the migration exists to list.
    await asPlatform(db);
    const [{ n }] = await rows<CountRow>(
      db,
      `select count(*)::int as n from leads
        where dba in ('Typed Status Lead', 'Word Lost Lead')`,
    );
    expect(n).toBe(2);
  });

  it("does not validate either constraint while those rows are present", async () => {
    // The whole claim of NOT VALID is that the data is NOT clean yet. If
    // `validate` passed here, either the backfill rewrote something it should
    // not have or the constraint does not say what it looks like it says.
    await asPlatform(db);

    await expect(
      db.exec(
        `alter table leads validate constraint leads_status_vocabulary;`,
      ),
    ).rejects.toThrow(/leads_status_vocabulary/);

    // 'lost' was a legal thing for a rep to type into a free-text column, and
    // no such row can have a lost_reason — the column did not exist until this
    // migration added it.
    await expect(
      db.exec(
        `alter table leads validate constraint leads_lost_reason_required;`,
      ),
    ).rejects.toThrow(/leads_lost_reason_required/);
  });

  it("rejects a bad value once the legacy rows are cleaned and the constraint is validated", async () => {
    // The follow-up migration, rehearsed: fix the rows the review query lists,
    // then validate. Done as the platform owner here only because this is a
    // migration rehearsal — the real path is the rep doing it through the form,
    // so the cross-agent audit trigger sees it.
    await asPlatform(db);
    await db.exec(`
      update leads set status = 'contacted' where dba = 'Typed Status Lead';
      update leads set lost_reason = 'Went with their existing processor'
       where dba = 'Word Lost Lead';
    `);

    await db.exec(`
      alter table leads validate constraint leads_status_vocabulary;
      alter table leads validate constraint leads_lost_reason_required;
    `);

    const [{ n }] = await rows<CountRow>(
      db,
      `select count(*)::int as n from pg_constraint
        where conrelid = 'leads'::regclass
          and conname in ('leads_status_vocabulary', 'leads_lost_reason_required')
          and convalidated`,
    );
    expect(n).toBe(2);

    // And the validated constraint still rejects — a `validate` that quietly
    // dropped the rule would pass every assertion above this one.
    await expect(
      db.exec(
        `insert into leads (agent_id, dba, status)
         values ('${AGENT_ID}', 'Post Validation Lead', 'Left voicemail');`,
      ),
    ).rejects.toThrow(/leads_status_vocabulary/);
  });
});

describe("leads status vocabulary", () => {
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

  it("accepts every value lib/leads.ts offers, and only those", async () => {
    // LEAD_STATUSES is a copy of the constraint for the UI's benefit, and
    // nothing type-checks the pair. This is what pins it: a value added to one
    // side and not the other fails here rather than at a rep's keyboard.
    await asUser(db, AGENT_ID);

    for (const status of LEAD_STATUSES) {
      const reason = status === "lost" ? `, 'Priced out'` : `, null`;
      await db.exec(
        `insert into leads (agent_id, dba, status, lost_reason)
         values ('${AGENT_ID}', 'Lead ${status}', '${status}'${reason});`,
      );
    }

    const [{ n }] = await rows<CountRow>(
      db,
      `select count(*)::int as n from leads where dba like 'Lead %'`,
    );
    expect(n).toBe(LEAD_STATUSES.length);

    const [{ n: vocab }] = await rows<CountRow>(
      db,
      `select cardinality(
         regexp_split_to_array(
           substring(pg_get_constraintdef(oid) from '\\((.*)\\)'), ','
         )
       ) as n
       from pg_constraint
      where conrelid = 'leads'::regclass and conname = 'leads_status_vocabulary'`,
    );
    // Same count both sides, so the constraint cannot quietly carry an eighth
    // value this build has never heard of.
    expect(vocab).toBe(LEAD_STATUSES.length);
  });

  it("has no 'won' value — a win is derived, never hand-set", async () => {
    await asUser(db, AGENT_ID);

    await expect(
      db.exec(
        `insert into leads (agent_id, dba, status)
         values ('${AGENT_ID}', 'Won Lead', 'won');`,
      ),
    ).rejects.toThrow(/leads_status_vocabulary/);

    // And nothing on the table records one either, so there is no second place
    // for the funnel to disagree with itself.
    const [{ n }] = await rows<CountRow>(
      db,
      `select count(*)::int as n from information_schema.columns
        where table_name = 'leads' and column_name like '%won%'`,
    );
    expect(n).toBe(0);
  });

  it("rejects an unknown value on insert and on update", async () => {
    await asUser(db, AGENT_ID);

    await expect(
      db.exec(
        `insert into leads (agent_id, dba, status)
         values ('${AGENT_ID}', 'Bogus Lead', 'in_progress');`,
      ),
    ).rejects.toThrow(/leads_status_vocabulary/);

    await expect(
      db.exec(
        `update leads set status = 'in_progress' where dba = 'Agent Lead A';`,
      ),
    ).rejects.toThrow(/leads_status_vocabulary/);
  });

  it("refuses a NULL status, which is what makes the CHECK mean anything", async () => {
    // A CHECK evaluates to NULL for a NULL input, and a CHECK that evaluates to
    // NULL PASSES. Without `not null` this update would be ACCEPTED and defeat
    // the vocabulary and every filter built on it, silently. The two clauses
    // are one mechanism — this is the half that is easy to leave out.
    await asUser(db, AGENT_ID);

    await expect(
      db.exec(`update leads set status = null where dba = 'Agent Lead A';`),
    ).rejects.toThrow(/null value in column "status"|not-null/i);
  });

  it("defaults a new lead to 'new'", async () => {
    await asUser(db, AGENT_ID);
    await db.exec(
      `insert into leads (agent_id, dba) values ('${AGENT_ID}', 'Defaulted Lead');`,
    );

    const [row] = await rows<StatusRow>(
      db,
      `select dba, status from leads where dba = 'Defaulted Lead'`,
    );
    expect(row.status).toBe("new");
  });

  it("moves a lead backwards without complaint", async () => {
    // There is deliberately no state-machine trigger here, unlike pre_apps.
    // Sales moves backwards as a matter of course and no lead stage has a
    // consequence the way a pre-app approval does. If someone adds a guard,
    // this is what should tell them it was not wanted.
    await asUser(db, AGENT_ID);

    await db.exec(
      `update leads set status = 'qualified' where dba = 'Agent Lead A';`,
    );
    await db.exec(
      `update leads set status = 'contacted' where dba = 'Agent Lead A';`,
    );

    const [row] = await rows<StatusRow>(
      db,
      `select dba, status from leads where dba = 'Agent Lead A'`,
    );
    expect(row.status).toBe("contacted");
  });

  it("indexes status, which is what the pipeline filter reads", async () => {
    await asPlatform(db);
    const [{ n }] = await rows<CountRow>(
      db,
      `select count(*)::int as n from pg_indexes
        where tablename = 'leads' and indexname = 'idx_leads_status'`,
    );
    expect(n).toBe(1);
  });
});

describe("leads lost_reason", () => {
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

  it("requires a reason to mark a lead lost", async () => {
    await asUser(db, AGENT_ID);

    await expect(
      db.exec(`update leads set status = 'lost' where dba = 'Agent Lead A';`),
    ).rejects.toThrow(/leads_lost_reason_required/);
  });

  it("does not accept whitespace as a reason", async () => {
    // '' and '   ' are values, so `lost_reason is not null` alone would let a
    // rep tab past the field and record nothing while satisfying the rule.
    await asUser(db, AGENT_ID);

    await expect(
      db.exec(
        `update leads set status = 'lost', lost_reason = '   '
          where dba = 'Agent Lead A';`,
      ),
    ).rejects.toThrow(/leads_lost_reason_required/);
  });

  it("accepts a lost lead that explains itself", async () => {
    await asUser(db, AGENT_ID);
    await db.exec(
      `update leads set status = 'lost', lost_reason = 'Signed with Square'
        where dba = 'Agent Lead A';`,
    );

    const [row] = await rows<{ status: string; lost_reason: string }>(
      db,
      `select status, lost_reason from leads where dba = 'Agent Lead A'`,
    );
    expect(row.status).toBe("lost");
    expect(row.lost_reason).toBe("Signed with Square");
  });

  it("allows a stale reason on a lead that is no longer lost", async () => {
    // The constraint is one-directional on purpose: it says a lost lead needs a
    // reason, not that a reason implies lost. Clearing it is the FORM's job
    // (toPayload nulls it off 'lost'), and enforcing it here would reject the
    // single UPDATE that moves both columns if the two ever got out of step.
    await asUser(db, AGENT_ID);
    await db.exec(
      `update leads set status = 'nurturing', lost_reason = 'Changed their mind'
        where dba = 'Agent Lead A';`,
    );

    const [row] = await rows<StatusRow>(
      db,
      `select dba, status from leads where dba = 'Agent Lead A'`,
    );
    expect(row.status).toBe("nurturing");
  });

  it("still scopes all of this by RLS", async () => {
    // The new columns carry no new privilege. A rep setting a stage on someone
    // else's lead is filtered to zero rows exactly as before, so the update
    // reports nothing changed rather than erroring on the constraint.
    await asUser(db, OTHER_AGENT_ID);
    await db.exec(
      `update leads set status = 'lost', lost_reason = 'Not mine to lose'
        where dba = 'Agent Lead A';`,
    );

    await asPlatform(db);
    const [row] = await rows<StatusRow>(
      db,
      `select dba, status from leads where dba = 'Agent Lead A'`,
    );
    expect(row.status).toBe("new");
  });
});

describe("leads website", () => {
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

  it("is writable by the owning rep and has no format rule", async () => {
    // Deliberately unconstrained, matching pre_apps.website, which this exists
    // to stop reps retyping. A CHECK on one and not the other would mean a lead
    // holding a value its own pre-app refuses.
    await asUser(db, AGENT_ID);
    await db.exec(
      `update leads set website = 'dotsdiner' where dba = 'Agent Lead A';`,
    );

    const [row] = await rows<{ website: string }>(
      db,
      `select website from leads where dba = 'Agent Lead A'`,
    );
    expect(row.website).toBe("dotsdiner");
  });

  it("is not writable on another agent's lead", async () => {
    await asUser(db, OTHER_AGENT_ID);
    await db.exec(
      `update leads set website = 'planted.test' where dba = 'Agent Lead A';`,
    );

    await asPlatform(db);
    const [row] = await rows<{ website: string | null }>(
      db,
      `select website from leads where dba = 'Agent Lead A'`,
    );
    expect(row.website).toBeNull();
  });
});
