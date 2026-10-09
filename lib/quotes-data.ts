import { createClient } from "@/lib/supabase/server";
import {
  COMPATIBILITY_COLUMNS,
  PRODUCT_COLUMNS,
  type CompatibilityRow,
  type Product,
  compatibilityByDevice,
  isQuotable,
} from "@/lib/products";
import {
  QUOTE_COLUMNS,
  QUOTE_LINE_COLUMNS,
  type Quote,
  type QuoteGroup,
  type QuoteLineItem,
  type QuoteOwnerType,
  type QuoteTotals,
  groupQuotes,
  lineTotals,
} from "@/lib/quotes";

/**
 * Server-side reads for proposals (the `quotes` tables — "Proposals" is UI
 * wording only).
 *
 * ## Every read is the caller's own, and RLS decides the answer
 *
 *   quotes                own-or-admin, where "own" is the rep the proposal
 *                         is FOR (agent_id)
 *   quote_line_items      the same, through an `exists` on the parent
 *   products              is_active_agent() or is_admin() — company reference
 *   product_compatibility the same
 *
 * No service-role client and no definer RPC anywhere here. A filter in a
 * query below (a group id, a record, an admin's chosen rep) is ADDRESSING —
 * which subset of what the caller may see the page asked for — never a copy
 * of a policy. Zero rows is the caller's answer, and the pages turn it into
 * notFound(): "not yours" and "does not exist" must look the same.
 */

type SupabaseServerClient = Awaited<ReturnType<typeof createClient>>;

/** A proposal as a list row: its group, and its CURRENT version's totals. */
export type ProposalSummary = {
  group: QuoteGroup;
  totals: QuoteTotals;
};

/** The store's catalog: quotable devices, quotable add-ons, what fits what. */
export type QuoteCatalog = {
  devices: Product[];
  addons: Product[];
  addonsByDevice: Map<number, number[]>;
};

/**
 * The catalog the builder browses.
 *
 * ## What hides an archived product is this function, not a policy
 *
 * `isQuotable` (live, and priced) is applied here rather than in RLS, and the
 * schema doc carries the three reasons: an admin must still see everything on
 * /admin/products, archiving is a lifecycle state rather than an access
 * boundary, and a quote outlives the product on it. The database still refuses
 * an archived or unpriced product twice over — in create_quote_version() by
 * name, and in snapshot_quote_line_item() at a layer no caller can skip — so
 * this filter is a courtesy, not the boundary.
 */
export async function loadQuoteCatalog(): Promise<QuoteCatalog> {
  const supabase = await createClient();
  const [{ data: productRows }, { data: compatRows }] = await Promise.all([
    supabase
      .from("products")
      .select(PRODUCT_COLUMNS)
      .is("archived_at", null)
      .order("brand", { ascending: true, nullsFirst: false })
      .order("name", { ascending: true }),
    supabase.from("product_compatibility").select(COMPATIBILITY_COLUMNS),
  ]);

  const quotable = ((productRows ?? []) as Product[]).filter(isQuotable);
  return {
    // A value outside the kind vocabulary lands in `devices` — the direction
    // groupQuoteLines() takes: a widened `kind` should read as a standalone
    // item rather than disappear under a device nobody linked it to.
    devices: quotable.filter((product) => product.kind !== "addon"),
    addons: quotable.filter((product) => product.kind === "addon"),
    addonsByDevice: compatibilityByDevice(
      (compatRows ?? []) as CompatibilityRow[],
    ),
  };
}

/** Lines for a set of quote rows, keyed by quote id. */
async function loadLines(
  supabase: SupabaseServerClient,
  quoteIds: number[],
): Promise<Record<number, QuoteLineItem[]>> {
  // Skipped when empty: `.in()` with no ids can only return nothing.
  const { data } = quoteIds.length
    ? await supabase
        .from("quote_line_items")
        .select(QUOTE_LINE_COLUMNS)
        .in("quote_id", quoteIds)
        .order("sort_order", { ascending: true })
        .order("id", { ascending: true })
    : { data: [] };

  const byQuote: Record<number, QuoteLineItem[]> = {};
  for (const line of (data ?? []) as QuoteLineItem[]) {
    (byQuote[line.quote_id] ??= []).push(line);
  }
  return byQuote;
}

async function summarize(
  supabase: SupabaseServerClient,
  rows: Quote[],
): Promise<ProposalSummary[]> {
  // groupQuotes() is the one place "current" is decided (currentVersion()),
  // so the totals below are always the current version's.
  const groups = groupQuotes(rows);
  const lines = await loadLines(
    supabase,
    groups.map((group) => group.current.id),
  );
  return groups.map((group) => ({
    group,
    totals: lineTotals(lines[group.current.id] ?? []),
  }));
}

/**
 * Every proposal the caller may see, as list rows — optionally one rep's.
 *
 * `agentId` is an admin's rep filter. For a rep it can only ever narrow their
 * own book to itself or to nothing, so the page offers it to admins only.
 */
export async function loadProposalList(
  agentId: string | null,
): Promise<ProposalSummary[]> {
  const supabase = await createClient();
  let query = supabase
    .from("quotes")
    .select(QUOTE_COLUMNS)
    .order("created_at", { ascending: false });
  if (agentId !== null) query = query.eq("agent_id", agentId);
  const { data } = await query;
  return summarize(supabase, (data ?? []) as Quote[]);
}

/** One lead's or merchant's proposals, for the compact list on its page. */
export async function loadRecordProposals(
  ownerType: QuoteOwnerType,
  ownerId: number,
): Promise<ProposalSummary[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("quotes")
    .select(QUOTE_COLUMNS)
    .eq(ownerType === "lead" ? "lead_id" : "merchant_id", ownerId)
    .order("created_at", { ascending: false });
  return summarize(supabase, (data ?? []) as Quote[]);
}

/**
 * One proposal: every version, newest first, with every version's lines.
 *
 * EVERY version and every line, not just the current one, because that is the
 * point of the append-only design: the history renders superseded versions in
 * full, at the prices they were sent at. Returns null when the caller can see
 * no row of the group — not theirs and does not exist are the same answer.
 */
export async function loadProposalGroup(quoteGroupId: string): Promise<{
  group: QuoteGroup;
  linesByQuote: Record<number, QuoteLineItem[]>;
} | null> {
  if (!isUuid(quoteGroupId)) return null;
  const supabase = await createClient();
  const { data } = await supabase
    .from("quotes")
    .select(QUOTE_COLUMNS)
    .eq("quote_group_id", quoteGroupId)
    .order("version", { ascending: false });
  const rows = (data ?? []) as Quote[];
  if (rows.length === 0) return null;
  const [group] = groupQuotes(rows);
  return {
    group,
    linesByQuote: await loadLines(
      supabase,
      rows.map((row) => row.id),
    ),
  };
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Guarded before any query: a malformed uuid is a 22P02 from PostgREST,
 * which would surface as an error page rather than the 404 every other
 * unreachable proposal gives.
 */
export function isUuid(value: string): boolean {
  return UUID.test(value);
}

/** id -> full name, for every profile the caller can read. */
export async function loadRepNames(): Promise<Map<string, string>> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("profiles")
    .select("id, full_name")
    .order("full_name", { ascending: true });
  return new Map(
    ((data ?? []) as { id: string; full_name: string | null }[]).map((p) => [
      p.id,
      p.full_name ?? "Unnamed rep",
    ]),
  );
}
