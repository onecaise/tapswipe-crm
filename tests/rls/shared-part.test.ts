import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  ADMIN_ID,
  asPlatform,
  asUser,
  createTestDb,
  rows,
  type TestDb,
} from "../helpers/db";

/**
 * shared_part(total, part, whole) — the cent rule for a shared account
 * (20261014120000; docs/design/residual-splits.md §4).
 *
 * The rule under test: for an account residual R at rep rate p, the payout one
 * rep alone would receive is T = round(R * p / 100, 2) — rep_payout_rows'
 * own expression. Two reps sharing the account get
 *
 *   partner = shared_part(T, partner_rep_pct, signer_rep_pct + partner_rep_pct)
 *   signer  = T - partner
 *
 * and the claims are: signer + partner = T exactly; each piece within half a
 * cent of the exact proportion; an exact half-cent tie goes to the SIGNER;
 * negatives mirror positives; neither line ever takes the opposite sign to T.
 *
 * Exhaustive rather than random, because the input space near the cent
 * boundaries is small enough to enumerate: every cent from -$200.00 to
 * $200.00, across eight ratios, at the standard 50% rate — 320,008 cases —
 * plus a smaller grid at non-standard rates. Two independent checks run over
 * the same rows:
 *
 *   1. An ORACLE in TypeScript, in BigInt, written differently from the SQL
 *      (quotient + remainder rather than floor((2n + d - 1) / 2d)), that must
 *      agree with Postgres on every row. A shared misunderstanding of the rule
 *      would fool this check, so:
 *   2. PROPERTY checks in SQL, stated directly in terms of the rule (sum,
 *      half-cent bound, tie direction, sign, oddness), each counting violations
 *      that must be zero — plus a count proving the tie cases actually occur,
 *      so the tie assertion cannot pass vacuously.
 */

/** Signer + partner shares of the 50-point rep side, as an admin types them. */
const RATIOS: readonly [signer: string, partner: string][] = [
  ["25.00", "25.00"], // the default
  ["40.00", "10.00"],
  ["10.00", "40.00"],
  ["30.00", "20.00"],
  ["33.33", "16.67"], // ties occur at an odd residue — see the tie count
  ["0.01", "49.99"],
  ["49.99", "0.01"],
  ["45.00", "5.00"],
];

/** Every cent from -$200.00 to $200.00. */
const CENT_RANGE = 20_000;

const RATIO_VALUES = RATIOS.map(([a, b]) => `(${a}::numeric, ${b}::numeric)`).join(", ");

// BigInt() rather than `100n` literals: tsconfig targets below ES2020, where
// tsc refuses the literal syntax (TS2737) even though vitest's runtime has it.
const ZERO = BigInt(0);
const ONE = BigInt(1);
const TWO = BigInt(2);
const HUNDRED = BigInt(100);
const TEN_THOUSAND = BigInt(10_000);

/** "-100.01" -> -10001. Whole hundredths only — anything finer is a bug here. */
function hundredths(text: string): bigint {
  const negative = text.startsWith("-");
  const [whole, fraction = ""] = text.replace("-", "").split(".");
  if (fraction.length > 2 && /[1-9]/.test(fraction.slice(2))) {
    throw new Error(`not a whole hundredth: ${text}`);
  }
  const magnitude = BigInt(whole) * HUNDRED + BigInt((fraction + "00").slice(0, 2));
  return negative ? -magnitude : magnitude;
}

const abs = (value: bigint): bigint => (value < ZERO ? -value : value);
const sign = (value: bigint): bigint =>
  value < ZERO ? -ONE : value > ZERO ? ONE : ZERO;

/**
 * Postgres's round(numeric, 2): half AWAY from zero. num/den is the exact value
 * in cents.
 */
function roundHalfAway(num: bigint, den: bigint): bigint {
  const q = abs(num) / den;
  const rem = abs(num) % den;
  return sign(num) * (TWO * rem >= den ? q + ONE : q);
}

/**
 * The rule's division, written independently of the SQL: nearest whole cent,
 * an exact half going toward zero.
 */
function nearestTiesTowardZero(num: bigint, den: bigint): bigint {
  const q = abs(num) / den;
  const rem = abs(num) % den;
  return sign(num) * (TWO * rem > den ? q + ONE : q);
}

type GridRow = {
  r: string;
  p: string;
  a: string;
  b: string;
  t: string;
  partner: string;
  partner_res: string;
};

/**
 * Checks every row against the oracle. Returns the mismatches (capped) so a
 * failure names a concrete case rather than a count.
 */
function oracleMismatches(grid: GridRow[]): string[] {
  const bad: string[] = [];
  for (const row of grid) {
    const rc = hundredths(row.r);
    const pBp = hundredths(row.p);
    const bBp = hundredths(row.b);
    const wBp = hundredths(row.a) + bBp;

    // T in cents is rc * p / 100, i.e. rc * pBp / 10000, rounded half away.
    const expectedT = roundHalfAway(rc * pBp, TEN_THOUSAND);
    const expectedPartner = nearestTiesTowardZero(expectedT * bBp, wBp);
    const expectedPartnerRes = nearestTiesTowardZero(rc * bBp, wBp);

    if (
      hundredths(row.t) !== expectedT ||
      hundredths(row.partner) !== expectedPartner ||
      hundredths(row.partner_res) !== expectedPartnerRes
    ) {
      bad.push(
        `R=${row.r} p=${row.p} ${row.a}+${row.b}: got T=${row.t} partner=${row.partner} ` +
          `partner_res=${row.partner_res}, expected T=${expectedT}c partner=${expectedPartner}c ` +
          `partner_res=${expectedPartnerRes}c`,
      );
      if (bad.length >= 10) break;
    }
  }
  return bad;
}

let db: TestDb;

beforeAll(async () => {
  db = await createTestDb();
  await asPlatform(db);

  // The standard-rate grid. `t` is written as rep_payout's own expression, with
  // the ledger's column types, so it is the payout one rep alone receives.
  await db.exec(`
    create temp table grid as
    with ratios(a, b) as (values ${RATIO_VALUES}),
    amounts as (
      select g, (g * 0.01)::numeric(14,2) as r
        from generate_series(-${CENT_RANGE}, ${CENT_RANGE}) as g
    ),
    solo as (
      select g, r, 50.00::numeric(5,2) as p, a, b,
             round(r * 50.00::numeric(5,2) / 100, 2) as t
        from amounts cross join ratios
    )
    select g, r, p, a, b, t,
           shared_part(t, b, a + b) as partner,
           shared_part(r, b, a + b) as partner_res
      from solo;
  `);
});

afterAll(async () => {
  await db.close();
});

describe("the cent rule, every cent from -$200.00 to $200.00 at the standard rate", () => {
  it("covers the whole grid: 40,001 amounts x 8 ratios", async () => {
    const [{ n }] = await rows<{ n: number }>(db, `select count(*)::int as n from grid`);
    expect(n).toBe((2 * CENT_RANGE + 1) * RATIOS.length);
  });

  it("agrees with an independent BigInt oracle on every row", async () => {
    const grid = await rows<GridRow>(
      db,
      `select r::text, p::text, a::text, b::text, t::text,
              partner::text, partner_res::text
         from grid`,
    );
    expect(grid).toHaveLength((2 * CENT_RANGE + 1) * RATIOS.length);
    expect(oracleMismatches(grid)).toEqual([]);
  });

  it("signer + partner equals round(R x p / 100, 2), what one rep alone receives", async () => {
    // The signer's line is T - partner, so the sum is exact by construction —
    // asserted anyway, against the solo expression recomputed from R rather than
    // against the stored t, because this is the rule the business stated.
    const [{ wrong }] = await rows<{ wrong: number }>(
      db,
      `select count(*)::int as wrong from grid
        where (t - partner) + partner <> round(r * p / 100, 2)`,
    );
    expect(wrong).toBe(0);
  });

  it("keeps both lines within half a cent of the exact proportion", async () => {
    // In integer hundredths: |partner * w - T * b| * 2 <= w, and the same for the
    // signer against the signer's share. No division, so no precision argument.
    const [{ partner, signer }] = await rows<{ partner: number; signer: number }>(
      db,
      `select
         count(*) filter (where 2 * abs(partner * 100 * (a + b) * 100 - t * 100 * b * 100)
                                > (a + b) * 100)::int as partner,
         count(*) filter (where 2 * abs((t - partner) * 100 * (a + b) * 100 - t * 100 * a * 100)
                                > (a + b) * 100)::int as signer
         from grid`,
    );
    expect(partner).toBe(0);
    expect(signer).toBe(0);
  });

  it("gives every exact half-cent tie to the signer, for credits and clawbacks alike", async () => {
    // A tie is an exact proportion of k + 1/2 cents: 2 * |T| * b is an odd
    // multiple of the whole. On a tie the partner must sit half a cent BELOW
    // exact in magnitude and the signer half a cent ABOVE.
    const [counts] = await rows<{
      ties_positive: number;
      ties_negative: number;
      partner_not_down: number;
      signer_not_up: number;
    }>(
      db,
      `with ties as (
         select * from grid
          where mod(2 * abs(t) * 100 * b * 100, 2 * (a + b) * 100) = (a + b) * 100
       )
       select
         count(*) filter (where t > 0)::int as ties_positive,
         count(*) filter (where t < 0)::int as ties_negative,
         count(*) filter (where 2 * abs(partner) * 100 * (a + b) * 100
                                <> 2 * abs(t) * 100 * b * 100 - (a + b) * 100)::int
           as partner_not_down,
         count(*) filter (where 2 * abs(t - partner) * 100 * (a + b) * 100
                                <> 2 * abs(t) * 100 * a * 100 + (a + b) * 100)::int
           as signer_not_up
         from ties`,
    );
    // Non-vacuous: ties really occur, on both sides of zero.
    expect(counts.ties_positive).toBeGreaterThan(0);
    expect(counts.ties_negative).toBeGreaterThan(0);
    expect(counts.partner_not_down).toBe(0);
    expect(counts.signer_not_up).toBe(0);
  });

  it("mirrors a negative month exactly: f(-R) = -f(R) for T and both lines", async () => {
    const [{ checked, wrong }] = await rows<{ checked: number; wrong: number }>(
      db,
      `select count(*)::int as checked,
              count(*) filter (where neg.t <> -pos.t
                                  or neg.partner <> -pos.partner
                                  or (neg.t - neg.partner) <> -(pos.t - pos.partner)
                                  or neg.partner_res <> -pos.partner_res)::int as wrong
         from grid pos
         join grid neg on neg.g = -pos.g and neg.a = pos.a and neg.b = pos.b
        where pos.g > 0`,
    );
    expect(checked).toBe(CENT_RANGE * RATIOS.length);
    expect(wrong).toBe(0);
  });

  it("never gives either line the opposite sign to T", async () => {
    const [{ wrong }] = await rows<{ wrong: number }>(
      db,
      `select count(*)::int as wrong from grid
        where sign(partner) not in (0, sign(t))
           or sign(t - partner) not in (0, sign(t))`,
    );
    expect(wrong).toBe(0);
  });

  it("divides the residual itself exactly too (the display pieces)", async () => {
    const [{ wrong }] = await rows<{ wrong: number }>(
      db,
      `select count(*)::int as wrong from grid
        where (r - partner_res) + partner_res <> r
           or 2 * abs(partner_res * 100 * (a + b) * 100 - r * 100 * b * 100) > (a + b) * 100
           or sign(partner_res) not in (0, sign(r))
           or sign(r - partner_res) not in (0, sign(r))`,
    );
    expect(wrong).toBe(0);
  });

  it("is zero on a zero month", async () => {
    const [{ wrong }] = await rows<{ wrong: number }>(
      db,
      `select count(*)::int as wrong from grid
        where r = 0 and (t <> 0 or partner <> 0 or partner_res <> 0)`,
    );
    expect(wrong).toBe(0);
  });
});

describe("the cent rule at non-standard rates", () => {
  // The rule says the rep side is always 50%, but §10 of the memo handles a
  // legacy line at another rate by dividing proportionally at that rate — so the
  // rule must hold there too.
  it("agrees with the oracle and sums exactly for p in {0.01, 33.33, 49.99, 60, 99.99}", async () => {
    await asPlatform(db);
    const grid = await rows<GridRow>(
      db,
      `with ratios(a, b) as (values ${RATIO_VALUES}),
       rates(p) as (values (0.01::numeric(5,2)), (33.33), (49.99), (60.00), (99.99)),
       amounts as (
         select (g * 0.01)::numeric(14,2) as r from generate_series(-2000, 2000) as g
       ),
       solo as (
         select r, p, a, b, round(r * p / 100, 2) as t
           from amounts cross join rates cross join ratios
       )
       select r::text, p::text, a::text, b::text, t::text,
              shared_part(t, b, a + b)::text as partner,
              shared_part(r, b, a + b)::text as partner_res
         from solo`,
    );
    expect(grid).toHaveLength(4001 * 5 * RATIOS.length);
    expect(oracleMismatches(grid)).toEqual([]);
  });

  it("holds at the extremes of numeric(14,2)", async () => {
    await asPlatform(db);
    const grid = await rows<GridRow>(
      db,
      `with ratios(a, b) as (values ${RATIO_VALUES}),
       amounts(r) as (values (999999999999.99::numeric(14,2)), (-999999999999.99),
                             (999999999999.98), (-999999999999.97), (0.01), (-0.01))
       select r::text, 50.00::text as p, a::text, b::text,
              round(r * 50.00 / 100, 2)::text as t,
              shared_part(round(r * 50.00 / 100, 2), b, a + b)::text as partner,
              shared_part(r, b, a + b)::text as partner_res
         from amounts cross join ratios`,
    );
    expect(oracleMismatches(grid)).toEqual([]);
  });
});

describe("the worked examples in the design memo (§4.4)", () => {
  // Hand-derived, so a reader can check the rule against arithmetic they can
  // follow — the grids above prove it, these illustrate it.
  it.each([
    // R,          signer, partner, T,        partner, signer
    ["100.01", "25.00", "25.00", "50.01", "25.00", "25.01"],
    ["0.03", "25.00", "25.00", "0.02", "0.01", "0.01"],
    ["0.02", "25.00", "25.00", "0.01", "0.00", "0.01"],
    ["-0.02", "25.00", "25.00", "-0.01", "0.00", "-0.01"],
    ["-100.01", "40.00", "10.00", "-50.01", "-10.00", "-40.01"],
    ["7.77", "30.00", "20.00", "3.89", "1.56", "2.33"],
  ])(
    "R=%s split %s+%s: T=%s, partner %s, signer %s",
    async (r, a, b, t, partner, signer) => {
      await asPlatform(db);
      const [row] = await rows<{ t: string; partner: string; signer: string }>(
        db,
        `with s as (select round(${r}::numeric(14,2) * 50.00 / 100, 2) as t)
         select t::text,
                shared_part(t, ${b}, ${a} + ${b})::text as partner,
                (t - shared_part(t, ${b}, ${a} + ${b}))::text as signer
           from s`,
      );
      expect(row).toEqual({ t, partner, signer });
    },
  );

  it("shows why each line must not round its own payout: $0.02 at 25+25 would pay $0.02 against a solo $0.01", async () => {
    await asPlatform(db);
    const [row] = await rows<{ solo: string; per_line: string; divided: string }>(
      db,
      `select round(0.02 * 50.00 / 100, 2)::text as solo,
              (round(0.01 * 50.00 / 100, 2) + round(0.01 * 50.00 / 100, 2))::text as per_line,
              ((round(0.02 * 50.00 / 100, 2) - shared_part(round(0.02 * 50.00 / 100, 2), 25, 50))
               + shared_part(round(0.02 * 50.00 / 100, 2), 25, 50))::text as divided`,
    );
    expect(row).toEqual({ solo: "0.01", per_line: "0.02", divided: "0.01" });
  });
});

describe("inputs", () => {
  async function refusal(sql: string): Promise<{ code?: string; message: string }> {
    await asPlatform(db);
    try {
      await db.query(sql);
    } catch (error) {
      return error as { code?: string; message: string };
    }
    throw new Error(`expected a refusal: ${sql}`);
  }

  it("returns NULL for NULL, so 'not worked out yet' stays not worked out", async () => {
    await asPlatform(db);
    const [row] = await rows<{ t: string | null; p: string | null; w: string | null }>(
      db,
      `select shared_part(null, 10, 50)::text as t,
              shared_part(1.00, null, 50)::text as p,
              shared_part(1.00, 10, null)::text as w`,
    );
    expect(row).toEqual({ t: null, p: null, w: null });
  });

  it("returns whole cents at scale 2, and the bounds at part = 0 and part = whole", async () => {
    await asPlatform(db);
    const [row] = await rows<{ half: string; none: string; all: string; zero: string }>(
      db,
      `select shared_part(100.00, 25, 50)::text as half,
              shared_part(-12.34, 0, 50)::text as none,
              shared_part(-12.34, 50, 50)::text as all,
              shared_part(0, 25, 50)::text as zero`,
    );
    expect(row).toEqual({ half: "50.00", none: "0.00", all: "-12.34", zero: "0.00" });
  });

  it.each([
    ["a zero whole", `select shared_part(1.00, 0, 0)`, /whole must be greater than zero/],
    ["a negative whole", `select shared_part(1.00, 0, -50)`, /whole must be greater than zero/],
    ["a negative part", `select shared_part(1.00, -1, 50)`, /between 0 and whole/],
    ["a part above the whole", `select shared_part(1.00, 50.01, 50)`, /between 0 and whole/],
    ["a fraction of a cent", `select shared_part(1.005, 25, 50)`, /whole cents/],
    ["a fraction of a hundredth of a percent", `select shared_part(1.00, 10.001, 50)`, /whole cents/],
  ])("refuses %s with 22023 rather than rounding it", async (_label, sql, message) => {
    const error = await refusal(sql);
    expect(error.code).toBe("22023");
    expect(error.message).toMatch(message);
  });
});

describe("catalog and privileges", () => {
  const SIG = "shared_part(numeric, numeric, numeric)";

  it("is immutable, strict and security invoker — a generated column will call it", async () => {
    await asPlatform(db);
    const [fn] = await rows<{
      provolatile: string;
      proisstrict: boolean;
      prosecdef: boolean;
      proconfig: string[] | null;
    }>(
      db,
      `select provolatile, proisstrict, prosecdef, proconfig
         from pg_proc where oid = '${SIG}'::regprocedure`,
    );
    expect(fn.provolatile).toBe("i");
    expect(fn.proisstrict).toBe(true);
    // Invoker: it reads no table, so definer would buy nothing but risk.
    expect(fn.prosecdef).toBe(false);
    expect(fn.proconfig).toContain("search_path=public");
  });

  it("is not executable by anon, and is by authenticated and service_role", async () => {
    await asPlatform(db);
    const [grants] = await rows<{ auth: boolean; svc: boolean; anon: boolean; pub: boolean }>(
      db,
      `select has_function_privilege('authenticated', '${SIG}', 'execute') as auth,
              has_function_privilege('service_role',  '${SIG}', 'execute') as svc,
              has_function_privilege('anon',          '${SIG}', 'execute') as anon,
              exists (select 1 from pg_proc p, aclexplode(p.proacl) acl
                       where p.oid = '${SIG}'::regprocedure and acl.grantee = 0) as pub`,
    );
    expect(grants).toEqual({ auth: true, svc: true, anon: false, pub: false });
  });

  it("answers an authenticated caller", async () => {
    await asUser(db, ADMIN_ID);
    const [row] = await rows<{ partner: string }>(
      db,
      `select shared_part(50.01, 25, 50)::text as partner`,
    );
    expect(row.partner).toBe("25.00");
    await asPlatform(db);
  });
});
