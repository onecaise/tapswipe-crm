import Link from "next/link";
import { Suspense } from "react";
import { PlusIcon } from "lucide-react";

import { requireUser } from "@/lib/auth";
import { formatDateTime, formatMoney } from "@/lib/format";
import {
  type ProposalSummary,
  isUuid,
  loadProposalList,
  loadRepNames,
} from "@/lib/quotes-data";
import { newProposalHref, proposalHref } from "@/lib/quotes";
import { PageHeader } from "@/components/page-header";
import { PageShell } from "@/components/page-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type SearchParams = { q?: string; rep?: string };

/**
 * Whether a proposal matches the search box: its customer or its title.
 *
 * Applied to the CURRENT version, which is what the row shows — matching a
 * superseded version's title would list a row that displays none of the
 * words searched for.
 */
function matches(summary: ProposalSummary, needle: string): boolean {
  if (needle === "") return true;
  const { customer_name, title } = summary.group.current;
  return [customer_name, title].some(
    (field) => field !== null && field.toLowerCase().includes(needle),
  );
}

async function ProposalList({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const profile = await requireUser();
  const isAdmin = profile.role === "admin";
  const { q, rep } = await searchParams;
  const needle = (q ?? "").trim().toLowerCase();

  // The rep filter is an admin's, and only a well-formed uuid is accepted —
  // anything else is ignored rather than sent to PostgREST as a 22P02. For a
  // rep it is not offered: RLS already narrows their list to their own, so
  // every value would be their list again or an empty one.
  const repFilter = isAdmin && rep && isUuid(rep) ? rep : null;

  const [summaries, repNames] = await Promise.all([
    loadProposalList(repFilter),
    isAdmin ? loadRepNames() : Promise.resolve(new Map<string, string>()),
  ]);
  const shown = summaries.filter((summary) => matches(summary, needle));

  return (
    <>
      <form
        method="get"
        className="flex flex-col gap-2 sm:flex-row sm:items-end"
        role="search"
      >
        <div className="grid min-w-0 flex-1 gap-1.5">
          <label htmlFor="proposal-search" className="text-xs text-muted-foreground">
            Search
          </label>
          <Input
            id="proposal-search"
            name="q"
            defaultValue={q ?? ""}
            placeholder="Customer or title"
          />
        </div>
        {isAdmin && (
          <div className="grid gap-1.5">
            <label htmlFor="proposal-rep" className="text-xs text-muted-foreground">
              Rep
            </label>
            <select
              id="proposal-rep"
              name="rep"
              defaultValue={repFilter ?? ""}
              className="h-9 rounded-md border bg-background px-2 text-sm"
            >
              <option value="">All reps</option>
              {[...repNames.entries()].map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          </div>
        )}
        <Button type="submit" variant="outline">
          Apply
        </Button>
      </form>

      {shown.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {summaries.length === 0
            ? "No proposals yet."
            : "No proposal matches that search."}
        </p>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Customer</TableHead>
                {isAdmin && <TableHead>Rep</TableHead>}
                <TableHead>Version</TableHead>
                <TableHead className="text-right">One-time</TableHead>
                <TableHead className="text-right">Monthly</TableHead>
                <TableHead>Last updated</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {shown.map(({ group, totals }) => (
                <TableRow key={group.quoteGroupId}>
                  <TableCell className="max-w-64">
                    <Link
                      href={proposalHref(group.quoteGroupId)}
                      className="block truncate font-medium text-primary hover:underline"
                    >
                      {group.current.customer_name}
                    </Link>
                    {group.current.title && (
                      <span className="block truncate text-xs text-muted-foreground">
                        {group.current.title}
                      </span>
                    )}
                  </TableCell>
                  {isAdmin && (
                    <TableCell>
                      {repNames.get(group.current.agent_id) ?? "—"}
                    </TableCell>
                  )}
                  <TableCell>v{group.current.version}</TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatMoney(totals.oneTime)}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {totals.monthly > 0 ? formatMoney(totals.monthly) : "—"}
                  </TableCell>
                  {/* The current version's creation: a version is never
                      edited, so the newest one IS the last update. Status
                      changes are not versions and do not move this. */}
                  <TableCell className="whitespace-nowrap">
                    {formatDateTime(group.current.created_at)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </>
  );
}

export default function ProposalsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  return (
    <PageShell width="list">
      <PageHeader
        title="Proposals"
        subtitle="Hardware proposals, each with its full version history."
        action={
          <Button asChild>
            <Link href={newProposalHref()}>
              <PlusIcon size={16} />
              New proposal
            </Link>
          </Button>
        }
      />
      <Suspense
        fallback={<p className="text-sm text-muted-foreground">Loading…</p>}
      >
        <ProposalList searchParams={searchParams} />
      </Suspense>
    </PageShell>
  );
}
