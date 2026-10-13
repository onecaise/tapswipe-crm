import Link from "next/link";
import { Suspense } from "react";
import { ArrowLeftIcon } from "lucide-react";

import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import {
  MISSING_LOCATION_FILTER,
  type Merchant,
  statusIntent,
} from "@/lib/merchants";
import { formatText } from "@/lib/format";
import { PageHeader } from "@/components/page-header";
import { PageShell } from "@/components/page-shell";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";

/**
 * Merchants with no city or state — the rows that predate the location
 * columns (20261013130000). merchants_location_guard requires a location on
 * every NEW merchant, so this list only shrinks.
 *
 * READ-ONLY, on purpose. There is no bulk fill and no inline editor: a city
 * someone guessed is worse than a blank one somebody can see is blank, so each
 * row links to the merchant and the location is supplied through the ordinary
 * edit form — the save that the constraint now requires to carry a location
 * anyway, and one merchants_audit_cross_agent records. What a linked pre-app
 * can supply is filled by scripts/backfill-merchant-location.sql, reviewed and
 * run by hand; this list is what is left after it.
 *
 * Two boundaries, as on the other admin pages: requireAdmin() keeps reps off
 * the route, and RLS would scope the rows to a rep's own book regardless.
 */
async function MissingLocationList() {
  await requireAdmin();
  const supabase = await createClient();

  const { data, error } = await supabase
    .from("merchants")
    .select("id, agent_id, dba, legal_business_name, status")
    .or(MISSING_LOCATION_FILTER)
    .order("dba", { ascending: true })
    .order("id", { ascending: true });

  if (error) {
    return (
      <p className="text-sm text-destructive">
        Could not load merchants: {error.message}
      </p>
    );
  }

  const merchants = (data ?? []) as Pick<
    Merchant,
    "id" | "agent_id" | "dba" | "legal_business_name" | "status"
  >[];

  if (merchants.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Every merchant has a city and state.
      </p>
    );
  }

  // One read for the rep names, rather than an embed: merchants.agent_id is
  // the FK, but the detail page already resolves names this way and the two
  // should not disagree about who a rep is.
  const agentIds = [...new Set(merchants.map((m) => m.agent_id))];
  const { data: agents } = await supabase
    .from("profiles")
    .select("id, full_name")
    .in("id", agentIds);
  const nameOf = new Map(
    (agents ?? []).map((a) => [a.id as string, a.full_name as string]),
  );

  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">
        {merchants.length === 1
          ? "1 merchant has"
          : `${merchants.length} merchants have`}{" "}
        no city or state. Open one and edit it to add the location.
      </p>
      <ul className="flex flex-col gap-2" aria-label="Merchants missing a location">
        {merchants.map((m) => (
          <li
            key={m.id}
            className="flex flex-col gap-1 rounded-md border bg-card p-3 sm:flex-row sm:items-center sm:justify-between sm:gap-4"
          >
            <div className="flex min-w-0 flex-col">
              <Link
                href={`/merchants/${m.id}`}
                className="truncate font-medium underline underline-offset-4"
              >
                {m.dba}
              </Link>
              <span className="truncate text-xs text-muted-foreground">
                {formatText(m.legal_business_name)}
              </span>
            </div>
            <div className="flex min-w-0 items-center gap-3 text-sm">
              <span className="truncate text-muted-foreground">
                {nameOf.get(m.agent_id) ?? "Unknown rep"}
              </span>
              <StatusBadge intent={statusIntent(m.status)}>{m.status}</StatusBadge>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function MissingLocationPage() {
  return (
    <PageShell width="detail">
      <Button asChild variant="ghost" size="sm" className="self-start">
        <Link href="/dashboard">
          <ArrowLeftIcon size={16} />
          Back to dashboard
        </Link>
      </Button>
      <PageHeader title="Merchants missing a location" />
      <Suspense
        fallback={<p className="text-sm text-muted-foreground">Loading…</p>}
      >
        <MissingLocationList />
      </Suspense>
    </PageShell>
  );
}
