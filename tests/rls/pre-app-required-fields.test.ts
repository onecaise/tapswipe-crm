import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ADMIN_ID,
  AGENT_ID,
  asPlatform,
  asUser,
  createTestDb,
  resetData,
  rows,
  type TestDb,
} from "../helpers/db";
import {
  REQUIRED_ITEM_REMOVALS,
  makeSubmittable,
  removeRequiredItem,
} from "../helpers/pre-app-submittable";
import { PRE_APP_REQUIRED_ITEMS } from "@/lib/pre-app-required";

/**
 * pre_app_missing_fields() and the submit_pre_app() that refuses with it
 * (phase 4 of docs/design/intake-and-reports.md, §6, §7.1, §0b.4).
 *
 *   - every required item, one at a time: removing it ALONE makes the
 *     function report exactly that code AND makes submit refuse (the
 *     mutation check, one per code);
 *   - every missing item at once, in one refusal, naming every label;
 *   - the snapshot of the rep's identity and split rate, and that a later
 *     profile change moves neither the submitted pre-app nor the merchant;
 *   - the snapshot columns, country and the split are not client-writable.
 */

type MissingItem = { code: string; step: string; label: string; owner_id?: number };
type PgError = { code?: string; message: string; detail?: string };

let db: TestDb;
let draftId: number;
let submittedId: number;
let otherDraftId: number;

async function missingFor(caller: string, id: number): Promise<MissingItem[]> {
  await asUser(db, caller);
  const [row] = await rows<{ m: MissingItem[] }>(
    db,
    `select pre_app_missing_fields(${id}) as m`,
  );
  return row.m;
}

async function failure(sql: string): Promise<PgError | null> {
  try {
    await db.exec(sql);
    return null;
  } catch (error) {
    return error as PgError;
  }
}

async function statusOf(id: number): Promise<string> {
  await asPlatform(db);
  const [row] = await rows<{ status: string }>(db, `select status from pre_apps where id = ${id}`);
  return row.status;
}

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
  draftId = byName.get("Agent Draft App")!;
  submittedId = byName.get("Agent Submitted App")!;
  otherDraftId = byName.get("Other Draft App")!;
});

afterAll(async () => {
  await db?.close();
});

describe("a complete pre-app", () => {
  it("has nothing missing, and submits", async () => {
    await makeSubmittable(db, draftId);
    expect(await missingFor(AGENT_ID, draftId)).toEqual([]);
    await asUser(db, AGENT_ID);
    await db.exec(`select submit_pre_app(${draftId})`);
    expect(await statusOf(draftId)).toBe("submitted");
  });

  it("the helper fills every item the vocabulary lists", () => {
    // Every code has a removal below, and nothing else does: a new code in
    // the function without a test here fails this.
    expect(Object.keys(REQUIRED_ITEM_REMOVALS).sort()).toEqual(
      PRE_APP_REQUIRED_ITEMS.map((i) => i.code).sort(),
    );
  });
});

describe("each required item, missing alone, blocks submit", () => {
  for (const code of Object.keys(REQUIRED_ITEM_REMOVALS)) {
    it(`${code}: reported alone, and submit refuses naming it`, async () => {
      // Inside a transaction that is always rolled back: two removals drop a
      // CHECK (country), and a refused submit aborts the transaction anyway.
      await db.exec("begin");
      try {
        await makeSubmittable(db, draftId);
        await removeRequiredItem(db, draftId, code);

        const missing = await missingFor(AGENT_ID, draftId);
        expect(missing.map((m) => m.code)).toEqual([code]);
        expect(missing[0].label.length).toBeGreaterThan(10);

        await asUser(db, AGENT_ID);
        const error = await failure(`select submit_pre_app(${draftId})`);
        expect(error?.code).toBe("PT422");
        expect(error?.message).toContain(missing[0].label);
        expect(JSON.parse(error?.detail ?? "[]")).toEqual([code]);
      } finally {
        await db.exec("rollback");
      }
      expect(await statusOf(draftId)).toBe("draft");
    });
  }
});

describe("every missing item at once", () => {
  it("an empty draft reports every business item, and submit lists them all in one refusal", async () => {
    await asPlatform(db);
    await db.exec(`
      insert into pre_apps (agent_id, dba_name, legal_business_name)
      values ('${AGENT_ID}', 'Bare Draft', 'Bare Draft LLC');
    `);
    const [{ id }] = await rows<{ id: number }>(db, `select id from pre_apps where dba_name = 'Bare Draft'`);

    const missing = await missingFor(AGENT_ID, id);
    const codes = missing.map((m) => m.code);
    expect(codes).toEqual([
      "contact_phone", "physical_address", "city", "state", "zip",
      "legal_entity_type", "state_incorporated", "business_type", "bank_name",
      "est_annual_volume", "est_monthly_volume", "est_average_ticket", "est_high_ticket",
      "tax_id", "owner_required", "banking", "rep_identity",
    ]);

    await asUser(db, AGENT_ID);
    const error = await failure(`select submit_pre_app(${id})`);
    expect(error?.code).toBe("PT422");
    expect(error?.message).toMatch(/^This pre-app cannot be submitted yet\. 17 things are missing: /);
    for (const item of missing) expect(error?.message).toContain(item.label);
    expect(JSON.parse(error?.detail ?? "[]")).toEqual(codes);
  });

  it("reports owner items per owner, naming the owner and carrying owner_id", async () => {
    await makeSubmittable(db, draftId);
    await removeRequiredItem(db, draftId, "owner_percent_owned"); // adds 'Second Owner'
    await removeRequiredItem(db, draftId, "owner_home_city"); // both owners
    const missing = await missingFor(AGENT_ID, draftId);
    await asPlatform(db);
    const owners = await rows<{ id: number; owner_name: string }>(
      db,
      `select id, owner_name from pre_app_owners where pre_app_id = ${draftId} order by id`,
    );
    expect(missing).toEqual([
      {
        code: "owner_home_city", step: "owners", owner_id: owners[0].id,
        label: "Owner 1 (Control Owner): home city is required.",
      },
      {
        code: "owner_percent_owned", step: "owners", owner_id: owners[1].id,
        label: "Owner 2 (Second Owner): percent owned is required.",
      },
      {
        code: "owner_home_city", step: "owners", owner_id: owners[1].id,
        label: "Owner 2 (Second Owner): home city is required.",
      },
    ]);
  });

  it("names the tax ID's three cases in one code", async () => {
    await makeSubmittable(db, draftId);
    await asPlatform(db);
    await db.exec(`update pre_apps set ein_type = 'SSN' where id = ${draftId}`);
    expect(await missingFor(AGENT_ID, draftId)).toEqual([
      {
        code: "tax_id", step: "secrets",
        label: "The tax ID on file is an EIN, but EIN type says SSN. Enter the SSN.",
      },
    ]);
    await asPlatform(db);
    await db.exec(`delete from pre_app_tax_secrets where pre_app_id = ${draftId}`);
    expect((await missingFor(AGENT_ID, draftId))[0].label).toBe(
      "The SSN (tax ID) has not been entered.",
    );
    await asPlatform(db);
    await db.exec(`update pre_apps set ein_type = null where id = ${draftId}`);
    expect(await missingFor(AGENT_ID, draftId)).toEqual([
      {
        code: "tax_id", step: "business",
        label: "Choose an EIN type (EIN or SSN), then enter the tax ID.",
      },
    ]);
  });
});

describe("rep identity is the pre-app's rep, not the caller", () => {
  it("holds an admin submitting on a rep's behalf to the rep's profile", async () => {
    await makeSubmittable(db, draftId);
    await asPlatform(db);
    await db.exec(`
      update profiles set legal_name = 'Admin Person', llc_legal_name = 'Admin LLC' where id = '${ADMIN_ID}';
      update profiles set llc_legal_name = null where id = '${AGENT_ID}';
    `);
    expect((await missingFor(ADMIN_ID, draftId)).map((m) => m.code)).toEqual(["rep_identity"]);
    await asUser(db, ADMIN_ID);
    const error = await failure(`select submit_pre_app(${draftId})`);
    expect(error?.code).toBe("PT422");
    expect(error?.message).toContain("legal name and LLC legal name");
  });

  it("does not care whether the admin caller has an identity", async () => {
    await makeSubmittable(db, draftId);
    expect(await missingFor(ADMIN_ID, draftId)).toEqual([]);
  });
});

describe("the snapshot at submit", () => {
  async function snapshot(id: number) {
    await asPlatform(db);
    const [row] = await rows<{
      rep_legal_name: string | null;
      rep_llc_legal_name: string | null;
      a: string;
      c: string;
    }>(
      db,
      `select rep_legal_name, rep_llc_legal_name, split_agent_pct::text as a,
              split_company_pct::text as c from pre_apps where id = ${id}`,
    );
    return row;
  }

  it("copies the rep's legal names and split rate onto the pre-app", async () => {
    await makeSubmittable(db, draftId);
    await asUser(db, ADMIN_ID);
    await db.exec(`select set_rep_split('${AGENT_ID}', 46.5)`);
    await db.exec(`select set_rep_identity('${AGENT_ID}', 'Ann Ito', 'Ito Payments LLC')`);
    expect(await snapshot(draftId)).toEqual({
      rep_legal_name: null, rep_llc_legal_name: null, a: "50.00", c: "50.00",
    });

    await asUser(db, AGENT_ID);
    await db.exec(`select submit_pre_app(${draftId})`);
    expect(await snapshot(draftId)).toEqual({
      rep_legal_name: "Ann Ito", rep_llc_legal_name: "Ito Payments LLC", a: "46.50", c: "53.50",
    });
  });

  it("copies the house profile's 0 as Rep 0 / Company 100", async () => {
    await makeSubmittable(db, draftId);
    await asUser(db, ADMIN_ID);
    await db.exec(`select set_rep_split('${AGENT_ID}', 0)`);
    await asUser(db, AGENT_ID);
    await db.exec(`select submit_pre_app(${draftId})`);
    const row = await snapshot(draftId);
    expect([row.a, row.c]).toEqual(["0.00", "100.00"]);
  });

  it("A16: a rep with no LLC has their own legal name in the LLC field, and it is copied", async () => {
    // The admin enters the rep's own legal name as the LLC legal name (memo
    // A16); submit copies it like any other.
    await makeSubmittable(db, draftId);
    await asUser(db, ADMIN_ID);
    await db.exec(`select set_rep_identity('${AGENT_ID}', 'Ann Ito', 'Ann Ito')`);
    await asUser(db, AGENT_ID);
    await db.exec(`select submit_pre_app(${draftId})`);
    const row = await snapshot(draftId);
    expect([row.rep_legal_name, row.rep_llc_legal_name]).toEqual(["Ann Ito", "Ann Ito"]);
  });

  it("is a snapshot: later profile changes move neither the pre-app nor the merchant", async () => {
    await makeSubmittable(db, draftId);
    await asUser(db, ADMIN_ID);
    await db.exec(`select set_rep_split('${AGENT_ID}', 40)`);
    await db.exec(`select set_rep_identity('${AGENT_ID}', 'Ann Ito', 'Ito Payments LLC')`);
    await asUser(db, AGENT_ID);
    await db.exec(`select submit_pre_app(${draftId})`);
    await asUser(db, ADMIN_ID);
    const [{ m }] = await rows<{ m: number }>(db, `select approve_pre_app(${draftId}) as m`);

    await db.exec(`select set_rep_split('${AGENT_ID}', 30)`);
    await db.exec(`select set_rep_identity('${AGENT_ID}', 'Ann Ito-Lee', 'Ito Lee LLC')`);

    expect(await snapshot(draftId)).toEqual({
      rep_legal_name: "Ann Ito", rep_llc_legal_name: "Ito Payments LLC", a: "40.00", c: "60.00",
    });
    await asPlatform(db);
    const [merchant] = await rows<{ a: string; c: string }>(
      db,
      `select split_agent_pct::text as a, split_company_pct::text as c from merchants where id = ${m}`,
    );
    expect(merchant).toEqual({ a: "40.00", c: "60.00" });
  });

  it("re-snapshots on the next submit after a reopen", async () => {
    await makeSubmittable(db, draftId);
    await asUser(db, AGENT_ID);
    await db.exec(`select submit_pre_app(${draftId})`);
    await asUser(db, ADMIN_ID);
    await db.exec(`select decline_pre_app(${draftId}, 'fix the address')`);
    await asUser(db, AGENT_ID);
    await db.exec(`select reopen_pre_app(${draftId})`);
    await asUser(db, ADMIN_ID);
    await db.exec(`select set_rep_split('${AGENT_ID}', 35)`);
    await asUser(db, AGENT_ID);
    await db.exec(`select submit_pre_app(${draftId})`);
    expect((await snapshot(draftId)).a).toBe("35.00");
  });
});

describe("no client writes the split, the rep's names, or the country", () => {
  for (const [column, value] of [
    ["split_agent_pct", "40"],
    ["rep_legal_name", "'Someone'"],
    ["rep_llc_legal_name", "'Someone LLC'"],
  ] as const) {
    it(`refuses a rep's update of ${column} on their own draft`, async () => {
      await asUser(db, AGENT_ID);
      const error = await failure(
        `update pre_apps set ${column} = ${value}${column === "split_agent_pct" ? ", split_company_pct = 60" : ""}
          where id = ${draftId}`,
      );
      expect(error?.message).toMatch(/set by submit_pre_app\(\) from the rep's profile/);
    });

    it(`refuses an admin's update of ${column} on a submitted pre-app`, async () => {
      await asUser(db, ADMIN_ID);
      const error = await failure(
        `update pre_apps set ${column} = ${value}${column === "split_agent_pct" ? ", split_company_pct = 60" : ""}
          where id = ${submittedId}`,
      );
      expect(error?.message).toMatch(/set by submit_pre_app\(\) from the rep's profile/);
    });
  }

  it("refuses an insert that pre-loads the split or the names", async () => {
    await asUser(db, AGENT_ID);
    for (const extra of [
      ["split_agent_pct, split_company_pct", "40, 60"],
      ["rep_legal_name", "'Someone'"],
      ["rep_llc_legal_name", "'Someone LLC'"],
    ]) {
      const error = await failure(
        `insert into pre_apps (agent_id, dba_name, legal_business_name, ${extra[0]})
         values ('${AGENT_ID}', 'Preloaded', 'Preloaded LLC', ${extra[1]})`,
      );
      expect(error?.message).toMatch(/set by submit_pre_app\(\)/);
    }
  });

  it("still lets a rep edit every other field of their draft", async () => {
    await asUser(db, AGENT_ID);
    await db.exec(`update pre_apps set bank_name = 'Second Bank' where id = ${draftId}`);
    await asPlatform(db);
    const [row] = await rows<{ b: string }>(db, `select bank_name as b from pre_apps where id = ${draftId}`);
    expect(row.b).toBe("Second Bank");
  });

  it("pre_apps_split_agent_pct_range refuses a split over 50, even on the state machine's path", async () => {
    await asPlatform(db);
    await db.exec(`select set_config('tapswipe.pre_app_transition', 'on', false)`);
    try {
      const error = await failure(
        `update pre_apps set split_agent_pct = 50.01, split_company_pct = 49.99 where id = ${draftId}`,
      );
      expect(error?.message).toMatch(/pre_apps_split_agent_pct_range/);
    } finally {
      await db.exec(`select set_config('tapswipe.pre_app_transition', '', false)`);
    }
  });

  it("country defaults to US and holds nothing else, on the pre-app and every owner", async () => {
    await asUser(db, AGENT_ID);
    await db.exec(`insert into pre_apps (agent_id, dba_name, legal_business_name) values ('${AGENT_ID}', 'New Co', 'New Co LLC')`);
    await asPlatform(db);
    const [row] = await rows<{ country: string }>(db, `select country from pre_apps where dba_name = 'New Co'`);
    expect(row.country).toBe("US");

    await asUser(db, AGENT_ID);
    expect((await failure(`update pre_apps set country = 'CA' where id = ${draftId}`))?.message).toMatch(
      /pre_apps_country_us/,
    );
    expect((await failure(`update pre_apps set country = null where id = ${draftId}`))?.message).toMatch(
      /null value/,
    );
    expect(
      (await failure(`update pre_app_owners set home_country = 'Canada' where pre_app_id = ${draftId}`))?.message,
    ).toMatch(/pre_app_owners_home_country_us/);
    await asPlatform(db);
    const owners = await rows<{ c: string }>(db, `select distinct home_country as c from pre_app_owners`);
    expect(owners).toEqual([{ c: "US" }]);
  });
});

describe("pre_app_missing_fields itself", () => {
  it("is not an id oracle: not-yours and not-found raise the identical error", async () => {
    await asUser(db, AGENT_ID);
    const notYours = await failure(`select pre_app_missing_fields(${otherDraftId})`);
    const missing = await failure(`select pre_app_missing_fields(999999)`);
    expect(notYours?.code).toBe("PT404");
    expect(notYours?.message).toBe(missing?.message);
    expect(notYours?.code).toBe(missing?.code);
  });

  it("refuses a deactivated owner", async () => {
    await asPlatform(db);
    await db.exec(`update profiles set is_active = false where id = '${AGENT_ID}'`);
    await asUser(db, AGENT_ID);
    const error = await failure(`select pre_app_missing_fields(${draftId})`);
    expect(error?.code).toBe("PT403");
  });

  it("names no *_encrypted column, and is security definer with a pinned search_path", async () => {
    await asPlatform(db);
    const [row] = await rows<{ def: string; prosecdef: boolean; proconfig: string[] }>(
      db,
      `select pg_get_functiondef(p.oid) as def, p.prosecdef, p.proconfig
         from pg_proc p where p.oid = 'public.pre_app_missing_fields(int)'::regprocedure`,
    );
    expect(row.def).toMatch(/pre_app_tax_secrets/);
    expect(row.def).not.toMatch(/_encrypted/);
    expect(row.prosecdef).toBe(true);
    expect(row.proconfig).toEqual(["search_path=public, pg_temp"]);
  });

  it("is executable by authenticated and service_role, never anon or PUBLIC", async () => {
    await asPlatform(db);
    const sig = "public.pre_app_missing_fields(int)";
    const [row] = await rows<{ anon: boolean; auth: boolean; svc: boolean; pub: boolean }>(
      db,
      `select has_function_privilege('anon', '${sig}', 'execute') as anon,
              has_function_privilege('authenticated', '${sig}', 'execute') as auth,
              has_function_privilege('service_role', '${sig}', 'execute') as svc,
              exists (select 1 from pg_proc p, aclexplode(p.proacl) a
                       where p.oid = '${sig}'::regprocedure and a.grantee = 0) as pub`,
    );
    expect(row).toEqual({ anon: false, auth: true, svc: true, pub: false });
  });

  it("submit_pre_app delegates to it: the old hand-written rules are gone from its body", async () => {
    await asPlatform(db);
    const [row] = await rows<{ def: string }>(
      db,
      `select pg_get_functiondef('public.submit_pre_app(int)'::regprocedure) as def`,
    );
    expect(row.def).toMatch(/pre_app_missing_fields\(pa\.id\)/);
    expect(row.def).not.toMatch(/pre_app_owner_secrets|pre_app_banking_secrets|pre_app_tax_secrets/);
    expect(row.def).not.toMatch(/_encrypted/);
  });
});
