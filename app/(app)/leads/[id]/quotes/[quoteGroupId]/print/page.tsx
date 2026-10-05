import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { ArrowLeftIcon } from "lucide-react";

import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { formatDate, formatMoney, formatText } from "@/lib/format";
import { type Lead } from "@/lib/leads";
import {
  QUOTE_COLUMNS,
  QUOTE_LINE_COLUMNS,
  QUOTE_STATUS_LABELS,
  type Quote,
  type QuoteLineItem,
  currentVersion,
  isQuoteStatus,
  quoteTotal,
} from "@/lib/quotes";
import { PageShell } from "@/components/page-shell";
import { PrintButton } from "@/components/print-button";
import { PrintDocument } from "@/components/print-document";
import { Button } from "@/components/ui/button";

/**
 * One version of one quote, laid out to be handed to a merchant.
 *
 * The fourth printable route, following /merchants/[id]/print rather than
 * bolting print CSS onto QuotesPanel. That panel is the builder AND the
 * version history — a product picker, quantity inputs, a status select, a
 * Revise button per group — so printing it in place would mean `print:`
 * classes threaded through an interactive component, hiding most of it to
 * reveal one version of one group. A route that renders exactly the document
 * is both simpler and the only form that can be linked to.
 *
 * ## Why the URL names the GROUP, with the version as a search param
 *
 * `quote_group_id` is the quote; the rows sharing it are its versions, and the
 * current one is whichever holds the highest `version` (see currentVersion()
 * in lib/quotes.ts — the rule lives there and nowhere else, because the
 * database stores no is_current flag, only the uniqueness that makes "highest"
 * unambiguous).
 *
 * So the group id is what identifies the document, and keying the path on it
 * means **this URL keeps printing the current version as the quote is
 * revised**. Keying it on a row id instead would freeze the link to whatever
 * version was current when somebody copied it: paste that into an email a
 * month later and it quietly prints a superseded offer, which is precisely the
 * mistake the append-only design exists to make answerable.
 *
 * A past version is then addressed by `?quote=<row id>` — named for what it
 * holds rather than `?version=`, because the value is a row id and not a
 * version number. Those are different scales (version 1 of a group can be row
 * 97), and a param whose name promises one while carrying the other is a bug
 * waiting on whoever reads the URL next.
 *
 * ## It is a read, and nothing but
 *
 * No new policy, grant or migration: `quotes` is already own-or-admin on
 * select and `quote_line_items` reaches the same answer through an `exists` on
 * its parent. Both reads go through the caller's own scoped client, so RLS
 * decides what comes back, and zero rows is notFound() — never a 403. A quote
 * that does not exist and one belonging to another rep have to be the same
 * answer, or the URL becomes an id oracle.
 *
 * Prices come from the SNAPSHOT on quote_line_items — unit_price, product_name
 * and product_sku, copied off the catalog inside the transaction that wrote
 * the quote. `products` is deliberately not read here at all. Joining it live
 * would restate what a merchant was offered last month in this month's prices,
 * and the restatement would look exactly like the original.
 */
export default function QuotePrintPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; quoteGroupId: string }>;
  searchParams: Promise<{ quote?: string }>;
}) {
  // Both passed down unawaited, so every dynamic read stays inside the
  // Suspense boundary cacheComponents requires.
  return (
    <PageShell width="detail">
      <Suspense
        fallback={
          <p className="text-sm text-muted-foreground">Loading quote…</p>
        }
      >
        <QuotePrint params={params} searchParams={searchParams} />
      </Suspense>
    </PageShell>
  );
}

async function QuotePrint({
  params,
  searchParams,
}: {
  params: Promise<{ id: string; quoteGroupId: string }>;
  searchParams: Promise<{ quote?: string }>;
}) {
  const { id, quoteGroupId } = await params;
  const { quote: quoteParam } = await searchParams;

  const leadId = Number(id);
  if (!Number.isInteger(leadId)) notFound();

  // Guarded before the query rather than trusting the segment, the way the
  // payout summary guards its agentId: a malformed uuid is a 22P02 from
  // PostgREST, which surfaces as an error page rather than as the 404 every
  // other unreachable record here gives.
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      quoteGroupId,
    )
  ) {
    notFound();
  }

  await requireUser();
  const supabase = await createClient();

  const { data: leadData, error: leadError } = await supabase
    .from("leads")
    .select("*")
    .eq("id", leadId)
    .maybeSingle();

  if (leadError || !leadData) notFound();
  const lead = leadData as Lead;

  // Every version of the group, because "version 2 of 3" cannot be said from
  // one row — and the whole group is what tells a reader whether the sheet in
  // their hand is the current offer.
  //
  // `.eq("lead_id")` as well as the group id, and it is not redundant: the
  // path asserts this quote belongs to this lead, so the query should enforce
  // it rather than let a group id from another lead render under this lead's
  // name and contact. RLS would happily return it — the rep may own both.
  const { data: quoteRows, error: quotesError } = await supabase
    .from("quotes")
    .select(QUOTE_COLUMNS)
    .eq("quote_group_id", quoteGroupId)
    .eq("lead_id", leadId)
    .order("version", { ascending: false });

  if (quotesError) notFound();
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

  const lines = (lineRows ?? []) as QuoteLineItem[];
  const total = quoteTotal(lines);
  const isCurrent = quote.id === current.id;
  const title = quote.title ?? "Untitled quote";

  return (
    <>
      <div className="flex items-start justify-between gap-4 print:hidden">
        <Button asChild variant="ghost" size="sm">
          <Link href={`/leads/${lead.id}`}>
            <ArrowLeftIcon size={16} />
            Back to {formatText(lead.dba)}
          </Link>
        </Button>
        <PrintButton />
      </div>

      <article className="rounded-xl border bg-card p-6 print:rounded-none print:border-0 print:p-0">
        <PrintDocument bodyClassName="flex flex-col gap-6">
          <header className="flex flex-col gap-1 border-b pb-4">
            <h1 className="text-xl font-bold tracking-tight">{title}</h1>
            <p className="text-sm text-muted-foreground">
              Quote · Version {quote.version} of {versions.length} ·{" "}
              {formatDate(quote.created_at)}
              {isQuoteStatus(quote.status)
                ? ` · ${QUOTE_STATUS_LABELS[quote.status]}`
                : ""}
            </p>
            {!isCurrent && (
              /* On the document, not only on screen — the same call the payout
                 summary makes with its "incomplete" line. A superseded version
                 printed without this is indistinguishable on paper from the
                 current offer, and handing one to a merchant is exactly the
                 argument the append-only design exists to settle. */
              <p className="mt-1 text-xs font-medium text-warning">
                Superseded — version {current.version} is the current one. This
                sheet is a record of an earlier offer.
              </p>
            )}
          </header>

          <section className="flex flex-col gap-1">
            <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              Prepared for
            </h2>
            <p className="text-base font-medium">{formatText(lead.dba)}</p>
            {/* The legal name only when it differs: on a quote the merchant
                reads, the same business printed twice reads as a mistake. */}
            {lead.merchant_legal_name !== null &&
              lead.merchant_legal_name !== "" &&
              lead.merchant_legal_name !== lead.dba && (
                <p className="text-sm text-muted-foreground">
                  {lead.merchant_legal_name}
                </p>
              )}
            <p className="text-sm">
              {formatText(lead.contact_name)}
              {lead.contact_phone ? ` · ${lead.contact_phone}` : ""}
              {lead.contact_email ? ` · ${lead.contact_email}` : ""}
            </p>
          </section>

          <section>
            <h2 className="sr-only">Line items</h2>
            {lines.length === 0 ? (
              /* create_quote_version() refuses a quote with no lines, so this
                 is unreachable through the app — rendered rather than omitted
                 for the reason QuotesPanel renders it: a document that
                 silently shows nothing is the exact state the RPC exists to
                 make impossible, and it should be legible if it appears. */
              <p className="text-sm text-muted-foreground">
                No line items recorded.
              </p>
            ) : (
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-xs uppercase tracking-wide text-muted-foreground">
                    <th className="pb-2 font-medium">Item</th>
                    <th className="pb-2 text-right font-medium">Qty</th>
                    <th className="pb-2 text-right font-medium">Unit price</th>
                    <th className="pb-2 text-right font-medium">Line total</th>
                  </tr>
                </thead>
                <tbody>
                  {lines.map((line) => (
                    <tr key={line.id} className="border-b last:border-0">
                      <td className="py-1.5">
                        {line.product_name}
                        {line.product_sku && (
                          <span className="ml-2 font-mono text-xs text-muted-foreground">
                            {line.product_sku}
                          </span>
                        )}
                      </td>
                      <td className="py-1.5 text-right tabular-nums">
                        {line.quantity}
                      </td>
                      {/* Both figures straight off the snapshot. line_total is
                          the stored generated column, read rather than
                          recomputed here — a second implementation is a figure
                          that can disagree with its own row. */}
                      <td className="py-1.5 text-right tabular-nums">
                        {formatMoney(line.unit_price)}
                      </td>
                      <td className="py-1.5 text-right tabular-nums">
                        {formatMoney(line.line_total)}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="border-t-2">
                    <td
                      className="pt-2 text-xs uppercase tracking-wide text-muted-foreground"
                      colSpan={3}
                    >
                      Total
                    </td>
                    <td className="pt-2 text-right text-base font-bold tabular-nums">
                      {formatMoney(total)}
                    </td>
                  </tr>
                </tfoot>
              </table>
            )}
          </section>

          {quote.notes && (
            <section className="break-inside-avoid">
              <h2 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                Notes and terms
              </h2>
              {/* whitespace-pre-wrap: terms are typed prose and the line breaks
                  are part of what the rep wrote. */}
              <p className="whitespace-pre-wrap text-sm">{quote.notes}</p>
            </section>
          )}

          <footer className="border-t pt-3 text-xs text-muted-foreground">
            {/* No generation timestamp, following the payout summary: it would
                change on every render, so two printouts of an unchanged quote
                would look like different documents. The quote's own date and
                version are what identify this sheet. */}
            Tapswipe — quote {title}, version {quote.version}, dated{" "}
            {formatDate(quote.created_at)}. Prices as quoted on that date.
          </footer>
        </PrintDocument>
      </article>
    </>
  );
}
