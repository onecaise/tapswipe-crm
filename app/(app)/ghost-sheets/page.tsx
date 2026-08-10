import Link from "next/link";
import { Suspense } from "react";
import { PlusIcon } from "lucide-react";

import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import {
  GHOST_SHEET_FILTER_OPTIONS,
  GHOST_SHEET_LIST_COLUMNS,
  type GhostSheetListRow,
  isConverted,
  parseGhostSheetFilter,
} from "@/lib/ghost-sheets";
import { formatDate, formatText } from "@/lib/format";
import { FilterTabs } from "@/components/filter-tabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

async function GhostSheetsList({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string }>;
}) {
  const { filter: rawFilter } = await searchParams;
  const filter = parseGhostSheetFilter(rawFilter);

  const profile = await requireUser();
  const supabase = await createClient();

  // Tier 1: RLS scopes the rows; no agent_id filter in application code.
  let query = supabase
    .from("ghost_sheets")
    .select(GHOST_SHEET_LIST_COLUMNS)
    .order("created_at", { ascending: false })
    .order("id", { ascending: false });

  // lead_id, not status: it's the column conversion actually writes, so it
  // can't drift from reality the way an unconstrained status string could.
  if (filter === "open") {
    query = query.is("lead_id", null);
  } else if (filter === "converted") {
    query = query.not("lead_id", "is", null);
  }

  const { data, error } = await query;

  if (error) {
    return (
      <p className="text-sm text-red-500">
        Could not load ghost sheets: {error.message}
      </p>
    );
  }

  const sheets = (data ?? []) as GhostSheetListRow[];
  const isAdmin = profile.role === "admin";

  let agentNames = new Map<string, string>();
  if (isAdmin && sheets.length > 0) {
    const agentIds = [...new Set(sheets.map((s) => s.agent_id))];
    const { data: agents } = await supabase
      .from("profiles")
      .select("id, full_name")
      .in("id", agentIds);
    agentNames = new Map(
      (agents ?? []).map((a) => [a.id as string, a.full_name as string]),
    );
  }

  return (
    <div className="flex flex-col gap-4">
      <FilterTabs
        options={GHOST_SHEET_FILTER_OPTIONS}
        active={filter}
        hrefFor={(value) =>
          value === "all" ? "/ghost-sheets" : `/ghost-sheets?filter=${value}`
        }
      />

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>DBA</TableHead>
            <TableHead>Contact</TableHead>
            <TableHead>Phone</TableHead>
            <TableHead>Converted</TableHead>
            {isAdmin && <TableHead>Agent</TableHead>}
            <TableHead>Created</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sheets.length === 0 ? (
            <TableRow>
              <TableCell
                colSpan={isAdmin ? 6 : 5}
                className="text-muted-foreground"
              >
                {filter === "all"
                  ? "No ghost sheets yet."
                  : `No ${filter} ghost sheets.`}
              </TableCell>
            </TableRow>
          ) : (
            sheets.map((sheet) => (
              <TableRow key={sheet.id}>
                <TableCell className="font-medium">
                  <Link
                    href={`/ghost-sheets/${sheet.id}`}
                    className="underline underline-offset-4"
                  >
                    {formatText(sheet.dba)}
                  </Link>
                </TableCell>
                <TableCell>{formatText(sheet.contact_name)}</TableCell>
                <TableCell>{formatText(sheet.contact_phone)}</TableCell>
                <TableCell>
                  {isConverted(sheet) ? (
                    <Link
                      href={`/leads/${sheet.lead_id}`}
                      className="underline underline-offset-4"
                    >
                      <Badge>converted</Badge>
                    </Link>
                  ) : (
                    <Badge variant="outline">open</Badge>
                  )}
                </TableCell>
                {isAdmin && (
                  <TableCell className="text-muted-foreground">
                    {formatText(agentNames.get(sheet.agent_id))}
                  </TableCell>
                )}
                <TableCell className="text-muted-foreground">
                  {formatDate(sheet.created_at)}
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>
    </div>
  );
}

export default function GhostSheetsPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string }>;
}) {
  return (
    <div className="flex-1 w-full flex flex-col gap-6 max-w-6xl mx-auto">
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-bold">Ghost Sheets</h1>
          <p className="text-sm text-muted-foreground">
            Lightweight pre-lead capture. Convert one to promote it to a full
            lead.
          </p>
        </div>
        <Button asChild size="sm">
          <Link href="/ghost-sheets/new">
            <PlusIcon size={16} />
            New ghost sheet
          </Link>
        </Button>
      </div>

      <Suspense
        fallback={
          <p className="text-sm text-muted-foreground">Loading ghost sheets…</p>
        }
      >
        <GhostSheetsList searchParams={searchParams} />
      </Suspense>
    </div>
  );
}
