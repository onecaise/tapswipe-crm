import { execSync } from "node:child_process";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Fixtures for the e2e suite: three personas and five period states.
 *
 * **This suite provisions its own data and does not depend on the seed-dev-*
 * scripts.** That is the difference between a suite and a script that works on
 * one machine: those scripts are throwaway bootstraps an operator runs by hand,
 * and a spec that assumed their output would pass or fail according to what
 * somebody last clicked. Everything the specs assert on is created here.
 *
 * Runs against the LOCAL stack only, and refuses anything else — it holds the
 * service-role key and creates accounts with a known password. Same guard, and
 * same reason, as tests/live/helpers/stack.ts.
 *
 * Idempotent by construction: personas are looked up before being created, and
 * the payout rows for the periods below are deleted and rewritten on every run.
 * So `npm run test:e2e` twice in a row is the same as once, which matters
 * because a failed run leaves whatever it had done behind.
 */

/** Known, throwaway, local-only. Mirrors PASSWORD in tests/live/helpers. */
export const E2E_PASSWORD = "e2e-test-password-123";

/**
 * The two territory labels, and who carries which.
 *
 * profiles.territory is free text with no vocabulary, so these are just
 * strings — prefixed like everything else here so they cannot collide with a
 * real label somebody set by hand in the dev database.
 *
 * The split is what makes the territory filter falsifiable from a browser: the
 * agent is alone in North, and the OTHER agent is alone in South, so filtering
 * an admin's dashboard by South has to produce the other agent's numbers and
 * not the agent's, and not the company's.
 */
export const TERRITORIES = { agent: "E2E North", agent2: "E2E South" } as const;

export const PERSONAS = {
  admin: { email: "e2e-admin@tapswipe.test", fullName: "E2E Admin", role: "admin", agentNumber: "9001", territory: null },
  agent: { email: "e2e-agent@tapswipe.test", fullName: "E2E Agent", role: "agent", agentNumber: "9002", territory: TERRITORIES.agent },
  agent2: { email: "e2e-agent2@tapswipe.test", fullName: "E2E Agent Two", role: "agent", agentNumber: "9003", territory: TERRITORIES.agent2 },
  /**
   * Exists to be signed out, and is shared with nothing.
   *
   * `supabase.auth.signOut()` defaults to `scope: "global"`, which revokes the
   * user's refresh tokens on the server for every device at once. The stored
   * access token in e2e/.auth/*.json stays cryptographically valid — JWTs are
   * not checked against a revocation list — so most specs never notice. The one
   * that does is root-redirect.spec.ts's rotated-cookie test, which deliberately
   * backdates `expires_at` to force a refresh, and that refresh is exactly what
   * a global sign-out kills.
   *
   * So logging out as `agent` in one spec reds an unrelated spec two files
   * later, with a failure that points at the proxy rather than at the cause.
   * Hence a persona whose session nothing else depends on. Do not reuse it.
   */
  logout: { email: "e2e-logout@tapswipe.test", fullName: "E2E Logout", role: "agent", agentNumber: "9004", territory: null },
} as const;

export type PersonaKey = keyof typeof PERSONAS;

/**
 * Where auth.setup.ts saves each persona's cookies, and where every spec reads
 * them from. Repo-root-relative: Playwright resolves storageState from the cwd,
 * and npm run test:e2e runs from the root.
 *
 * Lives here rather than in auth.setup.ts because Playwright forbids a spec
 * importing a test file — so anything shared between setup and the specs has to
 * sit in a plain module.
 */
export const storageStateFor = (persona: PersonaKey): string =>
  `e2e/.auth/${persona}.json`;

/**
 * The period states the specs exercise. Kept here rather than inline in the
 * specs so a spec names the state it is about ("EMPTY_PERIOD") instead of a
 * bare date whose significance is invisible.
 */
export const PERIODS = {
  /** Many rows, three reps — the scoping and grouping case. */
  many: "2027-04",
  /** Exactly one row, for the singular/plural and one-group case. */
  single: "2027-05",
  /** The value edge cases: null, zero, negative, huge, long text. */
  edge: "2027-03",
  /** Valid format, deliberately no rows — the empty-state case. */
  empty: "2027-09",
} as const;

/** The long merchant name whose nowrap once pushed six money columns off screen. */
export const LONG_MERCHANT_NAME =
  "Extremely Long Merchant Trading Name That Will Not Fit In A Table Cell Without Being Truncated Somehow";

/** The largest value numeric(14,2) holds, and the one StatCard used to clip. */
export const HUGE_FIGURE = 999999999999.99;

/**
 * The API URL and PUBLISHABLE key, for specs that forge a request the way
 * someone with devtools open would.
 *
 * Read from `supabase status` rather than scraped from the page: Next inlines
 * NEXT_PUBLIC_* at build time, so `process.env` does not exist in the browser
 * and `page.evaluate(() => process.env.X)` throws a ReferenceError rather than
 * returning undefined. The service-role key is deliberately NOT exposed here —
 * a spec that could bypass RLS could not prove anything about it.
 */
export function publicStackConfig(): { apiUrl: string; publishableKey: string } {
  const { apiUrl, publishableKey } = localStackConfig();
  return { apiUrl, publishableKey };
}

/**
 * The four owner types documents can hang off, mirroring the check constraint
 * on documents.owner_type and DOCUMENT_OWNER_TYPES in lib/documents.ts.
 */
export const DOC_OWNER_TYPES = [
  "merchant",
  "lead",
  "pre_app",
  "support_ticket",
] as const;

export type DocOwnerType = (typeof DOC_OWNER_TYPES)[number];

/** Where each owner type's detail page lives, for a spec to navigate to. */
export const DOC_OWNER_PATHS: Record<DocOwnerType, string> = {
  merchant: "/merchants",
  lead: "/leads",
  pre_app: "/pre-apps",
  support_ticket: "/support-tickets",
};

/**
 * One record of every document-owning type, per persona.
 *
 * Every persona gets a full set rather than only the ones a spec happens to
 * need, because half the document matrix is "the same page, as somebody else":
 * an agent must be refused another agent's record and an admin must reach it,
 * and both need the *other* persona's record to exist.
 */
export type DocOwnerIds = Record<DocOwnerType, number>;

export type SeedResult = {
  ids: Record<PersonaKey, string>;
  /** The one published marketing material, for the marketing specs. */
  materialId: number;
  /** persona -> owner type -> record id, for the document specs. */
  /** Every persona but `logout`, which owns no records — see PERSONAS. */
  docOwners: Record<Exclude<PersonaKey, "logout">, DocOwnerIds>;
  /** The agent's two-version quote, for the quote print spec. */
  quote: QuoteFixture;
  /** The task rows behind the dashboard digest and the follow-up affordance. */
  tasks: TaskFixture;
  /** The agent's own lead for the timeline spec, with one row per source. */
  timeline: TimelineFixture;
  /** The store catalog: a branded device, what fits it, and what does not. */
  store: StoreFixture;
  /** A saved proposal on the agent's MERCHANT, for the second print route. */
  merchantProposal: MerchantProposalFixture;
  apiUrl: string;
};

/**
 * The catalog the store specs browse, with the ids resolved.
 *
 * Five products rather than two, because each is a different thing the store
 * has to get right and only this combination can tell a working filter from no
 * filter at all:
 *
 *   * `deviceId`          — a branded device. The one a rep adds.
 *   * `otherDeviceId`     — a device of a DIFFERENT brand, so "filter by
 *                           brand" and "filter by type" have something to
 *                           exclude. Without it a filter that returned
 *                           everything would pass.
 *   * `fittingAddonId`    — linked to `deviceId`, and MONTHLY, so it is both
 *                           the compatibility assertion and the monthly half
 *                           of the split.
 *   * `nonFittingAddonId` — linked to `otherDeviceId` only. The assertion that
 *                           matters most: an add-on that exists, is priced,
 *                           and must NOT be offered under `deviceId`. A
 *                           fixture without it would pass against a store that
 *                           ignored product_compatibility entirely.
 *   * `archivedDeviceId`  — live-looking but archived, so "an inactive product
 *                           is hidden" is about a row that is really there.
 */
export type StoreFixture = {
  deviceId: number;
  otherDeviceId: number;
  fittingAddonId: number;
  nonFittingAddonId: number;
  archivedDeviceId: number;
};

/** The agent's merchant, with one saved proposal on it. */
export type MerchantProposalFixture = {
  merchantId: number;
  /** The quote_group_id, which is what the print path is keyed on. */
  groupId: string;
  quoteId: number;
};

/**
 * The store catalog's text and figures, as data both the seed and the specs
 * read.
 *
 * Every name carries the E2E prefix so `ensureStoreCatalog` can converge on it
 * by sku, and so a spec locating by name cannot accidentally match a real
 * product if one is ever added to a dev database.
 *
 * The figures are chosen so the two totals cannot be confused for each other:
 * one device at 400.00 and two monthly add-ons at 25.00 gives $400.00 one-time
 * and $50.00 monthly. Nothing here sums to anything either total could be
 * mistaken for, and no two products share a price.
 */
export const STORE_FIXTURE = {
  brand: "E2E Hardware Co",
  otherBrand: "E2E Rival Co",
  deviceType: "E2E countertop",
  otherDeviceType: "E2E full POS",
  device: {
    sku: "E2E-STORE-TERM",
    name: "E2E Store Terminal",
    price: 400,
  },
  otherDevice: {
    sku: "E2E-STORE-POS",
    name: "E2E Store POS Station",
    price: 1200,
  },
  /** Fits `device`. Monthly, so it is the recurring half of the split. */
  fittingAddon: {
    sku: "E2E-STORE-DOCK",
    name: "E2E Store Charging Dock",
    price: 25,
  },
  /** Fits `otherDevice` ONLY. Must never be offered under `device`. */
  nonFittingAddon: {
    sku: "E2E-STORE-SLEEVE",
    name: "E2E Store POS Sleeve",
    price: 15,
  },
  /** Archived, so it must not appear in the store at all. */
  archivedDevice: {
    sku: "E2E-STORE-OLD",
    name: "E2E Store Retired Terminal",
    price: 99,
  },
  /** The title the proposal specs SAVE under, and clear by. */
  proposalTitle: "E2E store proposal",
  /**
   * The SEEDED merchant proposal's title, and deliberately a different string.
   *
   * It must not be `proposalTitle`: the specs that save a proposal clear by
   * title first, so sharing one would make the lead specs delete the fixture
   * the merchant print spec needs. Found exactly that way — the merchant print
   * test passed in isolation and failed in the file run, which is the shape
   * CLAUDE.md warns is a wrong measurement rather than flaky infrastructure.
   */
  merchantProposalTitle: "E2E seeded merchant proposal",
} as const;

/**
 * A lead of the agent's carrying exactly one row from every timeline source.
 *
 * ## Why a dedicated lead rather than the agent's main one
 *
 * The main lead already has four tasks, two quote versions and documents, so it
 * looks like the cheaper fixture. It is not, for two reasons that bite in
 * different ways:
 *
 *   * marketing.spec.ts calls `clearMarketingEvents(docOwners.agent.lead)` to
 *     get a clean empty state. Specs run in parallel across files, so a
 *     timeline assertion about a marketing event on that lead would pass or
 *     fail on which file got there first.
 *   * Its audit trail is not knowable. The seed's own service-role UPDATEs to
 *     that lead (the follow-up reset, the quote contact re-assert) each fire
 *     log_cross_agent_change() with `auth.uid()` null, so every run leaves
 *     another `cross_agent_update` row behind. Counting audit entries there
 *     means counting how many times anybody has ever run the suite.
 *
 * Same reasoning as `quietLeadId`: a spec's precondition should not depend on
 * another spec's cleanup.
 *
 * ## And why exactly one row per source
 *
 * The spec's claim is about WHICH sources a role can see, not about volume. One
 * row each makes "the admin sees six kinds of event and the rep sees five"
 * countable, and makes the one absent kind unambiguous.
 */
export type TimelineFixture = {
  /** The lead, owned by `agent`. Nothing else in the suite touches it. */
  leadId: number;
  /** Its single quote version, and the group the print link is keyed on. */
  quoteId: number;
  quoteGroupId: string;
};

/**
 * The timeline fixture's text, as data both the seed and the spec read.
 *
 * Every string is distinctive enough to locate by, because the spec asserts on
 * what is RENDERED rather than on row counts — the lead page draws these same
 * rows into five panels as well as into the feed, so a locator scoped to the
 * timeline section plus a unique string is what keeps the two apart.
 */
export const TIMELINE_FIXTURE = {
  dba: "E2E-TIMELINE-agent",
  noteBody: "E2E timeline note — merchant asked about chargeback fees",
  taskTitle: "E2E timeline task — confirm bank letter",
  quoteTitle: "E2E timeline quote",
  docType: "E2E timeline statement",
  docFileName: "e2e-timeline-statement.pdf",
  /**
   * What the admin writes into `lead_source`, which is what makes the audit
   * row exist at all: log_cross_agent_change() fires only when the actor is
   * not the row's `agent_id`, so a rep's own edit leaves no trail and an
   * admin's does. A free-text column nothing else asserts on.
   */
  adminLeadSource: "E2E admin edit",
  /** The status the admin moves the quote to, for the quotes-table audit row. */
  adminQuoteStatus: "accepted",
} as const;

/**
 * The seeded tasks, with the dates resolved.
 *
 * Dates are returned rather than recomputed in a spec: they are offsets from
 * "today", so a spec that worked them out again would be a second clock to
 * disagree with this one — and the whole point of the overdue/upcoming split is
 * which side of today a date falls on.
 */
export type TaskFixture = {
  /** The agent's lead, which carries the overdue and the upcoming task. */
  leadId: number;
  /** The agent's merchant, carrying the one task outside the 7-day window. */
  merchantId: number;
  /**
   * A second lead of the agent's, deliberately carrying no tasks at all.
   *
   * Exists so "the reconciliation block renders nothing" can be asserted on a
   * lead that is simply quiet, rather than by completing the other lead's tasks
   * and putting them back — which would make one spec's precondition depend on
   * another spec's cleanup, and leave the fixture mutated if it failed halfway.
   */
  quietLeadId: number;
  /** YYYY-MM-DD of the agent's earliest OPEN task — the one the button adopts. */
  earliestOpenDue: string;
  /** YYYY-MM-DD of the agent's upcoming task, inside the window. */
  upcomingDue: string;
};

/**
 * Titles and due-date offsets, as data both the seed and the specs read.
 *
 * Four tasks for the agent rather than one, because each is a different thing
 * the digest has to get right, and only the last two can tell a working window
 * from no window at all:
 *
 *   * overdue  — late. Must appear, under Overdue.
 *   * upcoming — inside the 7-day window. Must appear, and not under Overdue.
 *   * distant  — open and dated, well past the window. Must NOT appear.
 *   * done     — completed, and dated EARLIER than overdue. Must not appear,
 *                and must not be picked as "the earliest open task" — which is
 *                the only way to tell a digest that filters on completed from
 *                one that forgot to.
 *
 * The admin gets one of their own so the admin's digest is non-empty, which is
 * what makes "and it does not show the agent's" a real assertion rather than a
 * page that happens to be blank.
 */
export const TASK_FIXTURE = {
  overdue: { title: "E2E overdue pricing call", dueOffset: -3 },
  upcoming: { title: "E2E upcoming paperwork", dueOffset: 2 },
  distant: { title: "E2E distant annual review", dueOffset: 60 },
  done: { title: "E2E already handled callback", dueOffset: -9 },
  adminOwn: { title: "E2E admin own reconciliation", dueOffset: -1 },
} as const;

/**
 * A date `offset` days from today, as YYYY-MM-DD.
 *
 * UTC throughout, matching nextWeekBound() in lib/leads.ts and the Postgres
 * `today` the queries resolve against — both the local stack's database and the
 * Node runtime run UTC, so there is one calendar here rather than two.
 */
export function taskDueDate(offset: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() + offset);
  return date.toISOString().slice(0, 10);
}

/**
 * One quote group on the agent's lead, in two versions.
 *
 * Two rather than one because the print route's whole version story needs a
 * superseded row to be about: "version 1 of 2", the warning that this sheet is
 * not the current offer, and the `?quote=` path that selects it.
 */
export type QuoteFixture = {
  /** The lead it hangs off — docOwners.agent.lead, restated for convenience. */
  leadId: number;
  /** The path segment: quote_group_id, which identifies the document. */
  groupId: string;
  /** Version 1 — superseded. Reached with `?quote=`. */
  firstId: number;
  /** Version 2 — what the bare group URL prints. */
  currentId: number;
};

/**
 * The quote fixture's figures, as data both the seed and the specs read.
 *
 * `price` is what the catalog held WHEN THE QUOTE WAS WRITTEN, and
 * `repricedTo` is what it holds now — the seed bumps both products after the
 * versions are saved. That gap is the point, and it is the only way to prove
 * the snapshot claim from a browser: a printed quote must show `price`, and a
 * page that joined `products` live would show `repricedTo` while looking
 * entirely correct. Nothing else in the suite would notice.
 */
export const QUOTE_FIXTURE = {
  title: "E2E countertop package",
  notes: "E2E terms — 36 month agreement, no early termination fee.",
  products: [
    {
      sku: "E2E-TERM-1",
      name: "E2E Countertop Terminal",
      price: 499,
      repricedTo: 611.25,
    },
    {
      sku: "E2E-PIN-1",
      name: "E2E PIN Pad",
      price: 149.5,
      repricedTo: 203.75,
    },
  ],
  /** Version 1: one terminal. 1 × 499.00 = $499.00. */
  v1: [{ sku: "E2E-TERM-1", quantity: 1 }],
  /** Version 2: 2 × 499.00 + 3 × 149.50 = $1,446.50. */
  v2: [
    { sku: "E2E-TERM-1", quantity: 2 },
    { sku: "E2E-PIN-1", quantity: 3 },
  ],
} as const;

/** The lead's contact, re-asserted by the seed so the quote can print it. */
export const QUOTE_LEAD_CONTACT = {
  contact_name: "E2E Quote Contact",
  contact_phone: "555-0142",
  contact_email: "quotes@e2e-lead.test",
} as const;

/**
 * Read once per process, because reading it is a PROCESS SPAWN.
 *
 * `npx supabase status` costs 2-4 seconds here, and this function has twelve
 * call sites — several of them inside `expect.poll` loops, where it was being
 * spawned once per poll iteration. That is what made
 * `documents-panel.spec.ts`'s two-tabs test marginal against the 30s per-test
 * timeout: it calls documentRows() twice and then polls storageObjectExists()
 * for up to ten seconds per file, so most of its wall clock was `npx` starting
 * up, not Storage being slow. Measured at ~1 failure in 3 in isolation before
 * this, with passing runs landing at 23-29s against a 30s budget.
 *
 * Safe to cache: the stack's ports and keys cannot change while a suite is
 * running — a `supabase stop` mid-run breaks the suite far more loudly than a
 * stale cache would. The non-local guard below still runs, on the first call,
 * which is the only call that could be wrong about it.
 */
type StackConfig = {
  apiUrl: string;
  serviceKey: string;
  publishableKey: string;
};

let cachedStackConfig: StackConfig | null = null;

function localStackConfig(): StackConfig {
  if (cachedStackConfig !== null) return cachedStackConfig;

  const raw = execSync("npx supabase status -o env", { encoding: "utf8" });
  const cfg = new Map<string, string>();
  for (const line of raw.split(/\r?\n/)) {
    const match = /^([A-Z0-9_]+)="?(.*?)"?$/.exec(line.trim());
    if (match) cfg.set(match[1], match[2]);
  }

  const apiUrl = cfg.get("API_URL");
  const serviceKey = cfg.get("SERVICE_ROLE_KEY");
  // Taken from the SAME output rather than by spawning `supabase status` a
  // second time, which is what publicStackConfig() used to do. The memoisation
  // note above is the whole reason: the cost of this function is the process
  // spawn, so a second reader of the same text must not pay for it twice.
  const publishableKey = cfg.get("PUBLISHABLE_KEY");
  if (!apiUrl || !serviceKey || !publishableKey) {
    throw new Error(
      "Local Supabase stack is not running. Start it with `npx supabase start`.",
    );
  }
  if (!/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(apiUrl)) {
    throw new Error(`Refusing to seed a non-local host: ${apiUrl}`);
  }

  cachedStackConfig = { apiUrl, serviceKey, publishableKey };
  return cachedStackConfig;
}

async function ensurePersona(
  db: SupabaseClient,
  key: PersonaKey,
): Promise<string> {
  const persona = PERSONAS[key];

  const { data: existing } = await db.auth.admin.listUsers({ perPage: 1000 });
  const found = (existing?.users ?? []).find((u) => u.email === persona.email);

  if (found) {
    // Re-assert the profile so a half-provisioned run from a previous failure
    // converges rather than persisting. agent_number in particular is what the
    // period page renders beside the rep's name.
    const { error } = await db
      .from("profiles")
      .update({
        full_name: persona.fullName,
        role: persona.role,
        is_active: true,
        must_change_password: false,
        agent_number: persona.agentNumber,
        // Re-asserted rather than set only on creation, for the reason
        // agent_number is: a persona provisioned before this column was part of
        // the fixture would otherwise keep a null territory forever, and the
        // dashboard's territory filter would quietly have nothing to select.
        territory: persona.territory,
      })
      .eq("id", found.id);
    if (error) throw new Error(`${persona.email} profile: ${error.message}`);
    return found.id;
  }

  const { data, error } = await db.auth.admin.createUser({
    email: persona.email,
    password: E2E_PASSWORD,
    email_confirm: true,
  });
  if (error || !data.user) {
    throw new Error(`${persona.email}: ${error?.message ?? "no user"}`);
  }

  // profiles has no insert policy — rows are created by service role alongside
  // auth.users, exactly as the create-user Edge Function does it.
  const { error: profileError } = await db.from("profiles").insert({
    id: data.user.id,
    full_name: persona.fullName,
    email: data.user.email,
    role: persona.role,
    is_active: true,
    must_change_password: false,
    agent_number: persona.agentNumber,
    territory: persona.territory,
  });
  if (profileError) {
    // Half an account is the ghost-user state lib/auth.ts routes to
    // /auth/error?error=no-profile. Undo rather than leave one behind.
    await db.auth.admin.deleteUser(data.user.id);
    throw new Error(`${persona.email} profile: ${profileError.message}`);
  }

  return data.user.id;
}

const firstOfMonth = (period: string) => `${period}-01`;

type LedgerRow = {
  agent_id: string;
  period: string;
  mid: string;
  merchant_name: string | null;
  volume: number | null;
  average_ticket: number | null;
  total_cost: number | null;
  residual_income: number | null;
  rep_split_pct: number | null;
};

function ledgerRows(ids: Record<PersonaKey, string>): LedgerRow[] {
  const rows: LedgerRow[] = [];

  // --- many: three reps, so "an agent sees only their own" can actually fail.
  for (let i = 0; i < 6; i += 1) {
    rows.push({
      agent_id: ids.agent, period: firstOfMonth(PERIODS.many),
      mid: `E2E-A${1000 + i}`, merchant_name: `E2E Agent Merchant ${i + 1}`,
      volume: 10000 + i * 100, average_ticket: 40, total_cost: 300,
      residual_income: 500 + i * 10, rep_split_pct: 55,
    });
  }
  for (let i = 0; i < 4; i += 1) {
    rows.push({
      agent_id: ids.agent2, period: firstOfMonth(PERIODS.many),
      mid: `E2E-B${2000 + i}`, merchant_name: `E2E Agent Two Merchant ${i + 1}`,
      volume: 8000, average_ticket: 30, total_cost: 200,
      residual_income: 400, rep_split_pct: 50,
    });
  }
  rows.push({
    agent_id: ids.admin, period: firstOfMonth(PERIODS.many),
    mid: "E2E-C3000", merchant_name: "E2E Admin Merchant",
    volume: 25000, average_ticket: 99, total_cost: 900,
    residual_income: 1200, rep_split_pct: 60,
  });
  // The long-name regression lives HERE, in a period of otherwise ordinary
  // figures, and deliberately not only in the edge period. The edge period also
  // contains a trillion-dollar row, which makes that table genuinely wider than
  // the viewport on its own — so an "all columns visible" assertion there would
  // be testing two variables at once and would fail for the wrong reason. With
  // normal figures alongside it, a long name is the only thing that could push
  // the money columns off screen, which is exactly the bug.
  rows.push({
    agent_id: ids.agent, period: firstOfMonth(PERIODS.many),
    mid: "E2E-A-LONGNAME", merchant_name: LONG_MERCHANT_NAME,
    volume: 9000, average_ticket: 35, total_cost: 250,
    residual_income: 450, rep_split_pct: 55,
  });

  // --- single: exactly one row, one group.
  rows.push({
    agent_id: ids.agent, period: firstOfMonth(PERIODS.single),
    mid: "E2E-SOLO", merchant_name: "E2E Only Merchant",
    volume: 1234.56, average_ticket: 12.34, total_cost: 100,
    residual_income: 250.5, rep_split_pct: 55,
  });

  // --- edge: one row per value case the ledger can actually hold.
  const edge: Omit<LedgerRow, "agent_id" | "period">[] = [
    { mid: "E2E-NULL-BOTH", merchant_name: "Both figures null",
      volume: 5000, average_ticket: 20, total_cost: 100,
      residual_income: null, rep_split_pct: null },
    { mid: "E2E-ZERO", merchant_name: "All zeroes",
      volume: 0, average_ticket: 0, total_cost: 0,
      residual_income: 0, rep_split_pct: 0 },
    { mid: "E2E-ZERO-SPLIT", merchant_name: "Zero split real residual",
      volume: 900, average_ticket: 9, total_cost: 9,
      residual_income: 750.25, rep_split_pct: 0 },
    { mid: "E2E-CLAWBACK", merchant_name: "Clawback month",
      volume: 0, average_ticket: 0, total_cost: -450.75,
      residual_income: -820.4, rep_split_pct: 55 },
    { mid: "E2E-HUGE", merchant_name: "Enormous figures",
      volume: HUGE_FIGURE, average_ticket: HUGE_FIGURE,
      total_cost: HUGE_FIGURE, residual_income: HUGE_FIGURE,
      rep_split_pct: 100 },
    // Postgres rounds these to the column's scale on the way in, which is what
    // makes "more precision than the UI expects" unreachable from the database.
    { mid: "E2E-PRECISION", merchant_name: "Over-precise input",
      volume: 1234.5678, average_ticket: 9.876543,
      total_cost: 0.005, residual_income: 88.4567, rep_split_pct: 33.333 },
    { mid: "E2E-NULL-NAME", merchant_name: null,
      volume: 700, average_ticket: 7, total_cost: 70,
      residual_income: 70, rep_split_pct: 50 },
    { mid: "E2E-INJECTION", merchant_name: "<script>alert('xss')</script>",
      volume: 700, average_ticket: 7, total_cost: 70,
      residual_income: 70, rep_split_pct: 50 },
    { mid: "E2E-LONG-NAME", merchant_name: LONG_MERCHANT_NAME,
      volume: 700, average_ticket: 7, total_cost: 70,
      residual_income: 70, rep_split_pct: 50 },
  ];
  for (const row of edge) {
    rows.push({ agent_id: ids.agent, period: firstOfMonth(PERIODS.edge), ...row });
  }
  // One edge-period row for the other rep, so the edge period is also a
  // scoping case rather than only a rendering one.
  rows.push({
    agent_id: ids.agent2, period: firstOfMonth(PERIODS.edge),
    mid: "E2E-OTHER-REP", merchant_name: "Belongs to agent two",
    volume: 100, average_ticket: 1, total_cost: 10,
    residual_income: 10, rep_split_pct: 50,
  });

  return rows;
}

/**
 * Provision everything the specs need. Safe to call repeatedly.
 *
 * The five payout tables are cleared only for the periods this suite owns, so
 * running it does not wipe whatever an operator has been looking at in the dev
 * database — the periods are deliberately in 2027 to keep them out of the way of
 * the seed-dev scripts' 2026.
 */
export async function seedE2E(): Promise<SeedResult> {
  const { apiUrl, serviceKey } = localStackConfig();
  const db = createClient(apiUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const ids = {
    admin: await ensurePersona(db, "admin"),
    agent: await ensurePersona(db, "agent"),
    agent2: await ensurePersona(db, "agent2"),
    logout: await ensurePersona(db, "logout"),
  } satisfies Record<PersonaKey, string>;

  const ownedPeriods = Object.values(PERIODS).map(firstOfMonth);

  // History first: rep_payout_row_history.row_id references the ledger, and the
  // FK is NO ACTION — the same five-door trap CLAUDE.md documents for deleting
  // a user. Deleting rows without clearing history fails on the FK.
  const { data: doomed } = await db
    .from("rep_payout_rows")
    .select("id")
    .in("period", ownedPeriods);
  const doomedIds = (doomed ?? []).map((r) => r.id as number);
  if (doomedIds.length > 0) {
    await db.from("rep_payout_row_history").delete().in("row_id", doomedIds);
  }
  await db.from("rep_payout_rows").delete().in("period", ownedPeriods);

  const rows = ledgerRows(ids);
  const { error } = await db.from("rep_payout_rows").insert(rows);
  if (error) throw new Error(`ledger seed: ${error.message}`);

  // Events from previous runs, cleared before the specs add more. They are
  // append-only by design — no UPDATE or DELETE grant for `authenticated` —
  // so this runs as the service role, which bypasses both. Without it the
  // "sent to this lead" assertions would be reading an ever-growing pile from
  // every run that came before.
  await db
    .from("marketing_material_events")
    .delete()
    .in("agent_id", Object.values(ids));

  const docOwners = {
    admin: await ensureDocOwners(db, "admin", ids.admin),
    agent: await ensureDocOwners(db, "agent", ids.agent),
    agent2: await ensureDocOwners(db, "agent2", ids.agent2),
    // No entry for `logout`, and the Exclude says so out loud rather than
    // leaving a reader to wonder whether it was forgotten. That persona exists
    // to be signed out; it opens no records, so seeding it a merchant, a lead,
    // a pre-app and a ticket on every run would be four rows nothing reads.
  } satisfies Record<Exclude<PersonaKey, "logout">, DocOwnerIds>;

  await ensureDocumentsBucket(db);
  const materialId = await ensureMarketingMaterial(db, ids.admin);
  const quote = await ensureQuote(db, ids.agent, docOwners.agent.lead);
  const tasks = await ensureTasks(db, ids, docOwners);
  await ensureReportingLine(db, ids);
  // After ensureQuote, which is what guarantees the catalog product this
  // fixture's own quote is built from.
  const timeline = await ensureTimelineLead(db, ids, materialId);
  const store = await ensureStoreCatalog(db);
  const merchantProposal = await ensureMerchantProposal(
    db,
    ids.agent,
    docOwners.agent.merchant,
    store,
  );

  return {
    ids,
    docOwners,
    materialId,
    quote,
    tasks,
    timeline,
    store,
    merchantProposal,
    apiUrl,
  };
}

/**
 * The store's catalog: two devices of different brands, two add-ons of which
 * only one fits the first device, and an archived device.
 *
 * Converges by sku rather than truncating, like ensureQuote's products: the
 * catalog is referenced by quote_line_items.product_id, and a truncate would
 * cascade every historical proposal line away — including the ones other
 * specs assert on.
 *
 * COMPATIBILITY IS REWRITTEN each run, which the products are not. The links
 * are the thing a spec asserts a negative about ("the sleeve is not offered
 * under the terminal"), so a stale row from an earlier shape of this fixture
 * would make that assertion pass or fail on history. Deleting by addon id is
 * enough: product_compatibility allows DELETE for exactly this kind of
 * current-state correction, and the two add-ons here own no other links.
 */
async function ensureStoreCatalog(db: SupabaseClient): Promise<StoreFixture> {
  // products.brand is a foreign key to brands(name), so both brands must
  // exist before a product can name them. Upserted on the name, which is the
  // FK target and the unique column.
  const { error: brandError } = await db
    .from("brands")
    .upsert(
      [{ name: STORE_FIXTURE.brand }, { name: STORE_FIXTURE.otherBrand }],
      { onConflict: "name", ignoreDuplicates: true },
    );
  if (brandError) throw new Error(`store brands: ${brandError.message}`);

  const upsert = async (spec: {
    sku: string;
    name: string;
    price: number;
    brand: string | null;
    category: string;
    kind: "device" | "addon";
    billing: "one_time" | "monthly";
    archived: boolean;
  }): Promise<number> => {
    const row = {
      name: spec.name,
      sku: spec.sku,
      category: spec.category,
      brand: spec.brand,
      kind: spec.kind,
      billing: spec.billing,
      list_price: spec.price,
      // Re-asserted both ways on every run, so a spec that archived something
      // by hand (or a half-finished revert experiment) does not leak into the
      // next run as a product that silently is not in the store.
      archived_at: spec.archived ? new Date().toISOString() : null,
    };

    const { data: existing } = await db
      .from("products")
      .select("id")
      .eq("sku", spec.sku)
      .maybeSingle();

    if (existing) {
      const { error } = await db
        .from("products")
        .update(row)
        .eq("id", existing.id as number);
      if (error) throw new Error(`store product ${spec.sku}: ${error.message}`);
      return existing.id as number;
    }

    const { data, error } = await db
      .from("products")
      .insert(row)
      .select("id")
      .single();
    if (error || !data) {
      throw new Error(`store product ${spec.sku}: ${error?.message ?? "no row"}`);
    }
    return data.id as number;
  };

  const deviceId = await upsert({
    ...STORE_FIXTURE.device,
    brand: STORE_FIXTURE.brand,
    category: STORE_FIXTURE.deviceType,
    kind: "device",
    billing: "one_time",
    archived: false,
  });

  const otherDeviceId = await upsert({
    ...STORE_FIXTURE.otherDevice,
    brand: STORE_FIXTURE.otherBrand,
    category: STORE_FIXTURE.otherDeviceType,
    kind: "device",
    billing: "one_time",
    archived: false,
  });

  const fittingAddonId = await upsert({
    ...STORE_FIXTURE.fittingAddon,
    brand: STORE_FIXTURE.brand,
    category: STORE_FIXTURE.deviceType,
    kind: "addon",
    // MONTHLY, so this add-on is both the compatibility assertion and the
    // recurring half of the two totals.
    billing: "monthly",
    archived: false,
  });

  const nonFittingAddonId = await upsert({
    ...STORE_FIXTURE.nonFittingAddon,
    brand: STORE_FIXTURE.otherBrand,
    category: STORE_FIXTURE.otherDeviceType,
    kind: "addon",
    billing: "one_time",
    archived: false,
  });

  const archivedDeviceId = await upsert({
    ...STORE_FIXTURE.archivedDevice,
    brand: STORE_FIXTURE.brand,
    category: STORE_FIXTURE.deviceType,
    kind: "device",
    billing: "one_time",
    archived: true,
  });

  // Rewritten, not topped up — see the header.
  await db
    .from("product_compatibility")
    .delete()
    .in("addon_product_id", [fittingAddonId, nonFittingAddonId]);

  const { error } = await db.from("product_compatibility").insert([
    { addon_product_id: fittingAddonId, device_product_id: deviceId },
    // The sleeve fits the OTHER device only. That asymmetry is what makes "a
    // non-fitting add-on is not offered" a real assertion rather than a
    // statement about an empty table.
    { addon_product_id: nonFittingAddonId, device_product_id: otherDeviceId },
  ]);
  if (error) throw new Error(`store compatibility: ${error.message}`);

  return {
    deviceId,
    otherDeviceId,
    fittingAddonId,
    nonFittingAddonId,
    archivedDeviceId,
  };
}

/**
 * One saved proposal on the agent's MERCHANT — a device with its add-on.
 *
 * Exists so /merchants/[id]/quotes/[quoteGroupId]/print has something real to
 * render without a spec having to build one first. Written through
 * `create_quote_version()` rather than by inserting the rows, for the reason
 * ensureQuote does it that way: the RPC assigns the version, takes the price
 * snapshot and writes sort_order from the array's order — and that order IS
 * the device/add-on grouping the printed sheet reads back, so a hand-inserted
 * fixture would be testing a shape the app never produces.
 *
 * Deleted and rewritten each run, matched on merchant_id + title: the lines
 * snapshot a price, and a row surviving from an earlier version of this
 * fixture would carry figures the spec no longer expects.
 */
async function ensureMerchantProposal(
  db: SupabaseClient,
  agentId: string,
  merchantId: number,
  store: StoreFixture,
): Promise<MerchantProposalFixture> {
  await db
    .from("quotes")
    .delete()
    .eq("merchant_id", merchantId)
    .eq("title", STORE_FIXTURE.merchantProposalTitle);

  const { data: quoteId, error } = await db.rpc("create_quote_version", {
    // merchant_id, lead_id null — exactly one owner, which is what
    // quotes_exactly_one_owner requires and what this fixture exists to
    // exercise from the browser.
    lead_id_input: null,
    merchant_id_input: merchantId,
    agent_id_input: agentId,
    quote_group_id_input: null,
    status_input: "sent",
    title_input: STORE_FIXTURE.merchantProposalTitle,
    notes_input: null,
    line_items_input: [
      { product_id: store.deviceId, quantity: 1 },
      { product_id: store.fittingAddonId, quantity: 2 },
    ],
  });
  if (error || typeof quoteId !== "number") {
    throw new Error(`merchant proposal: ${error?.message ?? "no id"}`);
  }

  const { data: row, error: groupError } = await db
    .from("quotes")
    .select("quote_group_id")
    .eq("id", quoteId)
    .single();
  if (groupError || !row) {
    throw new Error(`merchant proposal group: ${groupError?.message ?? "no row"}`);
  }

  return {
    merchantId,
    groupId: row.quote_group_id as string,
    quoteId,
  };
}

/**
 * One reporting line, for the dashboard's manager filter.
 *
 * `agent2` plays the manager: `agent` reports to them, and they report to
 * nobody. That is the one-hop shape set_manager() enforces, written directly
 * here because this runs as the service role and profiles has no update policy
 * at all — the same reason every other field in this file is set this way.
 *
 * Re-asserted every run rather than set once. manager_id is `on delete set
 * null`, and it is the one profiles column another persona's teardown can clear
 * without touching this row: a seeded reporting line can vanish with nothing
 * reporting that it happened, which is exactly the failure the four teardown
 * lists' manager_id entries exist to make visible.
 *
 * NOTE what this does NOT do. It grants nothing. No policy reads manager_id, so
 * `agent2` sees no more of `agent`'s book than before. The line exists only so
 * an ADMIN has a manager to filter their own already-complete view by.
 */
async function ensureReportingLine(
  db: SupabaseClient,
  ids: Record<PersonaKey, string>,
): Promise<void> {
  const { error: clearError } = await db
    .from("profiles")
    .update({ manager_id: null })
    .in("id", [ids.admin, ids.agent2, ids.logout]);
  if (clearError) throw new Error(`clear manager: ${clearError.message}`);

  const { error } = await db
    .from("profiles")
    .update({ manager_id: ids.agent2 })
    .eq("id", ids.agent);
  if (error) throw new Error(`reporting line: ${error.message}`);
}

/**
 * The agent's four tasks and the admin's one, with the agent's lead reset to
 * carrying no follow-up date.
 *
 * Deleted and rewritten every run rather than topped up, like the quote: the
 * due dates are offsets from today, so a row left behind from yesterday is a
 * task whose date has quietly moved relative to the window the specs assert on.
 * Matched by title, which is why every title here carries the E2E prefix.
 *
 * The next_followup_date reset is the load-bearing line. The affordance spec
 * CLICKS a button that sets that column, so without this the second run of the
 * suite would start with the lead already reconciled and the button already
 * gone — the spec would fail, correctly, for a reason that has nothing to do
 * with the app. ensureQuote's lead update cannot carry it: the two want the
 * lead in different states, and keeping the reset beside the tasks keeps the
 * reason beside the thing it is about.
 */
async function ensureTasks(
  db: SupabaseClient,
  ids: Record<PersonaKey, string>,
  docOwners: Record<Exclude<PersonaKey, "logout">, DocOwnerIds>,
): Promise<TaskFixture> {
  const quietLeadId = await ensureQuietLead(db, ids.agent);

  const titles = Object.values(TASK_FIXTURE).map((task) => task.title);
  const { error: clearError } = await db
    .from("tasks")
    .delete()
    .in("title", titles);
  if (clearError) throw new Error(`clear tasks: ${clearError.message}`);

  const onAgentLead = {
    agent_id: ids.agent,
    owner_type: "lead",
    owner_id: docOwners.agent.lead,
  };

  const { error } = await db.from("tasks").insert([
    {
      ...onAgentLead,
      title: TASK_FIXTURE.overdue.title,
      due_date: taskDueDate(TASK_FIXTURE.overdue.dueOffset),
      completed: false,
    },
    {
      ...onAgentLead,
      title: TASK_FIXTURE.upcoming.title,
      due_date: taskDueDate(TASK_FIXTURE.upcoming.dueOffset),
      completed: false,
    },
    {
      ...onAgentLead,
      title: TASK_FIXTURE.done.title,
      due_date: taskDueDate(TASK_FIXTURE.done.dueOffset),
      completed: true,
    },
    // On the MERCHANT, not the lead: a task outside the window should be absent
    // from the digest wherever it hangs, and putting it on another owner type
    // also means the digest's owner resolution is exercised by more than one.
    {
      agent_id: ids.agent,
      owner_type: "merchant",
      owner_id: docOwners.agent.merchant,
      title: TASK_FIXTURE.distant.title,
      due_date: taskDueDate(TASK_FIXTURE.distant.dueOffset),
      completed: false,
    },
    {
      agent_id: ids.admin,
      owner_type: "lead",
      owner_id: docOwners.admin.lead,
      title: TASK_FIXTURE.adminOwn.title,
      due_date: taskDueDate(TASK_FIXTURE.adminOwn.dueOffset),
      completed: false,
    },
  ]);
  if (error) throw new Error(`task seed: ${error.message}`);

  const { error: leadError } = await db
    .from("leads")
    .update({ next_followup_date: null })
    .eq("id", docOwners.agent.lead);
  if (leadError) throw new Error(`lead follow-up reset: ${leadError.message}`);

  return {
    leadId: docOwners.agent.lead,
    merchantId: docOwners.agent.merchant,
    quietLeadId,
    earliestOpenDue: taskDueDate(TASK_FIXTURE.overdue.dueOffset),
    upcomingDue: taskDueDate(TASK_FIXTURE.upcoming.dueOffset),
  };
}

/** The agent's second lead: no tasks, ever. Created once, then reused. */
async function ensureQuietLead(
  db: SupabaseClient,
  agentId: string,
): Promise<number> {
  const dba = "E2E-QUIET-agent";

  const { data: existing } = await db
    .from("leads")
    .select("id")
    .eq("agent_id", agentId)
    .eq("dba", dba)
    .maybeSingle();
  if (existing) return existing.id as number;

  const { data, error } = await db
    .from("leads")
    .insert({
      agent_id: agentId,
      dba,
      merchant_legal_name: "E2E Quiet Lead LLC",
      // 'new' for the reason ensureDocOwners gives: leads_status_vocabulary
      // retired 'open', and that only bites on a freshly reset database.
      status: "new",
      lead_source: "E2E",
    })
    .select("id")
    .single();
  if (error || !data) {
    throw new Error(`quiet lead: ${error?.message ?? "no row"}`);
  }
  return data.id as number;
}

/**
 * The timeline lead: one row from every source, and a knowable audit trail.
 *
 * Children are DELETED AND REWRITTEN each run rather than topped up, like
 * ensureTasks and ensureQuote. The reason is sharper here than for either of
 * them: the spec counts entries per source, so a row surviving from a previous
 * run turns "one note" into "one note per run anybody has ever done".
 *
 * ## The audit rows, which are the point of the whole fixture
 *
 * `log_cross_agent_change()` writes to `audit_log` only when `auth.uid()` is
 * not the row's `agent_id`. So:
 *
 *   * a rep editing their own lead leaves NO trail — which is why the five
 *     service-role inserts below cannot be the source of the audit rows this
 *     spec is about. They DO each write one (service role has no `auth.uid()`,
 *     so `actor_id` lands null), which is exactly why the trail is cleared
 *     after them and before the admin acts;
 *   * an admin editing a rep's lead leaves one row, attributed to the admin.
 *
 * That second case is seeded by signing in as the admin persona and making two
 * real writes — one on the lead, one on its quote's `status`. Going through a
 * genuine JWT rather than inserting into `audit_log` directly matters: an
 * inserted row would prove only that the page can render a row, while this
 * proves the whole chain the admin's view depends on. `audit_log` has no
 * INSERT policy in any case, so a client could not fabricate one.
 *
 * Two tables rather than one because the feed resolves audit rows on the
 * (table_name, row_id) PAIR, and a fixture with only `leads` rows would pass
 * identically against a version that matched on `row_id` alone.
 */
async function ensureTimelineLead(
  db: SupabaseClient,
  ids: Record<PersonaKey, string>,
  materialId: number,
): Promise<TimelineFixture> {
  const leadId = await ensureTimelineLeadRow(db, ids.agent);

  const onLead = {
    agent_id: ids.agent,
    owner_type: "lead" as const,
    owner_id: leadId,
  };

  // Notes are append-only to `authenticated` (no UPDATE policy, and since
  // 20260812143407 no UPDATE grant either), so a fixture can only converge by
  // deleting and rewriting — as the service role, which bypasses both.
  await db.from("notes").delete().eq("owner_type", "lead").eq("owner_id", leadId);
  const { error: noteError } = await db
    .from("notes")
    .insert({ ...onLead, body: TIMELINE_FIXTURE.noteBody });
  if (noteError) throw new Error(`timeline note: ${noteError.message}`);

  await db.from("tasks").delete().eq("owner_type", "lead").eq("owner_id", leadId);
  const { error: taskError } = await db.from("tasks").insert({
    ...onLead,
    title: TIMELINE_FIXTURE.taskTitle,
    // Dated, so the entry's detail carries a due date and the "a task is
    // placed at its CREATION, not its due date" claim has something to be
    // about. Far enough out that it never lands in the dashboard digest's
    // 7-day window and starts affecting followups.spec.ts.
    due_date: taskDueDate(120),
    completed: false,
  });
  if (taskError) throw new Error(`timeline task: ${taskError.message}`);

  // One document, metadata AND bytes. The row alone would render the timeline
  // entry perfectly well, but it is also the orphan state delete-document's
  // file_key mode exists to clean up, and leaving one permanently in the
  // fixtures is how a real orphan stops being noticeable.
  //
  // The key shape is not cosmetic: documents_file_key_matches_owner requires
  // `{agent_id}/{owner_type}/{owner_id}/` and EXACTLY four segments, and the
  // constraint is NOT VALID only for rows that already existed — a new insert
  // is checked. Deterministic rather than a uuid, so re-running upserts the
  // same object instead of accumulating one per run.
  const fileKey = `${ids.agent}/lead/${leadId}/e2e-timeline-doc`;
  await db.from("documents").delete().eq("file_key", fileKey);
  const { error: uploadError } = await db.storage
    .from("documents")
    .upload(fileKey, new Blob(["E2E timeline statement"]), {
      contentType: "application/pdf",
      upsert: true,
    });
  if (uploadError) throw new Error(`timeline doc bytes: ${uploadError.message}`);
  const { error: docError } = await db.from("documents").insert({
    ...onLead,
    doc_type: TIMELINE_FIXTURE.docType,
    file_key: fileKey,
    file_name: TIMELINE_FIXTURE.docFileName,
    mime_type: "application/pdf",
  });
  if (docError) throw new Error(`timeline doc: ${docError.message}`);

  // One marketing event, on THIS lead. marketing.spec.ts clears events on the
  // agent's main lead, which is half of why this fixture has a lead of its own.
  await db.from("marketing_material_events").delete().eq("lead_id", leadId);
  const { error: eventError } = await db
    .from("marketing_material_events")
    .insert({
      material_id: materialId,
      lead_id: leadId,
      agent_id: ids.agent,
      event_type: "viewed",
    });
  if (eventError) throw new Error(`timeline event: ${eventError.message}`);

  // One quote version. Built from the catalog product ensureQuote guarantees,
  // which is why this helper runs after it.
  const { data: product, error: productError } = await db
    .from("products")
    .select("id")
    .eq("sku", QUOTE_FIXTURE.products[0].sku)
    .single();
  if (productError || !product) {
    throw new Error(`timeline product: ${productError?.message ?? "no row"}`);
  }

  await db
    .from("quotes")
    .delete()
    .eq("lead_id", leadId)
    .eq("title", TIMELINE_FIXTURE.quoteTitle);

  const { data: quoteId, error: quoteError } = await db.rpc(
    "create_quote_version",
    {
      lead_id_input: leadId,
      // Explicit null, because neither owner argument has a default: the
      // signature makes a caller say which record a proposal is about rather
      // than letting them pass neither and get a constraint violation.
      merchant_id_input: null,
      agent_id_input: ids.agent,
      quote_group_id_input: null,
      status_input: "sent",
      title_input: TIMELINE_FIXTURE.quoteTitle,
      notes_input: null,
      line_items_input: [{ product_id: product.id as number, quantity: 1 }],
    },
  );
  if (quoteError || typeof quoteId !== "number") {
    throw new Error(`timeline quote: ${quoteError?.message ?? "no id"}`);
  }

  const { data: quoteRow, error: groupError } = await db
    .from("quotes")
    .select("quote_group_id")
    .eq("id", quoteId)
    .single();
  if (groupError || !quoteRow) {
    throw new Error(`timeline quote group: ${groupError?.message ?? "no row"}`);
  }

  // Everything above ran as the service role, so each insert left a
  // `cross_agent_insert` row with a null actor. Cleared here — AFTER the
  // writes, which is the ordering the whole fixture depends on — so the only
  // audit rows left are the two the admin is about to make.
  await clearTimelineAudit(db, leadId, quoteId);
  await stampAdminTimelineEdits(leadId, quoteId);

  return {
    leadId,
    quoteId,
    quoteGroupId: quoteRow.quote_group_id as string,
  };
}

/** The timeline lead itself. Created once, then reused — like the quiet lead. */
async function ensureTimelineLeadRow(
  db: SupabaseClient,
  agentId: string,
): Promise<number> {
  const { data: existing } = await db
    .from("leads")
    .select("id")
    .eq("agent_id", agentId)
    .eq("dba", TIMELINE_FIXTURE.dba)
    .maybeSingle();
  if (existing) return existing.id as number;

  const { data, error } = await db
    .from("leads")
    .insert({
      agent_id: agentId,
      dba: TIMELINE_FIXTURE.dba,
      merchant_legal_name: "E2E Timeline Lead LLC",
      // 'new' for the reason ensureDocOwners gives: leads_status_vocabulary
      // retired 'open', and that only bites on a freshly reset database.
      status: "new",
      lead_source: "E2E",
    })
    .select("id")
    .single();
  if (error || !data) {
    throw new Error(`timeline lead: ${error?.message ?? "no row"}`);
  }
  return data.id as number;
}

/**
 * Wipes the lead's and its quote's audit rows.
 *
 * Service role, because `audit_log` grants `authenticated` SELECT only — there
 * is no client delete path and there should not be. Scoped to the (table_name,
 * row_id) pairs this fixture owns rather than by actor: a blanket wipe would
 * take out rows other specs' admins had written, and `row_id` is text so the
 * table has to be named alongside it.
 */
async function clearTimelineAudit(
  db: SupabaseClient,
  leadId: number,
  quoteId: number,
): Promise<void> {
  await db
    .from("audit_log")
    .delete()
    .eq("table_name", "leads")
    .eq("row_id", String(leadId));
  await db
    .from("audit_log")
    .delete()
    .eq("table_name", "quotes")
    .eq("row_id", String(quoteId));
}

/**
 * Two admin writes on the agent's lead, as the admin, through a real JWT.
 *
 * This is the only place the seed acts as somebody rather than as the service
 * role, and it has to: `log_cross_agent_change()` reads `auth.uid()`, so a
 * service-role write produces a row with `actor_id` null and no name to render.
 * The claim the spec makes — an admin sees an attributed trail of what was done
 * to a rep's record — cannot be fixtured any other way.
 *
 * `persistSession: false` and NO signOut. supabase-js's `signOut()` defaults to
 * `scope: "global"`, which would revoke the admin's refresh tokens on every
 * device — including the session auth.setup.ts stored for every admin spec in
 * the suite. That is the trap PERSONAS.logout exists for, and here it would
 * fire in the seed, so every file would carry it.
 */
async function stampAdminTimelineEdits(
  leadId: number,
  quoteId: number,
): Promise<void> {
  const { apiUrl, publishableKey } = publicStackConfig();
  const asAdmin = createClient(apiUrl, publishableKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { error: signInError } = await asAdmin.auth.signInWithPassword({
    email: PERSONAS.admin.email,
    password: E2E_PASSWORD,
  });
  if (signInError) throw new Error(`timeline admin sign-in: ${signInError.message}`);

  // The lead: an ordinary UPDATE an admin is allowed by `update own or admin`,
  // on a free-text column nothing else asserts on.
  const { error: leadError } = await asAdmin
    .from("leads")
    .update({ lead_source: TIMELINE_FIXTURE.adminLeadSource })
    .eq("id", leadId);
  if (leadError) throw new Error(`timeline admin lead edit: ${leadError.message}`);

  // The quote: `status` is the ONLY column `authenticated` may update on
  // quotes, and the privilege is column-level — an attempt on `title` would
  // fail with `permission denied for column` before RLS was consulted. So this
  // is both a realistic admin action and the only one available.
  const { error: quoteError } = await asAdmin
    .from("quotes")
    .update({ status: TIMELINE_FIXTURE.adminQuoteStatus })
    .eq("id", quoteId);
  if (quoteError) {
    throw new Error(`timeline admin quote edit: ${quoteError.message}`);
  }
}

/**
 * One lead's stored next_followup_date, straight from the column.
 *
 * The follow-up affordance's claim is that a click WRITES that column — the
 * rendered page afterwards is a consequence, and a component that re-rendered
 * its own optimistic state without saving anything would look identical. Read
 * as the service role for the reason the other helpers here are: a spec holds
 * no key and should not grow one.
 */
export async function leadFollowupDate(
  leadId: number,
): Promise<string | null> {
  const { apiUrl, serviceKey } = localStackConfig();
  const db = createClient(apiUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await db
    .from("leads")
    .select("next_followup_date")
    .eq("id", leadId)
    .single();
  if (error) throw new Error(`lead follow-up read: ${error.message}`);
  return (data?.next_followup_date as string | null) ?? null;
}

/**
 * The agent's quote, in two versions, with the catalog repriced underneath it.
 *
 * Written through create_quote_version() rather than by inserting the rows
 * directly, so the fixture takes its snapshot the same way the app does — off
 * the catalog, inside the transaction — and the version numbers come from
 * quotes_enforce_version() rather than from this file's idea of them. A
 * hand-built fixture here could hold a price the RPC would never have written,
 * which is the one thing the specs below are checking.
 *
 * Deleted and rewritten every run rather than reused, like the payout rows:
 * quotes are append-only, so a "top up if missing" version would add a third
 * version on the second run and a fourth on the third, and the specs assert
 * "version 1 of 2". quote_line_items.quote_id is ON DELETE CASCADE, so the
 * lines go with them.
 *
 * ## The reprice at the end is the load-bearing part
 *
 * Products are created at QUOTE_FIXTURE price, the two versions are saved
 * against them, and only THEN are the products repriced. So every figure on
 * the printed quote is a price the catalog no longer holds. A print page that
 * read `products` live would render a perfectly plausible document with the
 * wrong numbers on it, and no policy, type or constraint would object — the
 * gap between these two prices is the only thing that can see it.
 */
async function ensureQuote(
  db: SupabaseClient,
  agentId: string,
  leadId: number,
): Promise<QuoteFixture> {
  // The lead carries no contact details from ensureDocOwners, and that helper
  // short-circuits on an existing row — so setting them there would only ever
  // reach a freshly reset database. Re-asserted here instead, which converges
  // whether the lead was created a moment ago or a month ago.
  const { error: leadError } = await db
    .from("leads")
    .update(QUOTE_LEAD_CONTACT)
    .eq("id", leadId);
  if (leadError) throw new Error(`quote lead contact: ${leadError.message}`);

  // Products first, at the price the quote will snapshot.
  const idBySku = new Map<string, number>();
  for (const product of QUOTE_FIXTURE.products) {
    const { data: existing } = await db
      .from("products")
      .select("id")
      .eq("sku", product.sku)
      .maybeSingle();

    let productId = existing?.id as number | undefined;
    if (productId === undefined) {
      const { data, error } = await db
        .from("products")
        .insert({
          name: product.name,
          sku: product.sku,
          category: "E2E hardware",
          list_price: product.price,
        })
        .select("id")
        .single();
      if (error || !data) {
        throw new Error(`product ${product.sku}: ${error?.message ?? "no row"}`);
      }
      productId = data.id as number;
    } else {
      // Back to the pre-quote price before the RPC reads it, so a second run
      // snapshots the same figures as the first rather than the bumped ones.
      const { error } = await db
        .from("products")
        .update({
          name: product.name,
          list_price: product.price,
          archived_at: null,
        })
        .eq("id", productId);
      if (error) throw new Error(`product ${product.sku}: ${error.message}`);
    }
    idBySku.set(product.sku, productId);
  }

  await db
    .from("quotes")
    .delete()
    .eq("lead_id", leadId)
    .eq("title", QUOTE_FIXTURE.title);

  const saveVersion = async (
    lines: readonly { sku: string; quantity: number }[],
    groupId: string | null,
  ): Promise<{ id: number; groupId: string }> => {
    const { data, error } = await db.rpc("create_quote_version", {
      lead_id_input: leadId,
      merchant_id_input: null,
      agent_id_input: agentId,
      quote_group_id_input: groupId,
      status_input: "sent",
      title_input: QUOTE_FIXTURE.title,
      notes_input: QUOTE_FIXTURE.notes,
      line_items_input: lines.map((line) => ({
        product_id: idBySku.get(line.sku),
        quantity: line.quantity,
      })),
    });
    if (error || typeof data !== "number") {
      throw new Error(`quote version: ${error?.message ?? "no id"}`);
    }

    const { data: row, error: readError } = await db
      .from("quotes")
      .select("quote_group_id")
      .eq("id", data)
      .single();
    if (readError || !row) {
      throw new Error(`quote group id: ${readError?.message ?? "no row"}`);
    }
    return { id: data, groupId: row.quote_group_id as string };
  };

  // v1 creates the group (null group id takes the column default); v2 passes
  // the id back, and the trigger assigns version 2.
  const first = await saveVersion(QUOTE_FIXTURE.v1, null);
  const current = await saveVersion(QUOTE_FIXTURE.v2, first.groupId);

  // And now the catalog moves on, after both snapshots are taken.
  for (const product of QUOTE_FIXTURE.products) {
    const { error } = await db
      .from("products")
      .update({ list_price: product.repricedTo })
      .eq("id", idBySku.get(product.sku) as number);
    if (error) throw new Error(`reprice ${product.sku}: ${error.message}`);
  }

  return {
    leadId,
    groupId: first.groupId,
    firstId: first.id,
    currentId: current.id,
  };
}

/**
 * One published material with real bytes behind it.
 *
 * Seeded as the ADMIN, because marketing_materials has no agent_id and only an
 * admin may write it — but what the specs exercise is the REP reading it, which
 * is the asymmetry the whole feature turns on.
 *
 * The row is written before the object for the same reason
 * marketing-material-file-url does it that way: the storage key is
 * {material_id}/{file_name}, so the id has to exist before the key can be built.
 * file_key is therefore set in a second statement — the CHECK constraint would
 * reject any placeholder, which is why that column is nullable at all.
 *
 * Idempotent by title, so a second run reuses the row rather than filling the
 * library with duplicates. The object is re-uploaded with upsert either way: a
 * row whose bytes went missing (a `db reset` drops the bucket, not the table)
 * would otherwise leave every View and Download 404ing with the row still
 * looking healthy.
 */
async function ensureMarketingMaterial(
  db: SupabaseClient,
  adminId: string,
): Promise<number> {
  const title = "E2E rate card";

  const { data: existing } = await db
    .from("marketing_materials")
    .select("id")
    .eq("title", title)
    .maybeSingle();

  let materialId = existing?.id as number | undefined;

  if (materialId === undefined) {
    const { data, error } = await db
      .from("marketing_materials")
      .insert({
        category: "E2E rate cards",
        title,
        file_name: "e2e-rate-card.txt",
        mime_type: "text/plain",
        uploaded_by: adminId,
      })
      .select("id")
      .single();
    if (error || !data) {
      throw new Error(`marketing material: ${error?.message ?? "no row"}`);
    }
    materialId = data.id as number;
  }

  const fileKey = `${materialId}/e2e-rate-card.txt`;
  const { error: uploadError } = await db.storage
    .from("marketing")
    .upload(fileKey, new Blob([MARKETING_MATERIAL_BODY]), {
      contentType: "text/plain",
      upsert: true,
    });
  if (uploadError) {
    throw new Error(`marketing material object: ${uploadError.message}`);
  }

  const { error: keyError } = await db
    .from("marketing_materials")
    .update({ file_key: fileKey, archived_at: null })
    .eq("id", materialId);
  if (keyError) {
    throw new Error(`marketing material key: ${keyError.message}`);
  }

  return materialId;
}

/** The bytes behind the seeded material, so a spec can assert the round trip. */
export const MARKETING_MATERIAL_BODY = "E2E RATE CARD — interchange plus 0.35%";

/**
 * Clears one lead's engagement history.
 *
 * Needed because marketing_material_events is append-only BY DESIGN — no UPDATE
 * or DELETE grant for `authenticated` — so a spec cannot undo its own writes,
 * and a spec that asserts an empty history is otherwise at the mercy of
 * whichever test ran before it. Service role, which bypasses both RLS and the
 * missing grants.
 *
 * Per-lead rather than a blanket wipe: the file-level seed already clears the
 * personas' events once, and a helper that emptied the whole table would let a
 * spec quietly depend on being the only thing running.
 */
export async function clearMarketingEvents(leadId: number): Promise<void> {
  const { apiUrl, serviceKey } = localStackConfig();
  const db = createClient(apiUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  await db.from("marketing_material_events").delete().eq("lead_id", leadId);
}

/**
 * Removes the proposals a store spec SAVED, by title.
 *
 * Service role, because `quotes` has no DELETE policy and no DELETE grant at
 * either layer — a proposal is evidence of what a merchant was offered, so
 * nothing in the app can remove one. Same reason clearMarketingEvents runs as
 * the service role.
 *
 * Needed because the store specs assert on what the panel LISTS after a save,
 * and the panel lists every proposal on the record. Without this the second
 * run would see the first run's rows and a count or an nth-match would be
 * reading history. Scoped by title rather than wiping the record's quotes:
 * the merchant already carries the seed's own proposal, and the agent's lead
 * carries the print spec's two-version fixture.
 *
 * quote_line_items needs no clause of its own — quote_id is ON DELETE CASCADE,
 * so the lines go with the quote. That is the contrast the schema doc draws
 * with the marketing pair, where the child had to be cleared first.
 */
export async function clearProposalsTitled(title: string): Promise<void> {
  const { apiUrl, serviceKey } = localStackConfig();
  const db = createClient(apiUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { error } = await db.from("quotes").delete().eq("title", title);
  if (error) throw new Error(`clear proposals: ${error.message}`);
}

/**
 * One saved proposal's lines, straight from the table.
 *
 * The price lock's claim is that the SNAPSHOT comes from the catalog, and the
 * rendered page is a consequence — a store that displayed the right figure
 * while saving a different one would look identical. So the store specs read
 * the rows as well as the page, the way the follow-up specs read
 * next_followup_date after a click.
 */
export async function proposalLines(title: string): Promise<
  {
    product_name: string;
    quantity: number;
    unit_price: string;
    product_billing: string;
    product_kind: string;
    sort_order: number;
  }[]
> {
  const { apiUrl, serviceKey } = localStackConfig();
  const db = createClient(apiUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: quotes, error: quoteError } = await db
    .from("quotes")
    .select("id")
    .eq("title", title)
    .order("id", { ascending: false })
    .limit(1);
  if (quoteError) throw new Error(`proposal lookup: ${quoteError.message}`);
  if (!quotes || quotes.length === 0) return [];

  const { data, error } = await db
    .from("quote_line_items")
    .select(
      "product_name, quantity, unit_price, product_billing, product_kind, sort_order",
    )
    .eq("quote_id", quotes[0].id as number)
    .order("sort_order", { ascending: true });
  if (error) throw new Error(`proposal lines: ${error.message}`);

  return (data ?? []) as Awaited<ReturnType<typeof proposalLines>>;
}

/**
 * The private `documents` and `marketing` buckets, with the size ceiling the
 * app promises.
 *
 * NOT `residual-imports`: this file has never created it, and a passing e2e run
 * still leaves residual imports broken on a freshly reset stack. That gap is
 * recorded in CLAUDE.md rather than quietly closed here, because closing it
 * would make this helper provision a bucket no e2e spec uses.
 *
 * The bucket is created out-of-band in production — it is in no migration — so a
 * freshly reset local stack has none and every signing call 404s. The size limit
 * is re-asserted on every run rather than only at creation, because a bucket
 * created before the limit existed keeps accepting unbounded uploads and nothing
 * says so: config.toml's `[storage] file_size_limit` is NOT what constrains a
 * signed upload (measured — a 120 MiB PUT was accepted with it set to 50MiB).
 * The per-bucket limit is.
 */
async function ensureDocumentsBucket(db: SupabaseClient): Promise<void> {
  for (const bucket of ["documents", "marketing"]) {
    const { error: createError } = await db.storage.createBucket(bucket, {
      public: false,
      fileSizeLimit: MAX_DOCUMENT_BYTES,
    });
    if (createError && !/exists/i.test(createError.message)) {
      throw new Error(`${bucket} bucket: ${createError.message}`);
    }
    const { error: updateError } = await db.storage.updateBucket(bucket, {
      public: false,
      fileSizeLimit: MAX_DOCUMENT_BYTES,
    });
    if (updateError) {
      throw new Error(`${bucket} bucket limit: ${updateError.message}`);
    }
  }
}

/**
 * The upload ceiling, duplicated from lib/documents.ts.
 *
 * Imported rather than redeclared would be better, but this module is loaded by
 * Playwright's config-time transpile and the `@/` alias is not wired up there.
 * The two are pinned together by e2e/documents-edge-cases.spec.ts, which asserts
 * the client refuses at exactly this boundary.
 */
const MAX_DOCUMENT_BYTES = 50 * 1024 * 1024;

/**
 * One merchant, lead, pre-app and support ticket per persona.
 *
 * Looked up by a per-persona marker before being created, so a second run reuses
 * them: these records accumulate notes, tasks and documents, and re-creating them
 * each run would leave a growing pile of orphans behind (documents.owner_id has
 * no foreign key, so nothing cleans up after a deleted owner).
 */
async function ensureDocOwners(
  db: SupabaseClient,
  persona: PersonaKey,
  agentId: string,
): Promise<DocOwnerIds> {
  const marker = `E2E-DOC-${persona}`;

  const find = async (
    table: string,
    column: string,
  ): Promise<number | null> => {
    const { data } = await db
      .from(table)
      .select("id")
      .eq("agent_id", agentId)
      .eq(column, marker)
      .maybeSingle();
    return (data?.id as number | undefined) ?? null;
  };

  const create = async (
    table: string,
    row: Record<string, unknown>,
  ): Promise<number> => {
    const { data, error } = await db
      .from(table)
      .insert({ agent_id: agentId, ...row })
      .select("id")
      .single();
    if (error || !data) {
      throw new Error(`${table} for ${persona}: ${error?.message ?? "no row"}`);
    }
    return data.id as number;
  };

  const merchant =
    (await find("merchants", "mid")) ??
    (await create("merchants", {
      mid: marker,
      dba: `E2E Docs ${persona}`,
      legal_business_name: `E2E Docs ${persona} LLC`,
      status: "active",
      processor: "TSYS",
    }));

  const lead =
    (await find("leads", "dba")) ??
    (await create("leads", {
      dba: marker,
      merchant_legal_name: `E2E Docs Lead ${persona} LLC`,
      // 'new', not 'open': leads_status_vocabulary (20261002120000) retired
      // 'open', and that migration backfills every such row to 'new'.
      //
      // This was latent for a month and only fires on a FRESHLY RESET database,
      // which is what makes it worth a comment rather than a one-word diff. The
      // find() above short-circuits whenever the fixture lead already exists, so
      // every run against a stack that had seeded once before skipped this
      // insert entirely. The first `npx supabase db reset` after the constraint
      // landed turned the whole e2e suite red in SETUP, with 87 specs never
      // running and an error naming leads rather than the migration.
      //
      // The support_tickets fixture below keeps 'open' deliberately: that
      // column has no vocabulary and is unconstrained on purpose.
      status: "new",
    }));

  const preApp =
    (await find("pre_apps", "dba_name")) ??
    (await create("pre_apps", {
      dba_name: marker,
      legal_business_name: `E2E Docs Pre-App ${persona} LLC`,
      status: "draft",
    }));

  const ticket =
    (await find("support_tickets", "subject")) ??
    (await create("support_tickets", {
      subject: marker,
      message: `Document panel fixture for ${persona}.`,
      status: "open",
      priority: "medium",
    }));

  return {
    merchant,
    lead,
    pre_app: preApp,
    support_ticket: ticket,
  };
}

/**
 * The metadata rows behind a file name, newest first.
 *
 * Paired with storageObjectExists(), this is what distinguishes a real delete
 * from a metadata-only one — a spec cannot see Storage itself, because the bucket
 * is private and the browser only ever holds a signed URL. Both run on the Node
 * side with the service role, deliberately not exposed to the page, for the same
 * reason publicStackConfig withholds that key.
 *
 * Capture the file_key BEFORE the action under test: once the row is gone there
 * is nothing left to look the object up by.
 */
export async function documentRows(
  fileName: string,
): Promise<{ id: number; fileKey: string }[]> {
  const { apiUrl, serviceKey } = localStackConfig();
  const db = createClient(apiUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data } = await db
    .from("documents")
    .select("id, file_key")
    .eq("file_name", fileName)
    .order("id", { ascending: false });

  return (data ?? []).map((r) => ({
    id: r.id as number,
    fileKey: r.file_key as string,
  }));
}

/** Whether a specific storage key is still in the bucket. */
export async function storageObjectExists(fileKey: string): Promise<boolean> {
  const { apiUrl, serviceKey } = localStackConfig();
  const db = createClient(apiUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const parts = fileKey.split("/");
  const name = parts.pop() as string;
  const { data: listed } = await db.storage
    .from("documents")
    .list(parts.join("/"), { limit: 1000 });
  return (listed ?? []).some((o) => o.name === name);
}

/**
 * Removes every documents row (and its object) a spec created, by file name.
 *
 * Specs upload real files, so without this each run leaves more rows on the
 * fixture records and the "no documents attached yet" empty state becomes
 * unreachable for whichever spec asserts on it.
 */
export async function clearDocuments(fileNames: string[]): Promise<void> {
  const { apiUrl, serviceKey } = localStackConfig();
  const db = createClient(apiUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: rows } = await db
    .from("documents")
    .select("id, file_key")
    .in("file_name", fileNames);
  if (!rows || rows.length === 0) return;

  const keys = rows.map((r) => r.file_key as string);
  if (keys.length > 0) await db.storage.from("documents").remove(keys);
  await db
    .from("documents")
    .delete()
    .in(
      "id",
      rows.map((r) => r.id as number),
    );
}

/**
 * A clean batch staged and ready to commit, for the commit specs.
 *
 * Returned rather than created in a fixture, because a commit is destructive to
 * its own batch: each commit spec needs its own, and reusing one would make the
 * second spec depend on the first having not run.
 */
export async function createCommittableBatch(
  agentPeriod: string,
  rowCount = 3,
): Promise<number> {
  const { apiUrl, serviceKey } = localStackConfig();
  const db = createClient(apiUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: adminUsers } = await db.auth.admin.listUsers({ perPage: 1000 });
  const adminId = (adminUsers?.users ?? []).find(
    (u) => u.email === PERSONAS.admin.email,
  )?.id;
  const agentId = (adminUsers?.users ?? []).find(
    (u) => u.email === PERSONAS.agent.email,
  )?.id;
  if (!adminId || !agentId) throw new Error("Run seedE2E() first.");

  const { data: batch, error: batchError } = await db
    .from("rep_payout_batches")
    .insert({
      imported_by: adminId,
      file_key: `e2e/${agentPeriod}.xlsx`,
      file_name: `e2e-${agentPeriod}.xlsx`,
      status: "review",
    })
    .select("id")
    .single();
  if (batchError || !batch) {
    throw new Error(`batch: ${batchError?.message ?? "no row"}`);
  }

  const batchId = batch.id as number;
  const staged = Array.from({ length: rowCount }, (_, i) => ({
    batch_id: batchId,
    row_number: i + 1,
    mid_raw: `E2E-COMMIT-${batchId}-${i + 1}`,
    merchant_name_raw: `E2E Commit Merchant ${i + 1}`,
    period: firstOfMonth(agentPeriod),
    agent_id: agentId,
    volume: 1000 * (i + 1),
    average_ticket: 10,
    total_cost: 50,
    residual_income: 200 * (i + 1),
    rep_split_pct: 55,
  }));

  const { error: rowsError } = await db
    .from("rep_payout_import_rows")
    .insert(staged);
  if (rowsError) throw new Error(`staging: ${rowsError.message}`);

  return batchId;
}

/** Counts that prove a commit happened exactly once. */
export async function commitEvidence(batchId: number): Promise<{
  auditRows: number;
  ledgerRows: number;
  status: string | null;
  stagingLeft: number;
}> {
  const { apiUrl, serviceKey } = localStackConfig();
  const db = createClient(apiUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const [audit, ledger, batch, staging] = await Promise.all([
    db.from("audit_log").select("id", { count: "exact", head: true })
      .eq("action", "commit_residual_import").eq("row_id", String(batchId)),
    db.from("rep_payout_rows").select("id", { count: "exact", head: true })
      .eq("batch_id", batchId),
    db.from("rep_payout_batches").select("status").eq("id", batchId).maybeSingle(),
    db.from("rep_payout_import_rows").select("id", { count: "exact", head: true })
      .eq("batch_id", batchId),
  ]);

  return {
    auditRows: audit.count ?? 0,
    ledgerRows: ledger.count ?? 0,
    status: (batch.data?.status as string | undefined) ?? null,
    stagingLeft: staging.count ?? 0,
  };
}

/**
 * Removes the accounts and batches a bulk-import spec created.
 *
 * Accounts go first and audit_log goes before them: audit_log.actor_id and
 * .row_id reference profiles with no ON DELETE, and provisionUser writes a
 * create_user row for every account it makes, so an unchecked delete would fail
 * on the FK and leave the persona behind — after which the next run's import
 * would report "already has an account" for a row the spec expects to be new.
 *
 * user_import_batches.imported_by is the eighteenth NO ACTION reference to
 * profiles, so the batches have to go too. Their rows follow by cascade.
 */
export async function clearImportedUsers(
  emails: string[],
  fileNames: string[],
): Promise<void> {
  const { apiUrl, serviceKey } = localStackConfig();
  const db = createClient(apiUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data: batches } = await db
    .from("user_import_batches")
    .select("id")
    .in("file_name", fileNames);

  const { data: list } = await db.auth.admin.listUsers({ perPage: 1000 });
  const wanted = new Set(emails.map((email) => email.toLowerCase()));

  for (const user of list?.users ?? []) {
    if (!user.email || !wanted.has(user.email.toLowerCase())) continue;
    await db.from("audit_log").delete().eq("actor_id", user.id);
    await db.from("audit_log").delete().eq("row_id", user.id);
    // profiles.manager_id, one of twenty-one references to profiles(id) and the
    // only `on delete set null` one — so unlike audit_log above it cannot make
    // this delete fail, and Postgres would clear it unprompted. Cleared here
    // anyway, and with an UPDATE rather than a DELETE because the row holding
    // the pointer is a DIFFERENT rep's profile: an imported user who was made
    // somebody's manager would otherwise have their reporting line silently
    // removed from a persona this teardown is not supposed to touch.
    await db
      .from("profiles")
      .update({ manager_id: null })
      .eq("manager_id", user.id);
    // quotes.agent_id, the twenty-second reference to profiles(id) and NO
    // ACTION. One delete and no child pass: quote_line_items.quote_id is ON
    // DELETE CASCADE, so the lines go with the quotes — unlike the marketing
    // pair immediately below, where material_id is NO ACTION.
    //
    // Not made redundant by quotes.lead_id also being ON DELETE CASCADE: an
    // admin may file a quote for one rep on ANOTHER rep's lead, and that row
    // carries this user's agent_id while hanging off a lead no delete of
    // theirs will ever touch.
    //
    // Here for the same reason that pair is: an imported rep has no reason to
    // own a quote today, the cost is one query against an empty set, and the
    // alternative is this being the list that forgot the next time a spec
    // builds a quote as a provisioned account.
    await db.from("quotes").delete().eq("agent_id", user.id);
    // marketing_materials.uploaded_by and marketing_material_events.agent_id,
    // the twentieth and twenty-first references to profiles(id) and both NO
    // ACTION. An imported rep has no reason to own either today, which is
    // exactly why this is here: the cost is one query against an empty set,
    // and the alternative is this list being the one that forgot, the next
    // time a spec logs an event as a provisioned account.
    //
    // Events before materials, and by material before by actor, because
    // material_id is NO ACTION too — a material this user uploaded can carry
    // another rep's events.
    const { data: ownMaterials } = await db
      .from("marketing_materials")
      .select("id")
      .eq("uploaded_by", user.id);
    const materialIds = (ownMaterials ?? []).map((material) => material.id as number);
    if (materialIds.length > 0) {
      await db
        .from("marketing_material_events")
        .delete()
        .in("material_id", materialIds);
    }
    await db.from("marketing_material_events").delete().eq("agent_id", user.id);
    await db.from("marketing_materials").delete().eq("uploaded_by", user.id);
    await db.auth.admin.deleteUser(user.id);
  }

  const batchIds = (batches ?? []).map((batch) => batch.id as number);
  if (batchIds.length > 0) {
    await db
      .from("audit_log")
      .delete()
      .eq("action", "commit_user_import")
      .in("row_id", batchIds.map(String));
    await db.from("user_import_batches").delete().in("id", batchIds);
  }
}

/** The profiles a bulk-import spec created, for asserting what really landed. */
export async function importedProfiles(
  emails: string[],
): Promise<{ email: string; role: string; must_change_password: boolean }[]> {
  const { apiUrl, serviceKey } = localStackConfig();
  const db = createClient(apiUrl, serviceKey, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data } = await db
    .from("profiles")
    .select("email, role, must_change_password")
    .in("email", emails);

  return (data ?? []) as {
    email: string;
    role: string;
    must_change_password: boolean;
  }[];
}
