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
 * check_duplicates() — the mirror case to search_crm, and the reason this file
 * is long.
 *
 * search_crm is `security invoker` precisely so a search box cannot surface a
 * record the rest of the app hides. This function is `security definer` on
 * purpose, because the duplicates that matter most are the ones RLS hides: two
 * reps working the same merchant. That makes every assertion below load-bearing
 * in a way the other RPC tests are not — there is no policy underneath catching
 * a mistake, so the redaction IS the boundary.
 *
 * The assertions that would be easy to get wrong and impossible to notice:
 *
 *   - prosecdef must be TRUE here. dashboard-and-search.test.ts asserts the
 *     opposite for its two functions; copying that assertion to this file
 *     would be asserting the function is broken.
 *   - a redacted row must carry no id, no title, no subtitle. Not "a title the
 *     UI happens not to render" — NULL, from the function.
 *   - redacted rows must be AGGREGATED, so the row count is not itself a
 *     report on how many records exist in books the caller cannot see.
 */

type DupRow = {
  visibility: string;
  record_type: string;
  record_id: number | null;
  title: string | null;
  subtitle: string | null;
  matched_field: string;
  strength: string;
};

/** Named args, so each test names only the fields it is probing. */
type DupArgs = Partial<{
  contact_email_input: string;
  contact_phone_input: string;
  business_phone_input: string;
  mobile_phone_input: string;
  website_input: string;
  dba_input: string;
  legal_name_input: string;
  address_input: string;
  city_input: string;
  state_input: string;
  zip_input: string;
  exclude_lead_id: number;
  name_threshold: number;
}>;

function argList(args: DupArgs): string {
  return Object.entries(args)
    .map(([key, value]) =>
      typeof value === "number"
        ? `${key} => ${value}`
        : `${key} => '${String(value).replace(/'/g, "''")}'`,
    )
    .join(", ");
}

async function check(
  db: TestDb,
  caller: string | null,
  args: DupArgs,
): Promise<DupRow[]> {
  await asUser(db, caller);
  return rows<DupRow>(db, `select * from check_duplicates(${argList(args)})`);
}

async function checkError(
  db: TestDb,
  caller: string | null,
  args: DupArgs,
): Promise<string | null> {
  await asUser(db, caller);
  try {
    await db.exec(`select * from check_duplicates(${argList(args)})`);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

/**
 * Richer fixtures than seed() provides.
 *
 * seed()'s leads carry no email, phone or website — it may only touch columns
 * from the initial schema, because it is also run against migration subsets.
 * Everything the exact tier matches on is filled in here instead.
 */
async function seedDuplicates(db: TestDb): Promise<void> {
  await asPlatform(db);
  await db.exec(`
    insert into leads (agent_id, dba, merchant_legal_name, contact_name,
                       contact_email, contact_phone, business_phone, mobile_phone,
                       website, address, city, state, zip)
    values
      ('${AGENT_ID}', 'Mine Diner', 'Mine Diner LLC', 'Ada Mine',
       'ada@minediner.test', '(615) 555-1111', '615-555-2222', '6155553333',
       'https://www.minediner.test/menu', '100 Main St', 'Nashville', 'TN', '37201'),
      ('${OTHER_AGENT_ID}', 'Theirs Grill', 'Theirs Grill LLC', 'Bob Theirs',
       'bob@theirsgrill.test', '(901) 555-4444', '901-555-5555', '9015556666',
       'http://theirsgrill.test', '200 Union Ave', 'Memphis', 'TN', '38103'),
      -- A SECOND row in the other agent's book matching the same phone, so the
      -- aggregation assertion has something to collapse.
      ('${OTHER_AGENT_ID}', 'Theirs Grill Annex', 'Theirs Grill Two LLC', 'Bob Theirs',
       'bob2@theirsgrill.test', '901-555-4444', null, null,
       null, '202 Union Ave', 'Memphis', 'TN', '38103');

    -- A merchant and a ghost sheet in the OTHER agent's book, under a name
    -- that resembles nothing in the caller's. seed()'s own fixtures are named
    -- 'Agent Active Co' / 'Other Active Co' and 'Agent Sheet Open' / 'Other
    -- Sheet Open', which are ~0.6 similar to each other by construction — so
    -- probing for the other agent's row there also matches the caller's own,
    -- and a redaction assertion over the whole result set fails on a row that
    -- is correctly NOT redacted. Distinctive names keep this test about
    -- redaction rather than about trigram scores.
    insert into merchants (agent_id, dba, legal_business_name, status)
    values ('${OTHER_AGENT_ID}', 'Zephyr Hardware Supply', 'Zephyr Hardware Supply LLC', 'active');

    insert into ghost_sheets (agent_id, dba, contact_name)
    values ('${OTHER_AGENT_ID}', 'Zephyr Hardware Supply', 'Zed Zephyr');
  `);
}

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
});

beforeEach(async () => {
  await resetData(db);
  await seedDuplicates(db);
});

afterAll(async () => {
  await db?.close();
});

describe("check_duplicates is security definer, deliberately", () => {
  it("has prosecdef true — the opposite of search_crm and dashboard_counts", async () => {
    // Not a copy-paste slip. This function has to see across every book,
    // because a rep cannot see the other rep's lead and that is exactly the
    // duplicate worth warning about. dashboard-and-search.test.ts asserts
    // prosecdef is FALSE for its two; asserting that here would be asserting
    // this function cannot do its job.
    await asPlatform(db);
    const [{ prosecdef }] = await rows<{ prosecdef: boolean }>(
      db,
      `select prosecdef from pg_proc where proname = 'check_duplicates'`,
    );
    expect(prosecdef).toBe(true);
  });

  it("pins its search_path, so the pinned schemas cannot be shadowed", async () => {
    // A definer function with an unpinned search_path is the classic
    // privilege-escalation shape. It also has to name `extensions`, or the
    // pg_trgm operators are simply not found at runtime.
    await asPlatform(db);
    const [{ config }] = await rows<{ config: string[] }>(
      db,
      `select proconfig as config from pg_proc where proname = 'check_duplicates'`,
    );
    expect(config).toContain("search_path=public, extensions");
  });

  it("is executable by authenticated and not by anon", async () => {
    await asPlatform(db);
    const signature =
      "check_duplicates(text, text, text, text, text, text, text, text, text, text, text, int, real)";
    const [{ auth_ok, anon_ok }] = await rows<{
      auth_ok: boolean;
      anon_ok: boolean;
    }>(
      db,
      `select has_function_privilege('authenticated', '${signature}', 'execute') as auth_ok,
              has_function_privilege('anon', '${signature}', 'execute') as anon_ok`,
    );
    expect(auth_ok).toBe(true);
    expect(anon_ok).toBe(false);
  });

  it("refuses a deactivated caller, and one with no JWT", async () => {
    // The hand-written guard is all there is — RLS is doing none of the work.
    await asPlatform(db);
    await db.exec(
      `update profiles set is_active = false where id = '${AGENT_ID}'`,
    );

    expect(
      await checkError(db, AGENT_ID, { contact_email_input: "ada@minediner.test" }),
    ).toMatch(/not authorised/);

    expect(
      await checkError(db, null, { contact_email_input: "ada@minediner.test" }),
    ).toMatch(/not authorised/);
  });
});

describe("redaction — the boundary this function pays for definer with", () => {
  it("returns NOTHING identifying for a lead in another rep's book", async () => {
    // The assertion the whole feature stands on. Probing with the other
    // agent's email as the caller AGENT_ID: the row exists, the caller must
    // learn that it exists and nothing else.
    const result = await check(db, AGENT_ID, {
      contact_email_input: "bob@theirsgrill.test",
    });

    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({
      visibility: "redacted",
      record_type: "lead",
      record_id: null,
      title: null,
      subtitle: null,
      matched_field: "contact_email",
      strength: "exact",
    });
  });

  it("leaks nothing identifying through ANY column, on any probe", async () => {
    // A sweep rather than a field-by-field check, because the failure mode is
    // a column someone adds later and forgets to null out. Every probe below
    // matches a record in the other agent's book; none of them may come back
    // carrying an id or a string that appears in that record.
    const probes: DupArgs[] = [
      { contact_email_input: "bob@theirsgrill.test" },
      { contact_phone_input: "9015554444" },
      { business_phone_input: "901-555-5555" },
      { mobile_phone_input: "(901) 555-6666" },
      { website_input: "https://www.theirsgrill.test/about" },
      { dba_input: "Theirs Grill" },
      { legal_name_input: "Theirs Grill LLC" },
      {
        address_input: "200 Union Ave",
        zip_input: "38103",
      },
    ];

    for (const probe of probes) {
      const result = await check(db, AGENT_ID, probe);
      expect(
        result.length,
        `probe ${JSON.stringify(probe)} should have matched something`,
      ).toBeGreaterThan(0);

      for (const row of result) {
        expect(row.visibility, JSON.stringify(probe)).toBe("redacted");
        expect(row.record_id, JSON.stringify(probe)).toBeNull();
        expect(row.title, JSON.stringify(probe)).toBeNull();
        expect(row.subtitle, JSON.stringify(probe)).toBeNull();
      }

      // And nothing identifying smuggled into the two text columns that DO
      // come back. matched_field and strength are a fixed vocabulary; this
      // fails if either ever starts carrying data from the row.
      const serialised = JSON.stringify(result).toLowerCase();
      for (const secret of [
        "theirs",
        "bob",
        "901",
        "union ave",
        "memphis",
        "38103",
        OTHER_AGENT_ID,
      ]) {
        expect(
          serialised.includes(secret.toLowerCase()),
          `"${secret}" leaked for probe ${JSON.stringify(probe)}`,
        ).toBe(false);
      }
    }
  });

  it("aggregates redacted matches, so the row count is not a census", async () => {
    // Two leads in the other agent's book share 9015554444. One row back, not
    // two — otherwise counting the result set reports how many records exist
    // in a book the caller cannot see. A weaker leak than a name, and free to
    // avoid.
    const result = await check(db, AGENT_ID, {
      contact_phone_input: "901-555-4444",
    });

    expect(result).toEqual([
      {
        visibility: "redacted",
        record_type: "lead",
        record_id: null,
        title: null,
        subtitle: null,
        matched_field: "phone",
        strength: "exact",
      },
    ]);
  });

  it("redacts another rep's merchant and ghost sheet the same way", async () => {
    // 'Zephyr Hardware Supply' exists only in the other agent's book, as both
    // a merchant and a ghost sheet. Merchants carry no contact columns at all,
    // so name is their entire match surface and nothing from merchants can
    // ever come back `exact`.
    const result = await check(db, AGENT_ID, {
      dba_input: "Zephyr Hardware Supply",
    });

    expect(result.map((r) => r.record_type).sort()).toEqual([
      "ghost_sheet",
      "merchant",
    ]);
    for (const row of result) {
      expect(row.visibility).toBe("redacted");
      expect(row.record_id).toBeNull();
      expect(row.title).toBeNull();
      expect(row.subtitle).toBeNull();
      expect(row.strength).toBe("fuzzy");
    }

    expect(JSON.stringify(result).toLowerCase()).not.toContain("zephyr");
  });
});

describe("the caller's own matches come back in full", () => {
  it("returns the id and name for a lead in the caller's own book", async () => {
    // Nothing is disclosed by this: the caller can already select the row
    // under RLS. Withholding it would make the warning unactionable.
    const result = await check(db, AGENT_ID, {
      contact_email_input: "ADA@MineDiner.test  ",
    });

    expect(result).toHaveLength(1);
    expect(result[0].visibility).toBe("own");
    expect(result[0].record_type).toBe("lead");
    expect(result[0].title).toBe("Mine Diner");
    expect(result[0].subtitle).toBe("Ada Mine");
    expect(result[0].matched_field).toBe("contact_email");
    expect(result[0].record_id).toBeGreaterThan(0);
  });

  it("shows an admin everything in full, because RLS would too", async () => {
    // is_admin() already sees every row, so full detail here discloses nothing
    // new. The rule is "never show what RLS would hide", not "always redact
    // other books".
    const result = await check(db, ADMIN_ID, {
      contact_email_input: "bob@theirsgrill.test",
    });

    expect(result).toHaveLength(1);
    expect(result[0].visibility).toBe("own");
    expect(result[0].title).toBe("Theirs Grill");
    expect(result[0].record_id).toBeGreaterThan(0);
  });

  it("reports one row per record, naming its strongest reason", async () => {
    // This probe matches the caller's own lead on email, phone, website AND
    // name at once. One row back, exact before fuzzy — a list that repeated
    // the same lead four times would be unreadable.
    const result = await check(db, AGENT_ID, {
      contact_email_input: "ada@minediner.test",
      contact_phone_input: "6155551111",
      website_input: "minediner.test",
      dba_input: "Mine Diner",
    });

    const ownLeads = result.filter(
      (r) => r.visibility === "own" && r.record_type === "lead",
    );
    expect(ownLeads).toHaveLength(1);
    expect(ownLeads[0].strength).toBe("exact");
  });

  it("excludes a named lead, so editing one does not match itself", async () => {
    const [match] = await check(db, AGENT_ID, {
      contact_email_input: "ada@minediner.test",
    });
    expect(match.record_id).not.toBeNull();

    const excluded = await check(db, AGENT_ID, {
      contact_email_input: "ada@minediner.test",
      exclude_lead_id: match.record_id as number,
    });
    expect(excluded).toEqual([]);
  });
});

describe("the exact tier", () => {
  it("matches an email case-insensitively and ignores surrounding space", async () => {
    const result = await check(db, AGENT_ID, {
      contact_email_input: "  ADA@MINEDINER.TEST ",
    });
    expect(result.map((r) => r.matched_field)).toContain("contact_email");
  });

  it("matches a phone in all NINE combinations, not three", async () => {
    // The row's three phone columns against the input's three. A rep types a
    // mobile into "contact phone" as often as not, so a positional comparison
    // would miss the majority of real duplicates.
    const rowPhones = ["6155551111", "6155552222", "6155553333"];
    const inputFields = [
      "contact_phone_input",
      "business_phone_input",
      "mobile_phone_input",
    ] as const;

    for (const field of inputFields) {
      for (const phone of rowPhones) {
        const result = await check(db, AGENT_ID, { [field]: phone });
        expect(
          result.some(
            (r) => r.matched_field === "phone" && r.visibility === "own",
          ),
          `${field} = ${phone} should have matched`,
        ).toBe(true);
      }
    }
  });

  it("normalises punctuation out of a phone before comparing", async () => {
    const result = await check(db, AGENT_ID, {
      contact_phone_input: "+1 (615) 555-1111",
    });
    // Leading country code makes this 11 digits against a stored 10, so it is
    // NOT expected to match — asserted so the limitation is recorded rather
    // than discovered. The punctuation-only case below is the one that must.
    expect(result.filter((r) => r.matched_field === "phone")).toEqual([]);

    const punctuated = await check(db, AGENT_ID, {
      contact_phone_input: "(615) 555.1111",
    });
    expect(punctuated.map((r) => r.matched_field)).toContain("phone");
  });

  it("ignores a phone fragment too short to mean anything", async () => {
    // '555' would otherwise match a large slice of the book, and a warning
    // that fires constantly is one reps learn to click through unread.
    const result = await check(db, AGENT_ID, { contact_phone_input: "555" });
    expect(result.filter((r) => r.matched_field === "phone")).toEqual([]);
  });

  it("matches a website on host only, across scheme, www and path", async () => {
    for (const website of [
      "minediner.test",
      "http://minediner.test",
      "https://www.minediner.test",
      "https://WWW.MineDiner.test/menu?utm=x",
    ]) {
      const result = await check(db, AGENT_ID, { website_input: website });
      expect(
        result.map((r) => r.matched_field),
        `${website} should have matched on host`,
      ).toContain("website");
    }
  });

  it("does not match a different host that merely shares a path", async () => {
    const result = await check(db, AGENT_ID, {
      website_input: "https://elsewhere.test/menu",
    });
    expect(result.filter((r) => r.matched_field === "website")).toEqual([]);
  });
});

describe("the fuzzy tier", () => {
  it("matches a near-miss business name", async () => {
    // The case the threshold exists for. 'Joes Pizza' vs "Joe's Pizza LLC"
    // scores 0.5, so a punctuation-and-suffix difference still warns.
    await asPlatform(db);
    await db.exec(
      `insert into leads (agent_id, dba) values ('${AGENT_ID}', 'Joe''s Pizza LLC')`,
    );

    const result = await check(db, AGENT_ID, { dba_input: "Joes Pizza" });
    expect(
      result.some((r) => r.matched_field === "name" && r.strength === "fuzzy"),
    ).toBe(true);
  });

  it("never reports a fuzzy name match as exact", async () => {
    // The UI wording turns on this. A fuzzy hit presented as an exact one
    // reads as certainty the function does not have.
    const result = await check(db, AGENT_ID, { dba_input: "Mine Dinerr" });
    for (const row of result.filter((r) => r.matched_field === "name")) {
      expect(row.strength).toBe("fuzzy");
    }
  });

  it("does not match two genuinely different businesses", async () => {
    const result = await check(db, AGENT_ID, {
      dba_input: "Pacific Northwest Logging Supply",
    });
    expect(result.filter((r) => r.matched_field === "name")).toEqual([]);
  });

  it("cross-checks dba against merchant_legal_name in both directions", async () => {
    // A rep typing the legal name into DBA, or the reverse, is the ordinary
    // case rather than the exception.
    const byLegal = await check(db, AGENT_ID, { dba_input: "Mine Diner LLC" });
    expect(byLegal.some((r) => r.matched_field === "name")).toBe(true);

    const byDba = await check(db, AGENT_ID, { legal_name_input: "Mine Diner" });
    expect(byDba.some((r) => r.matched_field === "name")).toBe(true);
  });

  it("only matches an address when the zip agrees", async () => {
    // '100 Main St' exists in every town in the country, so an address match
    // on its own is noise. Scoped by zip, it is a real signal.
    const sameZip = await check(db, AGENT_ID, {
      address_input: "100 Main Street",
      zip_input: "37201",
    });
    expect(sameZip.some((r) => r.matched_field === "address")).toBe(true);

    const otherZip = await check(db, AGENT_ID, {
      address_input: "100 Main Street",
      zip_input: "90210",
    });
    expect(otherZip.filter((r) => r.matched_field === "address")).toEqual([]);
  });

  it("falls back to city and state when no zip was given", async () => {
    const result = await check(db, AGENT_ID, {
      address_input: "100 Main Street",
      city_input: "nashville",
      state_input: "tn",
    });
    expect(result.some((r) => r.matched_field === "address")).toBe(true);

    const elsewhere = await check(db, AGENT_ID, {
      address_input: "100 Main Street",
      city_input: "Memphis",
      state_input: "TN",
    });
    expect(elsewhere.filter((r) => r.matched_field === "address")).toEqual([]);
  });

  it("finds nothing at all when given nothing", async () => {
    // The empty form. Every key normalises to NULL, every branch is skipped,
    // and the rep is not shown a warning about the entire database.
    expect(await check(db, AGENT_ID, {})).toEqual([]);
    expect(
      await check(db, AGENT_ID, {
        contact_email_input: "   ",
        dba_input: "  ",
        website_input: "",
      }),
    ).toEqual([]);
  });
});

describe("all three tables are checked", () => {
  it("finds the caller's own ghost sheet by phone", async () => {
    await asPlatform(db);
    await db.exec(
      `update ghost_sheets set contact_phone = '615-555-7777'
        where dba = 'Agent Sheet Open'`,
    );

    const result = await check(db, AGENT_ID, {
      mobile_phone_input: "6155557777",
    });
    const sheet = result.find((r) => r.record_type === "ghost_sheet");
    expect(sheet?.visibility).toBe("own");
    expect(sheet?.title).toBe("Agent Sheet Open");
  });

  it("finds the caller's own merchant by name — the costliest miss", async () => {
    // A rep starting to work an account the company already has. seed() gives
    // AGENT_ID 'Agent Active Co'.
    const result = await check(db, AGENT_ID, { dba_input: "Agent Active Co" });
    const merchant = result.find((r) => r.record_type === "merchant");

    expect(merchant?.visibility).toBe("own");
    expect(merchant?.title).toBe("Agent Active Co");
    expect(merchant?.strength).toBe("fuzzy");
  });

  it("reports every table that matches, in one call", async () => {
    await asPlatform(db);
    await db.exec(`
      insert into leads (agent_id, dba) values ('${AGENT_ID}', 'Crossover Co');
      insert into ghost_sheets (agent_id, dba) values ('${AGENT_ID}', 'Crossover Co');
      insert into merchants (agent_id, dba, status)
        values ('${AGENT_ID}', 'Crossover Co', 'active');
    `);

    const result = await check(db, AGENT_ID, { dba_input: "Crossover Co" });
    const types = new Set(result.map((r) => r.record_type));

    expect(types).toContain("lead");
    expect(types).toContain("ghost_sheet");
    expect(types).toContain("merchant");
  });
});
