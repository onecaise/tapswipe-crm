import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  ADMIN_ID,
  AGENT_ID,
  OTHER_AGENT_ID,
  asPlatform,
  asUser,
  createTestDb,
  readMigration,
  rows,
  seed,
  type TestDb,
} from "../helpers/db";

/**
 * record_pre_app_secret_reveal() (20261028140000; phase 5 of
 * docs/design/intake-and-reports.md, §1.E and A24): the audit row and the rate
 * limit behind an admin's per-field Show.
 *
 * read-pre-app-secrets decrypts a full value only after this function has
 * returned, so what is pinned here is what the reveal path rests on: admin
 * only, one row per call naming the admin / pre-app / field, fails closed, and
 * 30 per admin per rolling hour. The Edge Function's side (status codes, no
 * value in a refused body) is tests/live/pre-app-secrets.test.ts.
 */

const MIGRATION = "20261028140000_pre_app_secret_reveal.sql";
const LIMIT = 30;
const SECOND_ADMIN = "44444444-4444-4444-4444-444444444444";

type Outcome = { ok: true } | { ok: false; code: string; message: string };

let db: TestDb;
let agentApp: number;
let otherApp: number;
let adaOwner: number;
let ozzyOwner: number;

async function call(
  caller: string | null,
  preAppId: number,
  field: string | null,
  ownerId: number | null = null,
): Promise<Outcome> {
  await asUser(db, caller);
  try {
    await db.query(
      `select record_pre_app_secret_reveal($1, $2, $3)`,
      [preAppId, field, ownerId],
    );
    return { ok: true };
  } catch (e) {
    const err = e as { code?: string; message?: string };
    return { ok: false, code: err.code ?? "", message: err.message ?? String(e) };
  } finally {
    await asPlatform(db);
  }
}

async function reveals(actor?: string) {
  await asPlatform(db);
  return rows<{ actor_id: string; action: string; table_name: string; row_id: string; created_at: string }>(
    db,
    `select actor_id, action, table_name, row_id, created_at::text from audit_log
      where action like 'read_pre_app_secrets:reveal:%' ${actor ? `and actor_id = '${actor}'` : ""}
      order by id`,
  );
}

beforeAll(async () => {
  db = await createTestDb();
  await seed(db);
  await asPlatform(db);
  await db.exec(`
    insert into auth.users (id, email) values ('${SECOND_ADMIN}', 'admin2@tapswipe.test');
    insert into profiles (id, full_name, role, is_active) values ('${SECOND_ADMIN}', 'Second Admin', 'admin', true);
  `);
  const [ids] = await rows<{ a: number; o: number; ada: number; ozzy: number }>(
    db,
    `select (select id from pre_apps where dba_name = 'Agent Draft App') as a,
            (select id from pre_apps where dba_name = 'Other Draft App') as o,
            (select id from pre_app_owners where owner_name = 'Ada Owner') as ada,
            (select id from pre_app_owners where owner_name = 'Ozzy Other') as ozzy`,
  );
  agentApp = ids.a;
  otherApp = ids.o;
  adaOwner = ids.ada;
  ozzyOwner = ids.ozzy;
}, 120_000);

beforeEach(async () => {
  await asPlatform(db);
  await db.exec(`
    delete from audit_log where action like 'read_pre_app_secrets:%';
    update profiles set is_active = true, role = 'admin' where id in ('${ADMIN_ID}', '${SECOND_ADMIN}');
  `);
});

afterAll(async () => {
  await db?.close();
});

describe("the function", () => {
  it("is volatile, definer, search_path public, pg_temp, and serialises one admin", async () => {
    const [f] = await rows<{ provolatile: string; prosecdef: boolean; proconfig: string[]; src: string; args: string }>(
      db,
      `select provolatile, prosecdef, proconfig, prosrc as src,
              pg_get_function_identity_arguments(oid) as args
         from pg_proc where proname = 'record_pre_app_secret_reveal'`,
    );
    expect(f.args).toBe("pre_app_id_input integer, field_input text, pre_app_owner_id_input integer");
    expect(f.provolatile).toBe("v");
    expect(f.prosecdef).toBe(true);
    expect(f.proconfig).toEqual(["search_path=public, pg_temp"]);
    expect(f.src).toMatch(
      /pg_advisory_xact_lock\(hashtextextended\('reveal_pre_app_secret:' \|\| auth\.uid\(\)::text, 0\)\)/,
    );
  });

  it("checks is_admin() before anything else", async () => {
    const [{ src }] = await rows<{ src: string }>(
      db,
      `select prosrc as src from pg_proc where proname = 'record_pre_app_secret_reveal'`,
    );
    const body = src.replace(/^\s*declare[\s\S]*?\bbegin\b/i, "").trim();
    expect(body.startsWith("if not is_admin() then")).toBe(true);
  });

  it("fails closed: no exception handler anywhere in the body", async () => {
    const [{ src }] = await rows<{ src: string }>(
      db,
      `select prosrc as src from pg_proc where proname = 'record_pre_app_secret_reveal'`,
    );
    expect(src).not.toMatch(/\bexception\s+when\b/i);
  });

  it("names no *_secrets table and no ciphertext column: it cannot read a secret", async () => {
    const [{ def }] = await rows<{ def: string }>(
      db,
      `select pg_get_functiondef('public.record_pre_app_secret_reveal(int, text, int)'::regprocedure) as def`,
    );
    // The four tables by name: the action text 'read_pre_app_secrets:…' is
    // in the body, and is not a table.
    expect(def).not.toMatch(/pre_app_(owner|banking|terminal|tax)_secrets/);
    expect(def).not.toMatch(/_encrypted\b/);
  });

  it("is executable by authenticated and service_role only, never anon or PUBLIC", async () => {
    const [r] = await rows<{ anon: boolean; authn: boolean; svc: boolean; acl: string }>(
      db,
      `select has_function_privilege('anon', 'public.record_pre_app_secret_reveal(int, text, int)', 'execute') as anon,
              has_function_privilege('authenticated', 'public.record_pre_app_secret_reveal(int, text, int)', 'execute') as authn,
              has_function_privilege('service_role', 'public.record_pre_app_secret_reveal(int, text, int)', 'execute') as svc,
              (select proacl::text from pg_proc where proname = 'record_pre_app_secret_reveal') as acl`,
    );
    expect(r.anon).toBe(false);
    expect(r.authn).toBe(true);
    expect(r.svc).toBe(true);
    expect(r.acl).not.toMatch(/(^|[{,])=X/);
  });

  it("has the partial index the count uses", async () => {
    const r = await rows<{ def: string }>(
      db,
      `select indexdef as def from pg_indexes where indexname = 'audit_log_secret_reveal_idx'`,
    );
    expect(r).toHaveLength(1);
    expect(r[0].def).toMatch(/\(actor_id, created_at\) WHERE \(action ~~ 'read_pre_app_secrets:reveal:%'::text\)/);
  });

  it("revokes from PUBLIC in the migration text itself", async () => {
    const sql = await readMigration(MIGRATION);
    expect(sql).toContain("revoke all on function record_pre_app_secret_reveal(int, text, int) from public;");
    expect(sql).toContain(
      "grant execute on function record_pre_app_secret_reveal(int, text, int) to authenticated, service_role;",
    );
  });
});

describe("one audit row per reveal, naming admin, pre-app, field and time", () => {
  it.each([
    ["tax_id", null, "read_pre_app_secrets:reveal:tax_id"],
    ["aba_routing", null, "read_pre_app_secrets:reveal:aba_routing"],
    ["account_number", null, "read_pre_app_secrets:reveal:account_number"],
    ["rp_password", null, "read_pre_app_secrets:reveal:rp_password"],
  ])("%s", async (field, _owner, action) => {
    expect(await call(ADMIN_ID, agentApp, field)).toEqual({ ok: true });
    const r = await reveals();
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ actor_id: ADMIN_ID, action, table_name: "pre_apps", row_id: String(agentApp) });
    expect(r[0].created_at).toBeTruthy();
  });

  it("an owner SSN names the owner too", async () => {
    expect(await call(ADMIN_ID, agentApp, "owner_ssn", adaOwner)).toEqual({ ok: true });
    expect((await reveals()).map((r) => r.action)).toEqual([`read_pre_app_secrets:reveal:owner_ssn:${adaOwner}`]);
  });

  it("works on any rep's pre-app for an admin, and two calls are two rows", async () => {
    await call(ADMIN_ID, otherApp, "tax_id");
    await call(ADMIN_ID, otherApp, "tax_id");
    expect((await reveals()).map((r) => r.row_id)).toEqual([String(otherApp), String(otherApp)]);
  });
});

describe("refusals write nothing", () => {
  it("refuses the owning rep (PT403)", async () => {
    const out = await call(AGENT_ID, agentApp, "tax_id");
    expect(out).toMatchObject({ ok: false, code: "PT403", message: "Only an admin can reveal a full value." });
    expect(await reveals()).toEqual([]);
  });

  it("refuses another rep and a signed-out caller the same way", async () => {
    expect(await call(OTHER_AGENT_ID, agentApp, "tax_id")).toMatchObject({ ok: false, code: "PT403" });
    expect(await call(null, agentApp, "tax_id")).toMatchObject({ ok: false, code: "PT403" });
    expect(await reveals()).toEqual([]);
  });

  it("refuses a deactivated admin", async () => {
    await db.exec(`update profiles set is_active = false where id = '${ADMIN_ID}'`);
    expect(await call(ADMIN_ID, agentApp, "tax_id")).toMatchObject({ ok: false, code: "PT403" });
    expect(await reveals()).toEqual([]);
  });

  it.each([
    ["an unknown field", "ssn", null],
    ["a null field", null, null],
    ["an owner SSN without an owner", "owner_ssn", null],
    ["an owner on a pre-app field", "tax_id", 1],
  ])("refuses %s (22023)", async (_label, field, owner) => {
    const out = await call(ADMIN_ID, agentApp, field, owner === 1 ? adaOwner : null);
    expect(out).toMatchObject({ ok: false, code: "22023" });
    expect(await reveals()).toEqual([]);
  });

  it("refuses a missing pre-app, and an owner from another pre-app (PT404)", async () => {
    expect(await call(ADMIN_ID, 987654, "tax_id")).toMatchObject({ ok: false, code: "PT404" });
    expect(await call(ADMIN_ID, agentApp, "owner_ssn", ozzyOwner)).toMatchObject({ ok: false, code: "PT404" });
    expect(await reveals()).toEqual([]);
  });
});

describe("the audit row is the gate: if it cannot be written, the call fails", () => {
  it("raises when the audit insert fails, so the Edge Function decrypts nothing", async () => {
    await db.exec(`
      create function zz_fail_audit() returns trigger language plpgsql as $$
      begin raise exception 'audit store unavailable'; end $$;
      create trigger zz_fail_audit before insert on audit_log
        for each row execute function zz_fail_audit();
    `);
    try {
      const out = await call(ADMIN_ID, agentApp, "tax_id");
      expect(out).toMatchObject({ ok: false, message: "audit store unavailable" });
    } finally {
      await db.exec(`drop trigger zz_fail_audit on audit_log; drop function zz_fail_audit();`);
    }
    expect(await reveals()).toEqual([]);
  });
});

describe("rate limit: 30 per admin per rolling hour", () => {
  async function fill(actor: string, n: number, ago = "0 minutes") {
    await asPlatform(db);
    await db.exec(`
      insert into audit_log (actor_id, action, table_name, row_id, created_at)
      select '${actor}', 'read_pre_app_secrets:reveal:tax_id', 'pre_apps', '${agentApp}', now() - interval '${ago}'
        from generate_series(1, ${n});
    `);
  }

  it(`allows the ${LIMIT}th and refuses the ${LIMIT + 1}st with PT429 and a showable sentence`, async () => {
    for (let i = 0; i < LIMIT; i++) {
      expect(await call(ADMIN_ID, agentApp, "aba_routing"), `call ${i + 1}`).toEqual({ ok: true });
    }
    const over = await call(ADMIN_ID, agentApp, "aba_routing");
    expect(over).toMatchObject({ ok: false, code: "PT429" });
    expect((over as { message: string }).message).toMatch(
      /^You have reached the limit of 30 reveals an hour\. Try again in \d+ minutes?\.$/,
    );
    expect(await reveals(ADMIN_ID)).toHaveLength(LIMIT);
  }, 60_000);

  it("counts only the last hour", async () => {
    await fill(ADMIN_ID, 40, "61 minutes");
    await fill(ADMIN_ID, LIMIT - 1);
    expect(await call(ADMIN_ID, agentApp, "tax_id")).toEqual({ ok: true });
    expect(await call(ADMIN_ID, agentApp, "tax_id")).toMatchObject({ ok: false, code: "PT429" });
  });

  it("is per admin: one admin at the limit does not stop another", async () => {
    await fill(ADMIN_ID, LIMIT);
    expect(await call(ADMIN_ID, agentApp, "tax_id")).toMatchObject({ ok: false, code: "PT429" });
    expect(await call(SECOND_ADMIN, agentApp, "tax_id")).toEqual({ ok: true });
  });

  it("does not count default (masked) reads or other audit rows", async () => {
    await asPlatform(db);
    await db.exec(`
      insert into audit_log (actor_id, action, table_name, row_id)
      select '${ADMIN_ID}', 'read_pre_app_secrets:last4', 'pre_apps', '${agentApp}' from generate_series(1, 50);
    `);
    expect(await call(ADMIN_ID, agentApp, "tax_id")).toEqual({ ok: true });
  });

  it("says one minute, singular, when the oldest reveal is about to age out", async () => {
    await fill(ADMIN_ID, 1, "59 minutes 30 seconds");
    await fill(ADMIN_ID, LIMIT - 1);
    const over = await call(ADMIN_ID, agentApp, "tax_id");
    expect((over as { message: string }).message).toBe(
      "You have reached the limit of 30 reveals an hour. Try again in 1 minute.",
    );
  });
});
