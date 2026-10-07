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
 * The filter parameters on dashboard_counts() (20261007).
 *
 * dashboard-and-search.test.ts owns the UNFILTERED behaviour and still passes
 * untouched, through the defaults. This file is about one question, asked from
 * every angle: **do the filters add reach?**
 *
 * They must not. Every parameter is an extra WHERE clause ANDed on top of the
 * caller's own policies, so an agent who passes another rep's agent_id gets
 * `agent_id = other` AND `agent_id = auth.uid()` — unsatisfiable, therefore
 * zero. That is not a check the function performs; it is a consequence of the
 * function not bypassing anything, and it is only true while the function stays
 * SECURITY INVOKER. The prosecdef assertion at the bottom is what pins that,
 * exactly as dashboard-and-search.test.ts pins it for the unfiltered form:
 * flip it and every assertion in this file quietly becomes an assertion about
 * nothing, while reading as if it still means something.
 *
 * The manager and territory filters are the subtle pair, because they resolve
 * THROUGH `profiles` rather than comparing a column on the counted row. That
 * subselect is RLS-scoped too — the profiles select policy is own-row plus
 * admin — so for an agent it can only ever return their own row. The tests
 * below assert the *same call* gives an admin their team and an agent only
 * themselves, which is the whole of it.
 *
 * Queries run as `authenticated` via asUser(). Running them as the owner would
 * pass whatever the policies said, since Postgres bypasses RLS for a table's
 * owner.
 */

/**
 * A fourth profile, because `seed()` has three and none of them manages anyone.
 *
 * Not added to seed() itself, for the reason seedPayouts() is separate: seed()
 * is run against migration subsets that predate these columns
 * (tests/rls/deactivation.test.ts calls createTestDb([INITIAL_MIGRATION])), and
 * anything it touches that a prefix has not created yet fails those suites with
 * `relation does not exist`, pointing nowhere near the cause.
 */
const MANAGER_ID = "44444444-4444-4444-4444-444444444444";

type CountsRow = {
  active_merchants: string;
  active_leads: string;
  ghost_sheets_total: string;
  pre_apps_total: string;
  open_tickets: string;
  leads_at_stage: string | null;
};

type Counts = {
  active_merchants: number;
  active_leads: number;
  ghost_sheets_total: number;
  pre_apps_total: number;
  open_tickets: number;
  /** Null rather than 0 when no stage was asked for — a different fact. */
  leads_at_stage: number | null;
};

type Filters = {
  agentId?: string | null;
  managerId?: string | null;
  territory?: string | null;
  status?: string | null;
  from?: string;
  to?: string;
};

/** A SQL literal, or NULL. Fixture-controlled values only — never user input. */
const lit = (value: string | null | undefined) =>
  value === null || value === undefined ? "null" : `'${value}'`;

async function counts(
  db: TestDb,
  userId: string | null,
  filters: Filters = {},
): Promise<Counts> {
  await asUser(db, userId);
  // Named arguments, so a reordering of the parameter list is a loud error here
  // rather than a silently different query — the territory and status
  // parameters are both `text` and adjacent, which is exactly the pair a
  // positional call would swap without complaint.
  const args = [
    `agent_id_input => ${lit(filters.agentId)}::uuid`,
    `manager_id_input => ${lit(filters.managerId)}::uuid`,
    `territory_input => ${lit(filters.territory)}`,
    `status_input => ${lit(filters.status)}`,
    `from_date_input => ${filters.from ?? "null"}`,
    `to_date_input => ${filters.to ?? "null"}`,
  ].join(", ");

  const [row] = await rows<CountsRow>(
    db,
    `select * from dashboard_counts(${args})`,
  );
  return {
    active_merchants: Number(row.active_merchants),
    active_leads: Number(row.active_leads),
    ghost_sheets_total: Number(row.ghost_sheets_total),
    pre_apps_total: Number(row.pre_apps_total),
    open_tickets: Number(row.open_tickets),
    leads_at_stage:
      row.leads_at_stage === null ? null : Number(row.leads_at_stage),
  };
}

const ZERO: Counts = {
  active_merchants: 0,
  active_leads: 0,
  ghost_sheets_total: 0,
  pre_apps_total: 0,
  open_tickets: 0,
  leads_at_stage: null,
};

/** The agent's own book, which several assertions below compare against. */
const AGENT_OWN: Counts = {
  active_merchants: 1,
  active_leads: 2,
  ghost_sheets_total: 3,
  pre_apps_total: 2,
  open_tickets: 1,
  leads_at_stage: null,
};

/**
 * A reporting line, two territories, a stage per lead, and one book that is a
 * month old.
 *
 * Three things this fixture is deliberately arranged to make falsifiable:
 *
 *  * **The manager set and the territory set are different sets**, and they
 *    produce different NUMBERS. Both reps report to the manager; the manager
 *    and one rep share a territory. If the two filters returned the same
 *    figures, a function that implemented one and ignored the other would pass
 *    both tests. The manager gets two merchants and two ghost sheets purely so
 *    those two columns discriminate — with one of each, "manager" and
 *    "territory North" came out identical in every column.
 *  * **One lead is at a stage AND excluded from active_leads.** 'Agent Lead A'
 *    is at 'application_sent' and has a pre-app pointing at it, so
 *    leads_at_stage counts it while active_leads does not. That is the only
 *    way to show the two columns are different facts rather than one filtered
 *    two ways.
 *  * **The manager's whole book is backdated and nothing else is**, so a date
 *    window is a real partition rather than a no-op — and so `to = today` has
 *    something to be wrong about.
 */
async function seedFilters(db: TestDb): Promise<void> {
  await asPlatform(db);
  await db.exec(`
    insert into auth.users (id, email)
      values ('${MANAGER_ID}', 'manager@tapswipe.test');

    insert into profiles (id, full_name, role, is_active, territory)
      values ('${MANAGER_ID}', 'Manager User', 'agent', true, 'North');

    -- One hop only, the shape set_manager() enforces: both reps report to the
    -- manager, and the manager reports to nobody.
    update profiles set manager_id = '${MANAGER_ID}', territory = 'North'
     where id = '${AGENT_ID}';
    update profiles set manager_id = '${MANAGER_ID}', territory = 'South'
     where id = '${OTHER_AGENT_ID}';

    insert into merchants
      (agent_id, mid, dba, legal_business_name, status, processor)
    values
      ('${MANAGER_ID}', 'MID-MGR-1', 'Manager Co One', 'Manager Co One LLC', 'active', 'TSYS'),
      ('${MANAGER_ID}', 'MID-MGR-2', 'Manager Co Two', 'Manager Co Two LLC', 'active', 'TSYS');

    insert into leads (agent_id, dba, status)
      values ('${MANAGER_ID}', 'Manager Lead', 'new');

    insert into ghost_sheets (agent_id, dba, contact_name, status) values
      ('${MANAGER_ID}', 'Manager Sheet One', 'Mgr One', 'open'),
      ('${MANAGER_ID}', 'Manager Sheet Two', 'Mgr Two', 'open');

    insert into pre_apps (agent_id, status, dba_name, legal_business_name)
      values ('${MANAGER_ID}', 'draft', 'Manager App', 'Manager App LLC');

    insert into support_tickets
      (agent_id, subject, message, status, category, priority)
    values
      ('${MANAGER_ID}', 'Manager ticket', 'Needs help.', 'open', 'Billing', 'Normal');

    -- Stages. 'Agent Lead C' and 'Manager Lead' keep the column default 'new'.
    update leads set status = 'qualified' where dba = 'Agent Lead B';
    update leads set status = 'qualified' where dba = 'Other Agent Lead';
    update leads set status = 'application_sent' where dba = 'Agent Lead A';

    -- ...and the pre-app that makes 'Agent Lead A' drop out of active_leads.
    update pre_apps
       set lead_id = (select id from leads where dba = 'Agent Lead A')
     where dba_name = 'Agent Draft App';

    -- The manager's book is a month old; everything else was created just now.
    update merchants       set created_at = now() - interval '30 days' where agent_id = '${MANAGER_ID}';
    update leads           set created_at = now() - interval '30 days' where agent_id = '${MANAGER_ID}';
    update ghost_sheets    set created_at = now() - interval '30 days' where agent_id = '${MANAGER_ID}';
    update pre_apps        set created_at = now() - interval '30 days' where agent_id = '${MANAGER_ID}';
    update support_tickets set created_at = now() - interval '30 days' where agent_id = '${MANAGER_ID}';
  `);
}

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

beforeEach(async () => {
  await resetData(db);
  await seedFilters(db);
});

afterAll(async () => {
  await db?.close();
});

describe("an agent gains nothing by filtering", () => {
  it("returns zeros for another rep's agent_id rather than their numbers", async () => {
    // The headline. The other agent demonstrably HAS a book — the admin
    // assertion in the next describe reads it — and this returns none of it.
    expect(await counts(db, AGENT_ID, { agentId: OTHER_AGENT_ID })).toEqual(
      ZERO,
    );
  });

  it("still returns the agent's own book when they filter by themselves", async () => {
    // Without this the assertion above would pass against a function whose
    // agent filter was simply broken for agents — zero for everyone is not the
    // same claim as zero for everyone else.
    expect(await counts(db, AGENT_ID, { agentId: AGENT_ID })).toEqual(
      AGENT_OWN,
    );
  });

  it("gives the agent only themselves when they filter by their own manager", async () => {
    // The agent really does report to this manager, so the filter MATCHES —
    // this is not a near-miss. What stops it widening is that scoped_agents is
    // itself RLS-scoped, so the agent's own profile row is the only one the
    // subselect can see. Compare with the admin making the identical call in
    // the next describe, who gets the whole team.
    expect(await counts(db, AGENT_ID, { managerId: MANAGER_ID })).toEqual(
      AGENT_OWN,
    );
  });

  it("returns zeros for a manager the agent does not report to", async () => {
    expect(await counts(db, AGENT_ID, { managerId: OTHER_AGENT_ID })).toEqual(
      ZERO,
    );
  });

  it("gives the agent only themselves in their own territory", async () => {
    // 'North' also holds the manager's two merchants and two sheets. The agent
    // sees neither.
    expect(await counts(db, AGENT_ID, { territory: "North" })).toEqual(
      AGENT_OWN,
    );
  });

  it("returns zeros for a territory the agent is not in", async () => {
    // 'South' is the other agent's, and it is not empty.
    expect(await counts(db, AGENT_ID, { territory: "South" })).toEqual(ZERO);
  });

  it("counts only the agent's own leads at a stage", async () => {
    // Two leads are 'qualified' company-wide; one of them is this agent's.
    const own = await counts(db, AGENT_ID, { status: "qualified" });
    expect(own.leads_at_stage).toBe(1);

    const company = await counts(db, ADMIN_ID, { status: "qualified" });
    expect(company.leads_at_stage).toBe(2);
  });

  it("returns zeros for every filter at once from a caller with no JWT", async () => {
    // auth.uid() is null, so no own-row branch matches and is_admin() is false.
    // The function has no guard of its own — this passing is entirely RLS.
    expect(
      await counts(db, null, {
        agentId: AGENT_ID,
        managerId: MANAGER_ID,
        territory: "North",
        status: "qualified",
      }),
    ).toEqual({ ...ZERO, leads_at_stage: 0 });
  });
});

describe("an admin filters a view they already had in full", () => {
  it("counts the whole company when nothing is filtered", async () => {
    expect(await counts(db, ADMIN_ID)).toEqual({
      active_merchants: 4,
      active_leads: 4,
      ghost_sheets_total: 6,
      pre_apps_total: 4,
      open_tickets: 3,
      leads_at_stage: null,
    });
  });

  it("narrows to one rep", async () => {
    // Identical to what that agent gets unfiltered, which is the cross-check
    // that the filter selects the same rows the policy would.
    expect(await counts(db, ADMIN_ID, { agentId: AGENT_ID })).toEqual(
      AGENT_OWN,
    );
  });

  it("narrows to a manager's reports, excluding the manager's own book", async () => {
    // AGENT + OTHER_AGENT. The manager's own two merchants and two sheets are
    // absent: "reports to X" is one hop and does not include X.
    expect(await counts(db, ADMIN_ID, { managerId: MANAGER_ID })).toEqual({
      active_merchants: 2,
      active_leads: 3,
      ghost_sheets_total: 4,
      pre_apps_total: 3,
      open_tickets: 2,
      leads_at_stage: null,
    });
  });

  it("narrows to a territory, which is a different set from a manager's team", async () => {
    // 'North' is AGENT + MANAGER, where the manager's team is AGENT + OTHER.
    // The merchant and ghost-sheet columns differ from the manager figures
    // above, which is what stops a function that implemented one filter and
    // ignored the other from passing both tests.
    expect(await counts(db, ADMIN_ID, { territory: "North" })).toEqual({
      active_merchants: 3,
      active_leads: 3,
      ghost_sheets_total: 5,
      pre_apps_total: 3,
      open_tickets: 2,
      leads_at_stage: null,
    });

    expect(await counts(db, ADMIN_ID, { territory: "South" })).toEqual({
      active_merchants: 1,
      active_leads: 1,
      ghost_sheets_total: 1,
      pre_apps_total: 1,
      open_tickets: 1,
      leads_at_stage: null,
    });
  });

  it("combines a stage with a rep", async () => {
    const both = await counts(db, ADMIN_ID, {
      agentId: OTHER_AGENT_ID,
      status: "qualified",
    });
    expect(both.leads_at_stage).toBe(1);
    expect(both.active_leads).toBe(1);
  });

  it("returns nothing for a rep who does not exist", async () => {
    expect(
      await counts(db, ADMIN_ID, {
        agentId: "99999999-9999-9999-9999-999999999999",
      }),
    ).toEqual(ZERO);
  });
});

describe("the date window", () => {
  it("excludes records created before the start of the range", async () => {
    // The manager's whole book is 30 days old; everything else is from today.
    expect(
      await counts(db, ADMIN_ID, { from: "current_date - 2" }),
    ).toEqual({
      active_merchants: 2,
      active_leads: 3,
      ghost_sheets_total: 4,
      pre_apps_total: 3,
      open_tickets: 2,
      leads_at_stage: null,
    });
  });

  it("excludes records created after the end of the range", async () => {
    expect(await counts(db, ADMIN_ID, { to: "current_date - 10" })).toEqual({
      active_merchants: 2,
      active_leads: 1,
      ghost_sheets_total: 2,
      pre_apps_total: 1,
      open_tickets: 1,
      leads_at_stage: null,
    });
  });

  it("includes the whole of the end day, not just its midnight", async () => {
    // The off-by-one-day this exists to prevent: created_at is a timestamptz,
    // so `created_at <= current_date` compares against 00:00 today and drops
    // everything created since. The fixture's non-manager records were all
    // created a moment ago, so with `<=` this returns the manager's backdated
    // book alone — a plausible-looking set of smaller numbers with nothing to
    // say it is wrong.
    expect(await counts(db, ADMIN_ID, { to: "current_date" })).toEqual({
      active_merchants: 4,
      active_leads: 4,
      ghost_sheets_total: 6,
      pre_apps_total: 4,
      open_tickets: 3,
      leads_at_stage: null,
    });
  });

  it("narrows an agent's own book without reaching past it", async () => {
    expect(
      await counts(db, AGENT_ID, { from: "current_date - 2" }),
    ).toEqual(AGENT_OWN);
    expect(
      await counts(db, AGENT_ID, { to: "current_date - 10" }),
    ).toEqual(ZERO);
  });
});

describe("leads_at_stage is a different fact from active_leads", () => {
  it("is null when no stage was asked for", async () => {
    // Null rather than 0: "you did not ask" and "there are none" are different
    // answers, and the dashboard renders them differently.
    expect((await counts(db, ADMIN_ID)).leads_at_stage).toBeNull();
  });

  it("counts a lead that active_leads deliberately excludes", async () => {
    // 'Agent Lead A' is at 'application_sent' and has a pre-app pointing at it,
    // so it is out of the funnel figure and in the stage figure. Folding the
    // stage filter into active_leads would report 0 here while looking
    // perfectly healthy.
    const row = await counts(db, ADMIN_ID, { status: "application_sent" });
    expect(row.leads_at_stage).toBe(1);
    expect(row.active_leads).toBe(4);
  });

  it("leaves the other four counts alone", async () => {
    // A stage is a lead concept. It must not silently zero the merchant,
    // ghost-sheet, pre-app and ticket figures beside it.
    const row = await counts(db, ADMIN_ID, { status: "qualified" });
    expect(row).toEqual({
      active_merchants: 4,
      active_leads: 4,
      ghost_sheets_total: 6,
      pre_apps_total: 4,
      open_tickets: 3,
      leads_at_stage: 2,
    });
  });

  it("is zero, not null, for a stage nobody is at", async () => {
    expect((await counts(db, ADMIN_ID, { status: "lost" })).leads_at_stage).toBe(
      0,
    );
  });
});

describe("the filtered function is locked down like every other RPC", () => {
  const SIGNATURE = "dashboard_counts(uuid, uuid, text, text, date, date)";

  it("is not executable by anon", async () => {
    await asPlatform(db);
    const [{ ok }] = await rows<{ ok: boolean }>(
      db,
      `select has_function_privilege('anon', '${SIGNATURE}', 'execute') as ok`,
    );
    expect(ok).toBe(false);
  });

  it("is executable by authenticated and service_role", async () => {
    await asPlatform(db);
    for (const role of ["authenticated", "service_role"]) {
      const [{ ok }] = await rows<{ ok: boolean }>(
        db,
        `select has_function_privilege('${role}', '${SIGNATURE}', 'execute') as ok`,
      );
      expect(ok, `${role} should execute ${SIGNATURE}`).toBe(true);
    }
  });

  it("is NOT security definer", async () => {
    // The property every assertion in this file depends on. prosecdef true here
    // would run the function as its owner, bypass RLS, and turn "an agent gains
    // nothing by filtering" into an agent reading the whole company — with the
    // filters becoming the exact definer escape hatch they were written not to
    // be.
    await asPlatform(db);
    const definers = await rows<{ proname: string }>(
      db,
      `select proname from pg_proc where proname = 'dashboard_counts' and prosecdef`,
    );
    expect(definers).toEqual([]);
  });

  it("exists exactly once, so a bare call cannot be ambiguous", async () => {
    // The zero-argument version is DROPPED by the migration rather than left
    // beside this one. Two candidates, both callable with no arguments, is an
    // ambiguity Postgres reports at call time — from the browser, on the
    // dashboard, rather than here.
    await asPlatform(db);
    const found = await rows<{ count: string }>(
      db,
      `select count(*) as count from pg_proc where proname = 'dashboard_counts'`,
    );
    expect(Number(found[0].count)).toBe(1);
  });

  it("keeps the unfiltered counts off `profiles` entirely", async () => {
    // Greps the function body, the way commit-residual-import.test.ts greps for
    // its coalesce merge rule — and for the same reason: this rule matters and
    // cannot be observed from outside.
    //
    // The `by_agent` guard means an unfiltered call never evaluates
    // scoped_agents, so the five headline figures do not depend on the profiles
    // SELECT policy. Removing the guard changes NO result today — every test in
    // this file and in dashboard-and-search.test.ts still passes, measured —
    // because an admin can see every profiles row and an agent's records all
    // point at their own. It would start to matter the day that policy changes,
    // and the symptom then would be every number on every dashboard moving at
    // once, for a reason nothing connects to the policy that moved.
    //
    // So this is a structural assertion, deliberately, and it is the only
    // coverage the guard has. Said out loud rather than implied by a test that
    // would pass either way.
    await asPlatform(db);
    const [{ body }] = await rows<{ body: string }>(
      db,
      `select prosrc as body from pg_proc where proname = 'dashboard_counts'`,
    );
    expect(body).toMatch(/as by_agent/);
    expect(body).toMatch(/not f\.by_agent or/);
    // And the guard must be built from the three agent filters, not pinned on.
    expect(body).toMatch(
      /agent_id_input is not null[\s\S]*?or manager_id_input is not null[\s\S]*?or territory_input is not null\) as by_agent/,
    );
  });

  it("adds no policy that reads manager_id or territory", async () => {
    // The same grep tests/rls/set-manager.test.ts and set-territory.test.ts
    // run, repeated here because this is the change most likely to cross that
    // line: filtering BY a reporting label is a dashboard query, and making
    // one decide what a caller may see is a rewrite of the access model.
    await asPlatform(db);
    const hits = await rows<{ policyname: string }>(
      db,
      `select policyname from pg_policies
        where schemaname = 'public'
          and (coalesce(qual, '') || ' ' || coalesce(with_check, ''))
              ~ '(manager_id|territory)'`,
    );
    expect(hits).toEqual([]);
  });
});
