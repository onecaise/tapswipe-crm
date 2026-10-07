import { notFound } from "next/navigation";

import { createClient } from "@/lib/supabase/server";
import {
  QUOTE_COLUMNS,
  QUOTE_LINE_COLUMNS,
  type Quote,
  type QuoteLineItem,
  type QuoteOwnerType,
  currentVersion,
} from "@/lib/quotes";

/**
 * Everything one printable proposal needs, for either owner kind.
 *
 * The lead route and the merchant route share this AND the document component
 * it feeds, so there is one implementation of each. Two copies of a document a
 * merchant reads is how the lead version comes to say something the merchant
 * version does not.
 *
 * ## Terms text comes from here, and it is EMPTY
 *
 * PROPOSAL_TERMS below is the single constant any footer boilerplate would
 * come from, and it is deliberately the empty string. Nothing in this
 * repository knows what Tapswipe's hardware terms are, and inventing
 * plausible-sounding legal wording for a document handed to a merchant is the
 * same mistake as seeding the catalog with placeholder prices — except that a
 * wrong price is obvious and wrong terms are not. The document renders no
 * terms section at all while this is empty.
 *
 * ## It is a read, and nothing but
 *
 * No new policy, grant or migration. `quotes` is own-or-admin on select and
 * `quote_line_items` reaches the same answer through an `exists` on its
 * parent. Every read goes through the caller's own scoped client, so RLS
 * decides what comes back — and zero rows is notFound(), never a 403. A
 * proposal that does not exist and one belonging to another rep have to be the
 * same answer, or the URL becomes an id oracle. That matters more on the
 * merchant route than it did on the lead one: merchant ids are sequential and
 * a rep knows their own, so "does 41 exist" is exactly the question a 403
 * would answer and a 404 does not.
 *
 * Prices, names, billing cycles and the device/add-on structure ALL come from
 * the snapshot on quote_line_items. `products` is not read here at all.
 * Joining it live would restate what a merchant was offered last month in this
 * month's prices — and with billing in the snapshot, would also move figures
 * between the two totals — and the restatement would look exactly like the
 * original.
 */

/**
 * Footer boilerplate for a printed proposal. EMPTY BY DEFAULT.
 *
 * One constant, so there is one place to put real wording when somebody who
 * knows what it should say provides it. While it is empty the document renders
 * no terms block — not an empty heading, and not a placeholder.
 */
export const PROPOSAL_TERMS = "";

export type ProposalOwner = {
  type: QuoteOwnerType;
  id: number;
  /** The business name, as the document's "Prepared for". */
  name: string;
  /** Shown only when it differs from `name` — see the component. */
  legalName: string | null;
  /** Contact line parts the record actually has. Nulls are omitted. */
  contactName: string | null;
  contactPhone: string | null;
  contactEmail: string | null;
};

/** Who prepared it — the OWNING rep, resolved from profiles under RLS. */
export type ProposalPreparer = {
  fullName: string | null;
  email: string | null;
  agentNumber: string | null;
};

export type Proposal = {
  owner: ProposalOwner;
  /** The version being printed. */
  quote: Quote;
  /** Every version in the group, newest first — for "version 2 of 3". */
  versions: Quote[];
  current: Quote;
  isCurrent: boolean;
  lines: QuoteLineItem[];
  preparer: ProposalPreparer;
};

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Loads one version of one proposal, or 404s.
 *
 * Calls notFound() itself rather than returning null, because every single
 * failure here has the same answer and threading a discriminated result
 * through two routes would be two chances to get one of them wrong. The cases:
 * a malformed id, a malformed group uuid, an owner the caller cannot see, a
 * group that is not on that owner, and a `?quote=` naming a row outside the
 * group.
 */
export async function loadProposal(
  ownerType: QuoteOwnerType,
  ownerIdParam: string,
  quoteGroupId: string,
  quoteParam: string | undefined,
): Promise<Proposal> {
  const ownerId = Number(ownerIdParam);
  if (!Number.isInteger(ownerId)) notFound();

  // Guarded before the query rather than trusting the segment, the way the
  // payout summary guards its agentId: a malformed uuid is a 22P02 from
  // PostgREST, which surfaces as an error page rather than as the 404 every
  // other unreachable record here gives.
  if (!UUID.test(quoteGroupId)) notFound();

  const supabase = await createClient();
  const owner = await loadOwner(supabase, ownerType, ownerId);

  // Every version of the group, because "version 2 of 3" cannot be said from
  // one row — and the whole group is what tells a reader whether the sheet in
  // their hand is the current offer.
  //
  // Filtered on the OWNER column as well as the group id, and it is not
  // redundant: the path asserts this proposal belongs to this record, so the
  // query should enforce it rather than let a group from another record render
  // under this one's name and contact. RLS would happily return it — the rep
  // may own both. (enforce_quote_version() makes a group's owner constant, so
  // this filter can never split one group across two pages.)
  const ownerColumn = ownerType === "lead" ? "lead_id" : "merchant_id";
  const { data: quoteRows, error } = await supabase
    .from("quotes")
    .select(QUOTE_COLUMNS)
    .eq("quote_group_id", quoteGroupId)
    .eq(ownerColumn, ownerId)
    .order("version", { ascending: false });

  if (error) notFound();
  const versions = (quoteRows ?? []) as Quote[];
  if (versions.length === 0) notFound();

  // The default is THE rule, through the one implementation of it.
  const current = currentVersion(versions);

  let quote = current;
  if (quoteParam !== undefined) {
    const wanted = Number(quoteParam);
    // A row id that is not in this group is a 404 like any other unreachable
    // record — including, deliberately, a real quote row belonging to a
    // different group the caller can see. The path says which document this
    // is; the param only chooses among its versions.
    const found = Number.isInteger(wanted)
      ? versions.find((version) => version.id === wanted)
      : undefined;
    if (!found) notFound();
    quote = found;
  }

  const { data: lineRows } = await supabase
    .from("quote_line_items")
    .select(QUOTE_LINE_COLUMNS)
    .eq("quote_id", quote.id)
    .order("sort_order", { ascending: true })
    .order("id", { ascending: true });

  return {
    owner,
    quote,
    versions,
    current,
    isCurrent: quote.id === current.id,
    lines: (lineRows ?? []) as QuoteLineItem[],
    preparer: await loadPreparer(supabase, quote.agent_id),
  };
}

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>;

/**
 * The lead or merchant the proposal is for, normalised to one shape.
 *
 * The two tables name these fields differently — a lead has `dba`,
 * `merchant_legal_name` and three contact columns; a merchant has `dba` and
 * `legal_business_name` and NO contact columns at all. Flattening here rather
 * than branching in the component means the document has one set of fields to
 * render and cannot quietly omit one of them on one route.
 */
async function loadOwner(
  supabase: SupabaseServerClient,
  ownerType: QuoteOwnerType,
  ownerId: number,
): Promise<ProposalOwner> {
  if (ownerType === "lead") {
    const { data, error } = await supabase
      .from("leads")
      .select("id, dba, merchant_legal_name, contact_name, contact_phone, contact_email")
      .eq("id", ownerId)
      .maybeSingle();
    if (error || !data) notFound();

    return {
      type: "lead",
      id: data.id as number,
      name: (data.dba as string | null) ?? "",
      legalName: (data.merchant_legal_name as string | null) ?? null,
      contactName: (data.contact_name as string | null) ?? null,
      contactPhone: (data.contact_phone as string | null) ?? null,
      contactEmail: (data.contact_email as string | null) ?? null,
    };
  }

  const { data, error } = await supabase
    .from("merchants")
    .select("id, dba, legal_business_name")
    .eq("id", ownerId)
    .maybeSingle();
  if (error || !data) notFound();

  return {
    type: "merchant",
    id: data.id as number,
    name: (data.dba as string | null) ?? "",
    legalName: (data.legal_business_name as string | null) ?? null,
    // `merchants` HAS NO CONTACT COLUMNS. Nulls, not invented values — the
    // document omits the contact line entirely rather than printing a blank
    // one, and nothing here reaches into the merchant's originating pre-app or
    // lead to fill it in. A contact pulled from a two-year-old application is
    // worse than no contact: it looks current.
    contactName: null,
    contactPhone: null,
    contactEmail: null,
  };
}

/**
 * The owning rep's name and whatever contact details the profile actually has.
 *
 * WHATEVER IT ACTUALLY HAS, which is `full_name`, `email` and `agent_number`
 * and nothing else. `profiles` has no phone column, so the document prints no
 * phone — rather than a placeholder, or a company switchboard number nobody
 * agreed to put on a document a merchant reads.
 *
 * Resolved for `quote.agent_id`, which is the OWNING rep rather than whoever
 * is printing: an admin printing a rep's proposal prints the rep's name,
 * because that is who prepared it. And it is a plain RLS-scoped read, so a rep
 * resolves their own row and an admin resolves anyone's — a lookup that comes
 * back empty renders no byline, which is the same treatment the lead timeline
 * gives an unresolvable author.
 */
async function loadPreparer(
  supabase: SupabaseServerClient,
  agentId: string,
): Promise<ProposalPreparer> {
  const { data } = await supabase
    .from("profiles")
    .select("full_name, email, agent_number")
    .eq("id", agentId)
    .maybeSingle();

  return {
    fullName: (data?.full_name as string | null) ?? null,
    email: (data?.email as string | null) ?? null,
    agentNumber: (data?.agent_number as string | null) ?? null,
  };
}
