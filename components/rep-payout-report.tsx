"use client";

import { Fragment, useState } from "react";
import { MinusIcon, PlusIcon } from "lucide-react";

import { EMPTY, formatMoney, formatPeriod, formatText } from "@/lib/format";
import {
  DEDUCTIONS_HEADER,
  detailKey,
  type OverrideDetail,
  type RepSummaryRow,
} from "@/lib/reports";
import {
  Table,
  TableBody,
  TableCell,
  TableFooter,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/**
 * Report 1, the rep payout summary (memo §7.2, Owen's columns §0b.7).
 *
 * Every figure is a row of rep_payout_summary() as it came back: this
 * component formats, it never adds. Total agent commission is agent split plus
 * overrides received; deductions sit in their own column, headed so nobody
 * takes them as part of the total (§0c.1).
 *
 * The plus on a rep with override lines opens the detail row §4.5 describes:
 * each override taken from their merchants (percent, merchant, recipient)
 * and each one they received.
 *
 * Two layouts of the same rows: a table from `xl` up (and on paper), and one
 * card per rep below it, so at 360px every amount is on screen rather than
 * behind a sideways scroll.
 */

function detailText(line: OverrideDetail): string {
  const pct = line.pct === null ? "" : ` ${Number(line.pct)}%`;
  const merchant = `${formatText(line.merchant_name)} (${line.mid})`;
  return line.role === "debit"
    ? `Override${pct} on ${merchant}${line.counterpart ? ` · to ${line.counterpart}` : ""}`
    : `Received${pct} on ${merchant}${line.counterpart ? ` · from ${line.counterpart}` : ""}`;
}

function DetailList({ lines, testId }: { lines: readonly OverrideDetail[]; testId: string }) {
  return (
    <ul className="flex flex-col gap-1 text-xs" data-testid={testId}>
      {lines.map((line) => (
        <li key={line.id} className="flex flex-wrap justify-between gap-x-4">
          <span className="break-words text-muted-foreground">{detailText(line)}</span>
          <span className="font-medium tabular-nums">{formatMoney(line.amount)}</span>
        </li>
      ))}
    </ul>
  );
}

const FIGURES = [
  ["sales_volume", "Sales volume"],
  ["net_residual", "Net residual"],
  ["agent_split", "Agent split"],
  ["deductions", DEDUCTIONS_HEADER],
  ["overrides_received", "Override received"],
  ["total_commission", "Total agent commission"],
] as const;

function totalLabel(row: RepSummaryRow): string {
  return row.row_kind === "month" ? `${formatPeriod(row.period)} total` : "Total";
}

export function RepPayoutReport({
  rows,
  details,
  multiMonth,
}: {
  rows: readonly RepSummaryRow[];
  details: Record<string, OverrideDetail[]>;
  multiMonth: boolean;
}) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const toggle = (key: string) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const reps = rows.filter((r) => r.row_kind === "rep");
  // One month: its total is the grand total, so print it once.
  const totals = rows.filter((r) => r.row_kind === "total" || (multiMonth && r.row_kind === "month"));
  const months = [...new Set(reps.map((r) => r.period!))];

  return (
    <div className="flex flex-col gap-4" data-testid="rep-payout-report">
      {/* The table: xl and up, and print. */}
      <div className="hidden xl:block print:block">
        <Table aria-label="Rep payout summary">
          <TableHeader>
            <TableRow>
              <TableHead className="w-8"><span className="sr-only">Detail</span></TableHead>
              <TableHead>Agent code</TableHead>
              <TableHead>Legal name</TableHead>
              <TableHead>Full name</TableHead>
              {FIGURES.map(([key, label]) => (
                <TableHead key={key} className="whitespace-normal text-right">
                  {label}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {months.map((month) => (
              <Fragment key={month}>
                {multiMonth && (
                  <TableRow>
                    <TableCell colSpan={10} className="bg-muted/40 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                      {formatPeriod(month)}
                    </TableCell>
                  </TableRow>
                )}
                {reps.filter((r) => r.period === month).map((row) => {
                  const key = detailKey(row.agent_id!, row.period!);
                  const lines = details[key] ?? [];
                  const expanded = open.has(key);
                  return (
                    <Fragment key={key}>
                      <TableRow data-testid="report-rep-row" data-agent-code={row.agent_code ?? ""}>
                        <TableCell className="print:hidden">
                          {lines.length > 0 && (
                            <button
                              type="button"
                              onClick={() => toggle(key)}
                              aria-expanded={expanded}
                              aria-label={`${expanded ? "Hide" : "Show"} override detail for ${row.full_name ?? "this rep"}`}
                              className="flex h-6 w-6 items-center justify-center rounded border text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                            >
                              {expanded ? <MinusIcon size={14} /> : <PlusIcon size={14} />}
                            </button>
                          )}
                        </TableCell>
                        <TableCell className="font-mono text-xs">{row.agent_code ?? EMPTY}</TableCell>
                        <TableCell className="whitespace-normal">{formatText(row.legal_name)}</TableCell>
                        <TableCell className="whitespace-normal">{formatText(row.full_name)}</TableCell>
                        {FIGURES.map(([key2]) => (
                          <TableCell
                            key={key2}
                            className={
                              key2 === "total_commission"
                                ? "text-right font-semibold tabular-nums"
                                : key2 === "deductions"
                                  ? "text-right tabular-nums text-muted-foreground"
                                  : "text-right tabular-nums"
                            }
                          >
                            {formatMoney(row[key2])}
                          </TableCell>
                        ))}
                      </TableRow>
                      {expanded && (
                        <TableRow>
                          <TableCell />
                          <TableCell colSpan={9} className="whitespace-normal">
                            <DetailList lines={lines} testId="report-override-detail" />
                          </TableCell>
                        </TableRow>
                      )}
                    </Fragment>
                  );
                })}
              </Fragment>
            ))}
          </TableBody>
          <TableFooter>
            {totals.map((row) => (
              <TableRow key={`${row.row_kind}-${row.period ?? "all"}`} data-testid={`report-${row.row_kind}-row`}>
                <TableCell />
                <TableCell colSpan={3} className="font-semibold">{totalLabel(row)}</TableCell>
                {FIGURES.map(([key]) => (
                  <TableCell key={key} className="text-right font-semibold tabular-nums">
                    {formatMoney(row[key])}
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableFooter>
        </Table>
      </div>

      {/* The cards: below xl, never on paper. */}
      <div className="flex flex-col gap-3 xl:hidden print:hidden" data-testid="report-cards">
        {reps.map((row) => {
          const key = detailKey(row.agent_id!, row.period!);
          const lines = details[key] ?? [];
          return (
            <article key={key} className="rounded-xl border bg-card p-4" data-testid="report-rep-card">
              <header className="mb-3 flex flex-col gap-0.5">
                <p className="font-semibold">
                  <span className="mr-2 font-mono text-xs text-muted-foreground">{row.agent_code ?? EMPTY}</span>
                  {formatText(row.full_name)}
                </p>
                <p className="break-words text-sm text-muted-foreground">{formatText(row.legal_name)}</p>
                {multiMonth && <p className="text-xs text-muted-foreground">{formatPeriod(row.period)}</p>}
              </header>
              <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 text-sm">
                {FIGURES.map(([field, label]) => (
                  <Fragment key={field}>
                    <dt className={field === "total_commission" ? "font-semibold" : "text-muted-foreground"}>{label}</dt>
                    <dd className={field === "total_commission" ? "text-right font-semibold tabular-nums" : "text-right tabular-nums"}>
                      {formatMoney(row[field])}
                    </dd>
                  </Fragment>
                ))}
              </dl>
              {lines.length > 0 && (
                <details className="mt-3 border-t pt-2">
                  <summary className="cursor-pointer text-xs font-medium">Override detail</summary>
                  <div className="mt-2">
                    <DetailList lines={lines} testId="report-override-detail-card" />
                  </div>
                </details>
              )}
            </article>
          );
        })}
        {totals.map((row) => (
          <article
            key={`${row.row_kind}-${row.period ?? "all"}`}
            className="rounded-xl border bg-muted/40 p-4"
            data-testid={`report-${row.row_kind}-card`}
          >
            <p className="mb-3 font-semibold">{totalLabel(row)}</p>
            <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 text-sm">
              {FIGURES.map(([field, label]) => (
                <Fragment key={field}>
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className="text-right font-semibold tabular-nums">{formatMoney(row[field])}</dd>
                </Fragment>
              ))}
            </dl>
          </article>
        ))}
      </div>
    </div>
  );
}
