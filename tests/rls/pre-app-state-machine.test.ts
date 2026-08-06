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
 * The pre-app state machine: the guard trigger plus submit / approve /
 * decline / reopen.
 *
 * The guard trigger is tested in BOTH directions on purpose. A suite that only
 * proves a direct PATCH is refused would pass just as happily against a
 * trigger that also broke the RPCs — which is the more likely bug, since
 * `security definer` does not change what auth.uid() returns and so a
 * role-based guard would block an agent's own submit_pre_app while letting an
 * admin's approve_pre_app through.
 */

type CountRow = { n: number };

let db: TestDb;
let draftId: number;
let submittedId: number;
let otherDraftId: number;

/** Everything submit_pre_app demands, so individual tests can remove one rule. */
async function makeSubmittable(id: number): Promise<void> {
  await asPlatform(db);
  await db.exec(`
    delete from pre_app_owners where pre_app_id = ${id};
    insert into pre_app_owners (pre_app_id, owner_name, percent_owned)
    values (${id}, 'Control Owner', 100.00);
  `);
  await db.exec(`
    insert into pre_app_owner_secrets (pre_app_owner_id, ssn_encrypted)
    values ((select id from pre_app_owners where pre_app_id = ${id}), decode('0011','hex'));
  `);
  await db.exec(`
    insert into pre_app_banking_secrets (pre_app_id, aba_routing_encrypted, account_number_encrypted)
    values (${id}, decode('0022','hex'), decode('0033','hex'))
    on conflict (pre_app_id) do nothing;
  `);
  await db.exec(`
    delete from pre_app_business_profile where pre_app_id = ${id};
    insert into pre_app_business_profile
      (pre_app_id, card_swiped_pct, card_keyed_pct, card_present_pct, card_not_present_pct)
    values (${id}, 60.00, 40.00, 70.00, 30.00);
  `);
}

async function statusOf(id: number): Promise<string> {
  await asPlatform(db);
  const r = await rows<{ status: string }>(
    db,
    `select status from pre_apps where id = ${id}`,
  );
  return r[0].status;
}

async function call(sql: string): Promise<unknown> {
  const r = await rows<{ r: unknown }>(db, `select ${sql} as r`);
  return r[0].r;
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

describe("the guard trigger refuses direct status writes", () => {
  it("refuses an agent PATCHing status on their own draft", async () => {
    await asUser(db, AGENT_ID);

    await expect(
      db.exec(`update pre_apps set status = 'approved' where id = ${draftId}`),
    ).rejects.toThrow(/status changes only through/i);

    expect(await statusOf(draftId)).toBe("draft");
  });

  it("refuses an agent PATCHing date_submitted", async () => {
    await asUser(db, AGENT_ID);

    await expect(
      db.exec(
        `update pre_apps set date_submitted = current_date where id = ${draftId}`,
      ),
    ).rejects.toThrow(/date_submitted is set by/i);
  });

  it("refuses an ADMIN PATCHing status directly, and creates no merchant", async () => {
    // Deliberately not exempt. With an is_admin() early return an admin could
    // reach 'approved' with no merchants row and no audit_log entry — a
    // data-integrity hole, not just an authorization one.
    await asUser(db, ADMIN_ID);

    await expect(
      db.exec(`update pre_apps set status = 'approved' where id = ${submittedId}`),
    ).rejects.toThrow(/status changes only through/i);

    await asPlatform(db);
    const merchants = await rows<CountRow>(
      db,
      `select count(*)::int as n from merchants where dba = 'Agent Submitted App'`,
    );
    expect(merchants[0].n).toBe(0);
  });

  it("still allows an agent to edit other columns on their own draft", async () => {
    // The trigger must not turn into a blanket freeze — autosave depends on
    // ordinary column writes continuing to work.
    await asUser(db, AGENT_ID);

    await db.exec(`update pre_apps set city = 'Nashville' where id = ${draftId}`);

    await asPlatform(db);
    const r = await rows<{ city: string }>(
      db,
      `select city from pre_apps where id = ${draftId}`,
    );
    expect(r[0].city).toBe("Nashville");
  });

  it("freezes a submitted pre-app against its own agent", async () => {
    await asUser(db, AGENT_ID);

    await expect(
      db.exec(`update pre_apps set city = 'Nope' where id = ${submittedId}`),
    ).rejects.toThrow(/can only be edited by an admin/i);
  });

  it("lets an admin edit a submitted pre-app's other columns", async () => {
    await asUser(db, ADMIN_ID);

    await db.exec(`update pre_apps set city = 'Memphis' where id = ${submittedId}`);

    await asPlatform(db);
    const r = await rows<{ city: string }>(
      db,
      `select city from pre_apps where id = ${submittedId}`,
    );
    expect(r[0].city).toBe("Memphis");
  });
});

describe("submit_pre_app succeeds under the guard trigger", () => {
  // The positive half. Without these the trigger tests above would pass
  // against a guard that blocked everything, including the RPCs.
  it("lets the owning agent submit a complete draft", async () => {
    await makeSubmittable(draftId);
    await asUser(db, AGENT_ID);

    expect(await call(`submit_pre_app(${draftId})`)).toBe(draftId);

    await asPlatform(db);
    const r = await rows<{ status: string; date_submitted: string | null }>(
      db,
      `select status, date_submitted::text from pre_apps where id = ${draftId}`,
    );
    expect(r[0].status).toBe("submitted");
    expect(r[0].date_submitted).not.toBeNull();
  });

  it("writes an audit_log row attributed to the submitter", async () => {
    await makeSubmittable(draftId);
    await asUser(db, AGENT_ID);
    await call(`submit_pre_app(${draftId})`);

    await asPlatform(db);
    const r = await rows<{ actor_id: string; row_id: string }>(
      db,
      `select actor_id, row_id from audit_log where action = 'submit_pre_app'`,
    );
    expect(r).toHaveLength(1);
    expect(r[0].actor_id).toBe(AGENT_ID);
    expect(r[0].row_id).toBe(String(draftId));
  });

  it("does not leave the transition flag set behind it", async () => {
    // The flag is transaction-local, not statement-local, so the RPC clearing
    // it is what stops it covering a later statement in the same transaction.
    await makeSubmittable(draftId);
    await asUser(db, AGENT_ID);
    await call(`submit_pre_app(${draftId})`);

    await expect(
      db.exec(`update pre_apps set status = 'approved' where id = ${draftId}`),
    ).rejects.toThrow(/status changes only through/i);
  });

  it("lets an admin submit on a rep's behalf without taking the row", async () => {
    await makeSubmittable(draftId);
    await asUser(db, ADMIN_ID);

    await call(`submit_pre_app(${draftId})`);

    await asPlatform(db);
    const r = await rows<{ agent_id: string }>(
      db,
      `select agent_id from pre_apps where id = ${draftId}`,
    );
    expect(r[0].agent_id).toBe(AGENT_ID);
  });
});

describe("submit_pre_app validation", () => {
  it("refuses a pre-app that is not a draft", async () => {
    await makeSubmittable(submittedId);
    await asUser(db, AGENT_ID);

    await expect(call(`submit_pre_app(${submittedId})`)).rejects.toThrow(
      /not a draft/i,
    );
  });

  it("refuses when no owner holds at least 51%", async () => {
    await makeSubmittable(draftId);
    await asPlatform(db);
    await db.exec(
      `update pre_app_owners set percent_owned = 50 where pre_app_id = ${draftId}`,
    );

    await asUser(db, AGENT_ID);
    await expect(call(`submit_pre_app(${draftId})`)).rejects.toThrow(
      /at least 51% ownership/i,
    );
  });

  it("refuses when there are no owners at all", async () => {
    await makeSubmittable(draftId);
    await asPlatform(db);
    await db.exec(`delete from pre_app_owners where pre_app_id = ${draftId}`);

    await asUser(db, AGENT_ID);
    await expect(call(`submit_pre_app(${draftId})`)).rejects.toThrow(
      /at least one owner is required/i,
    );
  });

  it("refuses when an owner has no SSN on file", async () => {
    await makeSubmittable(draftId);
    await asPlatform(db);
    await db.exec(`delete from pre_app_owner_secrets`);

    await asUser(db, AGENT_ID);
    await expect(call(`submit_pre_app(${draftId})`)).rejects.toThrow(
      /SSN on file/i,
    );
  });

  it("refuses when banking details have not been submitted", async () => {
    await makeSubmittable(draftId);
    await asPlatform(db);
    await db.exec(`delete from pre_app_banking_secrets`);

    await asUser(db, AGENT_ID);
    await expect(call(`submit_pre_app(${draftId})`)).rejects.toThrow(
      /banking details/i,
    );
  });

  it("does NOT require terminal secrets", async () => {
    // Whether an RP password is ever mandatory is an open question; requiring
    // one would block every deal that has no terminal.
    await makeSubmittable(draftId);
    await asUser(db, AGENT_ID);

    await expect(call(`submit_pre_app(${draftId})`)).resolves.toBe(draftId);
  });

  it("refuses when swiped and keyed do not total 100", async () => {
    await makeSubmittable(draftId);
    await asPlatform(db);
    await db.exec(
      `update pre_app_business_profile set card_swiped_pct = 80, card_keyed_pct = 10
       where pre_app_id = ${draftId}`,
    );

    await asUser(db, AGENT_ID);
    await expect(call(`submit_pre_app(${draftId})`)).rejects.toThrow(
      /swiped and keyed/i,
    );
  });

  it("refuses when card-present and not-present do not total 100", async () => {
    await makeSubmittable(draftId);
    await asPlatform(db);
    await db.exec(
      `update pre_app_business_profile set card_present_pct = 50, card_not_present_pct = 20
       where pre_app_id = ${draftId}`,
    );

    await asUser(db, AGENT_ID);
    await expect(call(`submit_pre_app(${draftId})`)).rejects.toThrow(
      /card-present and card-not-present/i,
    );
  });

  it("ignores moto and internet entirely", async () => {
    // Settled rule: two independent pairs only. moto/internet are captured
    // and displayed, never constrained, and specifically not summed against
    // card_not_present_pct.
    await makeSubmittable(draftId);
    await asPlatform(db);
    await db.exec(
      `update pre_app_business_profile set moto_pct = 99, internet_pct = 99
       where pre_app_id = ${draftId}`,
    );

    await asUser(db, AGENT_ID);
    await expect(call(`submit_pre_app(${draftId})`)).resolves.toBe(draftId);
  });

  it("submits when one card-mix pair is filled and the other is empty", async () => {
    await makeSubmittable(draftId);
    await asPlatform(db);
    await db.exec(
      `update pre_app_business_profile
          set card_present_pct = null, card_not_present_pct = null
        where pre_app_id = ${draftId}`,
    );

    await asUser(db, AGENT_ID);
    await expect(call(`submit_pre_app(${draftId})`)).resolves.toBe(draftId);
  });

  it("submits when there is no business profile row at all", async () => {
    await makeSubmittable(draftId);
    await asPlatform(db);
    await db.exec(`delete from pre_app_business_profile where pre_app_id = ${draftId}`);

    await asUser(db, AGENT_ID);
    await expect(call(`submit_pre_app(${draftId})`)).resolves.toBe(draftId);
  });
});

describe("submit_pre_app is not an id oracle", () => {
  it("gives another agent's pre-app and a nonexistent id the same message", async () => {
    // The property is that the two are indistinguishable. Asserting each
    // matches /not found/ separately would pass while still leaking, because
    // the messages could differ in detail.
    await asUser(db, AGENT_ID);

    const notYours = await call(`submit_pre_app(${otherDraftId})`).then(
      () => "resolved",
      (e: Error) => e.message,
    );
    const missing = await call(`submit_pre_app(987654)`).then(
      () => "resolved",
      (e: Error) => e.message,
    );

    expect(notYours).toBe(missing);
    expect(notYours).toMatch(/not found/i);
  });

  it("tells a deactivated OWNER that their account is off", async () => {
    // Not a disclosure: they already know they own it.
    await makeSubmittable(draftId);
    await asPlatform(db);
    await db.exec(`update profiles set is_active = false where id = '${AGENT_ID}'`);

    await asUser(db, AGENT_ID);
    await expect(call(`submit_pre_app(${draftId})`)).rejects.toThrow(
      /deactivated/i,
    );
  });
});

describe("submit_pre_app never reads ciphertext", () => {
  it("references the secrets table but no *_encrypted column", async () => {
    // The definer exception is only defensible while this holds, so it is
    // pinned rather than promised.
    await asPlatform(db);
    const r = await rows<{ def: string }>(
      db,
      `select pg_get_functiondef('submit_pre_app(int)'::regprocedure) as def`,
    );

    // Comments are stripped first: the body carries a comment explaining that
    // it never names a ciphertext column, and that sentence would otherwise
    // fail the very assertion it describes.
    const code = r[0].def
      .split("\n")
      .map((line) => line.replace(/--.*$/, ""))
      .join("\n");

    expect(code).toMatch(/pre_app_banking_secrets/);
    expect(code).not.toMatch(/_encrypted/);
  });

  it("pins search_path on every state-machine function", async () => {
    await asPlatform(db);
    const r = await rows<{ proname: string; proconfig: string[] | null }>(
      db,
      `select proname, proconfig from pg_proc
        where proname in ('submit_pre_app','approve_pre_app','decline_pre_app',
                          'reopen_pre_app','pre_apps_guard_transitions')
        order by proname`,
    );

    expect(r).toHaveLength(5);
    for (const fn of r) {
      expect(fn.proconfig, `${fn.proname} must pin search_path`).toContain(
        "search_path=public",
      );
    }
  });
});

describe("approve_pre_app succeeds under the guard trigger", () => {
  it("creates the merchant with the split and the rep's agent_id", async () => {
    // Drives the whole real path — set the split as the rep while it is still
    // a draft, submit through the RPC, then approve. Setting it directly on the
    // already-submitted fixture is not possible: the trigger fires for the
    // table OWNER too, and an owner connection has no auth.uid(), so
    // is_admin() is false and the "non-draft rows are frozen" rule applies.
    await makeSubmittable(draftId);
    await asUser(db, AGENT_ID);
    await db.exec(
      `update pre_apps set split_agent_pct = 100, split_company_pct = 0
       where id = ${draftId}`,
    );
    await call(`submit_pre_app(${draftId})`);

    await asUser(db, ADMIN_ID);
    const merchantId = await call(`approve_pre_app(${draftId})`);

    await asPlatform(db);
    const m = await rows<{
      agent_id: string;
      dba: string;
      a: string;
      c: string;
    }>(
      db,
      `select agent_id, dba, split_agent_pct::text as a, split_company_pct::text as c
         from merchants where id = ${merchantId}`,
    );
    expect(m[0].agent_id).toBe(AGENT_ID);
    expect(m[0].dba).toBe("Agent Draft App");
    expect(m[0].a).toBe("100.00");
    expect(m[0].c).toBe("0.00");
    expect(await statusOf(draftId)).toBe("approved");
  });

  it("applies the guard to the table owner as well, not just client roles", async () => {
    // Worth pinning: a service-role Edge Function connection has no
    // auth.uid(), so is_admin() is false there too. Any future privileged code
    // that needs to move a status has to go through these RPCs rather than
    // UPDATE the column, which is the intent — it keeps the audit_log write and
    // the merchant creation on the only path that exists.
    await asPlatform(db);

    await expect(
      db.exec(`update pre_apps set status = 'approved' where id = ${submittedId}`),
    ).rejects.toThrow(/status changes only through/i);
  });

  it("writes two audit rows, one naming the new merchant", async () => {
    await asUser(db, ADMIN_ID);
    const merchantId = await call(`approve_pre_app(${submittedId})`);

    await asPlatform(db);
    const r = await rows<{ table_name: string; row_id: string }>(
      db,
      `select table_name, row_id from audit_log
        where action = 'approve_pre_app' order by table_name`,
    );
    expect(r).toHaveLength(2);
    expect(r[0]).toEqual({ table_name: "merchants", row_id: String(merchantId) });
    expect(r[1]).toEqual({ table_name: "pre_apps", row_id: String(submittedId) });
  });

  it("refuses a second approval and creates only one merchant", async () => {
    await asUser(db, ADMIN_ID);
    await call(`approve_pre_app(${submittedId})`);

    await expect(call(`approve_pre_app(${submittedId})`)).rejects.toThrow(
      /already approved/i,
    );

    await asPlatform(db);
    const m = await rows<CountRow>(
      db,
      `select count(*)::int as n from merchants where dba = 'Agent Submitted App'`,
    );
    expect(m[0].n).toBe(1);
  });

  it("refuses a draft that was never submitted", async () => {
    await asUser(db, ADMIN_ID);

    await expect(call(`approve_pre_app(${draftId})`)).rejects.toThrow(
      /must be submitted before approval/i,
    );
  });

  it("raises on a nonexistent id instead of returning null", async () => {
    await asUser(db, ADMIN_ID);

    await expect(call(`approve_pre_app(987654)`)).rejects.toThrow(/not found/i);
  });

  it("writes no audit row when the id does not exist", async () => {
    // The old version logged an approval that never happened.
    await asUser(db, ADMIN_ID);
    await call(`approve_pre_app(987654)`).catch(() => {});

    await asPlatform(db);
    const r = await rows<CountRow>(
      db,
      `select count(*)::int as n from audit_log where action = 'approve_pre_app'`,
    );
    expect(r[0].n).toBe(0);
  });

  it("refuses an agent, and creates no merchant", async () => {
    await asUser(db, AGENT_ID);

    await expect(call(`approve_pre_app(${submittedId})`)).rejects.toThrow(
      /only admins can approve/i,
    );

    await asPlatform(db);
    const m = await rows<CountRow>(
      db,
      `select count(*)::int as n from merchants where dba = 'Agent Submitted App'`,
    );
    expect(m[0].n).toBe(0);
  });

  it("refuses a deactivated admin", async () => {
    await asPlatform(db);
    await db.exec(`update profiles set is_active = false where id = '${ADMIN_ID}'`);

    await asUser(db, ADMIN_ID);
    await expect(call(`approve_pre_app(${submittedId})`)).rejects.toThrow(
      /only admins can approve/i,
    );
  });
});

describe("decline and reopen", () => {
  it("declines a submitted pre-app with a reason", async () => {
    await asUser(db, ADMIN_ID);
    await call(`decline_pre_app(${submittedId}, 'Statements do not match the DBA')`);

    await asPlatform(db);
    const r = await rows<{ status: string; decline_reason: string }>(
      db,
      `select status, decline_reason from pre_apps where id = ${submittedId}`,
    );
    expect(r[0].status).toBe("declined");
    expect(r[0].decline_reason).toBe("Statements do not match the DBA");
  });

  it("requires a reason", async () => {
    await asUser(db, ADMIN_ID);

    await expect(call(`decline_pre_app(${submittedId}, '   ')`)).rejects.toThrow(
      /reason is required/i,
    );
    expect(await statusOf(submittedId)).toBe("submitted");
  });

  it("refuses an agent", async () => {
    await asUser(db, AGENT_ID);

    await expect(call(`decline_pre_app(${submittedId}, 'nope')`)).rejects.toThrow(
      /only admins can decline/i,
    );
  });

  it("refuses to decline a draft", async () => {
    await asUser(db, ADMIN_ID);

    await expect(call(`decline_pre_app(${draftId}, 'nope')`)).rejects.toThrow(
      /only a submitted pre-app can be declined/i,
    );
  });

  it("lets the owning rep reopen a declined pre-app to draft", async () => {
    // The point of recording a reason is that the rep can act on it.
    await asUser(db, ADMIN_ID);
    await call(`decline_pre_app(${submittedId}, 'Missing voided check')`);

    await asUser(db, AGENT_ID);
    await call(`reopen_pre_app(${submittedId})`);

    await asPlatform(db);
    const r = await rows<{ status: string; decline_reason: string | null }>(
      db,
      `select status, decline_reason from pre_apps where id = ${submittedId}`,
    );
    expect(r[0].status).toBe("draft");
    // Kept on purpose, so it stays on screen while they fix it.
    expect(r[0].decline_reason).toBe("Missing voided check");
  });

  it("clears the decline reason on the next successful submit", async () => {
    await asUser(db, ADMIN_ID);
    await call(`decline_pre_app(${submittedId}, 'Missing voided check')`);
    await asUser(db, AGENT_ID);
    await call(`reopen_pre_app(${submittedId})`);

    await makeSubmittable(submittedId);
    await asUser(db, AGENT_ID);
    await call(`submit_pre_app(${submittedId})`);

    await asPlatform(db);
    const r = await rows<{ decline_reason: string | null }>(
      db,
      `select decline_reason from pre_apps where id = ${submittedId}`,
    );
    expect(r[0].decline_reason).toBeNull();
  });

  it("refuses to reopen anything that is not declined", async () => {
    await asUser(db, AGENT_ID);

    await expect(call(`reopen_pre_app(${draftId})`)).rejects.toThrow(
      /only a declined pre-app can be reopened/i,
    );
  });

  it("does not let another agent reopen it", async () => {
    await asUser(db, ADMIN_ID);
    await call(`decline_pre_app(${submittedId}, 'nope')`);

    await asUser(db, OTHER_AGENT_ID);
    await expect(call(`reopen_pre_app(${submittedId})`)).rejects.toThrow(
      /not found/i,
    );
  });
});

describe("the state-machine RPCs are not callable by anon", () => {
  it("grants execute to authenticated and service_role only", async () => {
    await asPlatform(db);
    const sigs = [
      "public.submit_pre_app(int)",
      "public.approve_pre_app(int)",
      "public.decline_pre_app(int, text)",
      "public.reopen_pre_app(int)",
    ];
    for (const sig of sigs) {
      const r = await rows<{ anon: boolean; auth: boolean; svc: boolean }>(
        db,
        `select has_function_privilege('anon','${sig}','execute') as anon,
                has_function_privilege('authenticated','${sig}','execute') as auth,
                has_function_privilege('service_role','${sig}','execute') as svc`,
      );
      expect(r[0], sig).toEqual({ anon: false, auth: true, svc: true });
    }
  });

  it("leaves the trigger function ungranted to every client role", async () => {
    // A trigger fires regardless of EXECUTE, so granting it would widen the
    // surface for nothing.
    await asPlatform(db);
    const r = await rows<{ anon: boolean; auth: boolean }>(
      db,
      `select has_function_privilege('anon','public.pre_apps_guard_transitions()','execute') as anon,
              has_function_privilege('authenticated','public.pre_apps_guard_transitions()','execute') as auth`,
    );
    expect(r[0]).toEqual({ anon: false, auth: false });
  });
});

describe("the guard-trigger tests are load-bearing", () => {
  it("would notice if the trigger stopped guarding status", async () => {
    await asPlatform(db);
    await db.exec(`drop trigger pre_apps_guard_transitions on pre_apps`);

    await asUser(db, AGENT_ID);
    await db.exec(`update pre_apps set status = 'approved' where id = ${draftId}`);

    // With the trigger gone the agent can set any status they like, which is
    // exactly what the first describe block asserts is impossible.
    expect(await statusOf(draftId)).toBe("approved");
  });
});
