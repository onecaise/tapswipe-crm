import Link from "next/link";

import { formatDateTime } from "@/lib/format";
import {
  TIMELINE_SOURCE_LABELS,
  type LeadTimeline,
  type TimelineEntry,
} from "@/lib/timeline";

/**
 * The lead's chronological feed, newest first.
 *
 * A server component with no client JavaScript, like components/dashboard-filters.tsx
 * — there is nothing interactive here. Every row is already resolved by the
 * time it arrives: `lib/timeline.ts` decides the wording, the ordering and
 * whether a byline may be shown at all, so this file only lays it out.
 *
 * ## It renders only what the caller could already read
 *
 * There is no fetching in here and no role prop. A rep's feed arrives with no
 * `audit` entries in it because `audit_log`'s policy is `using (is_admin())`
 * with no own-row branch — see the header of lib/timeline.ts. The component
 * does not know which role is looking at it and must not start caring: a
 * `isAdmin` prop would be a copy of a policy in a React component, which is
 * the furthest possible place from where the decision belongs.
 *
 * ## And it says nothing about what it is not showing
 *
 * Deliberately. A permanent "administrative events are admin-only" line would
 * be wallpaper on every lead — the thing components/followup-reconcile.tsx
 * renders nothing to avoid — and a conditional one would be worse: it would
 * announce to a rep that somebody had touched their record, which is precisely
 * what the admin-only policy exists to keep quiet. So a rep sees a shorter
 * feed, with nothing drawing attention to the gap.
 */

/**
 * The source chip.
 *
 * Muted rather than coloured, and deliberately NOT a StatusBadge: those carry
 * the success/warning/neutral palette, which is reserved for a record's state.
 * A source is a category, not a status, and borrowing the status colours here
 * would put the same green on "Note" that a merchant's approval wears.
 */
function SourceChip({ source }: { source: TimelineEntry["source"] }) {
  return (
    <span className="shrink-0 rounded border bg-muted px-1.5 py-0.5 text-xs uppercase tracking-wide text-muted-foreground">
      {TIMELINE_SOURCE_LABELS[source]}
    </span>
  );
}

/**
 * The byline, which has three distinct states and renders all three.
 *
 * A name, nobody, or an automated write — and collapsing the last two loses
 * real information. `actorName === null` on an entry whose source CAN name an
 * actor means the lookup came back empty, which for a rep is every author but
 * themselves (the `profiles` select policy is own-row plus admin). An audit row
 * with `actor_id` null is a different fact: a service-role or function write
 * with no `auth.uid()` at all, which is a normal event rather than a gap.
 *
 * The two are told apart by the SOURCE rather than by a flag, because only the
 * audit source can produce a genuinely actorless row: notes, tasks and
 * marketing events all have `agent_id not null`.
 */
function Byline({ entry }: { entry: TimelineEntry }) {
  if (entry.actorName !== null) {
    return <span>{entry.actorName}</span>;
  }
  if (entry.source === "audit") {
    return <span>Automated</span>;
  }
  // documents and quotes reach here by design — their agent_id is the owning
  // rep rather than whoever acted, so there is no honest name to print. See
  // lib/timeline.ts on why a plausible wrong byline is worse than none.
  return null;
}

export function LeadTimeline({ timeline }: { timeline: LeadTimeline }) {
  const { entries, truncated } = timeline;

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="font-semibold text-lg">Timeline</h2>
        {truncated && (
          <p className="text-xs text-muted-foreground">
            Showing the {entries.length} most recent events.
          </p>
        )}
      </div>

      {entries.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nothing has been recorded on this lead yet.
        </p>
      ) : (
        <ol className="flex flex-col divide-y rounded-md border">
          {entries.map((entry) => {
            const byline = <Byline entry={entry} />;
            return (
              <li
                key={entry.key}
                className="flex flex-col gap-1 px-3 py-2.5 sm:flex-row sm:items-start sm:gap-3"
              >
                <SourceChip source={entry.source} />

                {/* min-w-0 is what lets the long detail below wrap instead of
                    forcing the row wider than the card — the flex child's
                    default min-width:auto is what pushed six payout columns
                    off screen. */}
                <div className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="text-sm font-medium">
                    {entry.href === null ? (
                      entry.title
                    ) : (
                      <Link
                        href={entry.href}
                        className="text-primary hover:underline"
                      >
                        {entry.title}
                      </Link>
                    )}
                  </span>

                  {entry.detail !== null && entry.detail !== "" && (
                    // whitespace-pre-line so a multi-line note reads as it was
                    // typed; break-words so one long URL in a note body cannot
                    // widen the row.
                    <span className="whitespace-pre-line break-words text-sm text-muted-foreground">
                      {entry.detail}
                    </span>
                  )}
                </div>

                <div className="flex shrink-0 flex-col gap-0.5 text-xs text-muted-foreground sm:items-end">
                  {/* formatDateTime, not formatDate: a timeline is routinely
                      several events on one day, and rows all reading the same
                      date cannot be ordered by eye. It returns EMPTY for a null
                      timestamp, which is also where those rows sort to. */}
                  <span>{formatDateTime(entry.at)}</span>
                  {byline}
                </div>
              </li>
            );
          })}
        </ol>
      )}
    </section>
  );
}
