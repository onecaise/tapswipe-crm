"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { CalendarCheckIcon } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { formatDate } from "@/lib/format";
import { Callout } from "@/components/callout";
import { Button } from "@/components/ui/button";

/**
 * Reconciles a lead's `next_followup_date` with its earliest open task.
 *
 * ## Why these are two columns and not one
 *
 * `leads.next_followup_date` and the generic `tasks` table deliberately stay
 * separate. `tasks.owner_id` carries no foreign key — it points into four
 * different tables — and PostgREST needs one to embed, so a lead cannot cheaply
 * pull its own tasks. Collapsing the column into the table would cost the leads
 * list its single indexed query for "order by next follow-up, show overdue":
 * it becomes N+1 or a new view, and the "Unscheduled" filter becomes a NOT
 * EXISTS with no FK for the planner to use. A sync trigger was considered and
 * rejected too — it would fire the lead's own log_cross_agent_change(), so an
 * admin adding a task on a rep's lead would write two audit rows for one event.
 *
 * So the two can drift, and the accepted cost is real: a rep can leave the
 * follow-up blank while a task is due tomorrow, and the leads list files that
 * lead under "Unscheduled". This component is the whole mitigation — it makes
 * the drift visible on the page that holds both, and one click away from fixed.
 *
 * ## Why it writes the column rather than storing anything new
 *
 * The button sets `leads.next_followup_date` and nothing else. Nothing is
 * stored twice, so nothing can fall out of step afterwards; the next render
 * recomputes the comparison from the same two sources it did before. A
 * "linked task" column would be a third copy of the same fact and the first
 * thing to go stale when the task is completed or re-dated.
 *
 * Renders nothing when there is no dated open task — there is no second opinion
 * to reconcile against, and an empty prompt on every lead is noise.
 */
export function FollowupReconcile({
  leadId,
  nextFollowupDate,
  earliestTaskDue,
}: {
  leadId: number;
  nextFollowupDate: string | null;
  /** From earliestOpenTaskDue() in lib/annotations — the one definition. */
  earliestTaskDue: string | null;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (earliestTaskDue === null) return null;

  const matches = nextFollowupDate === earliestTaskDue;

  const adopt = async () => {
    setBusy(true);
    setError(null);

    const supabase = createClient();
    // count: "exact" for the reason the tasks panel uses it — RLS filters a
    // write it disallows rather than erroring, so a no-op would otherwise look
    // like a success until the next refresh contradicted it.
    const { error: updateError, count } = await supabase
      .from("leads")
      .update({ next_followup_date: earliestTaskDue }, { count: "exact" })
      .eq("id", leadId);

    if (updateError || count === 0) {
      setError(updateError?.message ?? "That follow-up date could not be set.");
      setBusy(false);
      return;
    }

    setBusy(false);
    router.refresh();
  };

  // A <time> rather than a bare string so the machine-readable date is on the
  // element too: formatDate renders in the viewer's locale, which is right for
  // reading and useless for anything asserting on it.
  const taskDate = (
    <time dateTime={earliestTaskDue} className="font-medium">
      {formatDate(earliestTaskDue)}
    </time>
  );

  if (matches) {
    return (
      <p
        data-slot="followup-reconcile"
        className="text-sm text-muted-foreground"
      >
        Follow-up matches the earliest open task, due {taskDate}.
      </p>
    );
  }

  return (
    // The data-slot sits on a wrapper rather than on Callout, which takes only
    // tone/className/children. Both branches carry it, so a spec can ask for
    // "the reconciliation block" without knowing which state it is in.
    <div data-slot="followup-reconcile">
      <Callout
        tone="warning"
        className="flex flex-wrap items-center justify-between gap-3"
      >
        <span>
          {nextFollowupDate === null
            ? "This lead has no follow-up date, but its earliest open task is due "
            : `Follow-up is set to ${formatDate(nextFollowupDate)}, but the earliest open task is due `}
          {taskDate}.
          {/* Said out loud, because the leads list is where it bites and this
              is the only page that can see both halves. */}
          {nextFollowupDate === null &&
            " Until it is set, the leads list files this lead under Unscheduled."}
        </span>

        <div className="flex flex-col items-end gap-1">
          <Button size="sm" disabled={busy} onClick={() => void adopt()}>
            <CalendarCheckIcon size={16} />
            {busy
              ? "Saving…"
              : `Set follow-up to ${formatDate(earliestTaskDue)}`}
          </Button>
          {error && <span className="text-sm text-destructive">{error}</span>}
        </div>
      </Callout>
    </div>
  );
}
