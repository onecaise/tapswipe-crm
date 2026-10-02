import Link from "next/link";
import { HistoryIcon } from "lucide-react";

import { formatDateTime } from "@/lib/format";
import {
  EVENT_LABELS,
  type MarketingEvent,
  type MarketingMaterial,
} from "@/lib/marketing-materials";
import { MarketingLibrary } from "@/components/marketing-library";

/**
 * The marketing library as it appears on a lead: the collateral, plus what has
 * already been sent to THIS lead.
 *
 * The history half is the reason this is not just <MarketingLibrary> dropped
 * onto the page. A rep about to send a rate card needs to know they sent one
 * last week, and an admin reviewing a stalled deal needs to see whether
 * anything was ever sent at all. Neither question is answerable from the
 * library alone.
 *
 * Events are read own-or-admin by policy, so a rep sees their own trail and an
 * admin sees everyone's on that lead — which is the right asymmetry: the admin
 * is the one auditing, and the rep has no business reading another rep's
 * activity even on a lead they can both somehow see.
 */
export function MarketingPanel({
  materials,
  events,
  materialTitles,
  leadId,
  agentId,
}: {
  materials: MarketingMaterial[];
  events: MarketingEvent[];
  /** material_id -> title, so the history can name a material it does not hold. */
  materialTitles: Map<number, string>;
  leadId: number;
  agentId: string;
}) {
  return (
    <section className="flex flex-col gap-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-semibold text-lg">Marketing materials</h2>
        <Link
          href="/marketing"
          className="text-sm text-primary hover:underline"
        >
          Browse the whole library
        </Link>
      </div>

      <MarketingLibrary
        materials={materials}
        leadId={leadId}
        agentId={agentId}
        emptyMessage="No marketing materials have been published yet. An admin adds them from the library."
      />

      <div className="flex flex-col gap-2">
        <h3 className="text-xs uppercase tracking-wide text-muted-foreground flex items-center gap-2">
          <HistoryIcon size={13} />
          Sent to this lead
        </h3>
        {events.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing sent to this lead yet.
          </p>
        ) : (
          <ul className="flex flex-col divide-y rounded-md border">
            {events.map((event) => (
              <li
                key={event.id}
                className="flex flex-wrap items-center justify-between gap-3 px-3 py-2"
              >
                <span className="text-sm truncate">
                  {/* A material can be archived after an event names it — that
                      is the whole reason archiving exists instead of deleting.
                      The title still resolves, because the row is still there.
                      The fallback covers the one case it cannot: an event whose
                      material the CALLER cannot see, which no policy produces
                      today but would be a blank line rather than an error if it
                      ever did. */}
                  {materialTitles.get(event.material_id) ?? "A material"}
                </span>
                <span className="text-xs text-muted-foreground shrink-0">
                  {EVENT_LABELS[event.event_type]} ·{" "}
                  {formatDateTime(event.occurred_at)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
