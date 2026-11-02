import { Fragment } from "react";

import { EMPTY, formatMoney, formatPeriod, formatText } from "@/lib/format";
import type { MerchantSummaryRow } from "@/lib/reports";
import { StatusBadge } from "@/components/status-badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/**
 * Report 2, merchants by processor (memo §7.2): one row per MID per
 * processor-month, a subtotal per processor-month, and the grand total, every
 * one a row of merchant_processor_summary() as it came back.
 *
 * Residual is the account's (a shared account once, on its signer); rep side
 * is the merchant's rate of it, before any override; company share is the
 * rest. The subtotal says whether the processor-month is marked paid.
 *
 * A table from `xl` up and on paper; one card per merchant below it, so at
 * 360px every amount is on screen.
 */

const FIGURES = [
  ["volume", "Volume"],
  ["residual", "Residual"],
  ["rep_side", "Rep side"],
  ["company_share", "Company share"],
] as const;

type Group = { period: string; processor: string | null; lines: MerchantSummaryRow[]; subtotal?: MerchantSummaryRow };

function groupsOf(rows: readonly MerchantSummaryRow[]): Group[] {
  const groups = new Map<string, Group>();
  for (const row of rows) {
    if (row.row_kind === "total") continue;
    const key = `${row.period}|${row.processor ?? ""}`;
    const group = groups.get(key) ?? { period: row.period!, processor: row.processor, lines: [] };
    if (row.row_kind === "merchant") group.lines.push(row);
    else group.subtotal = row;
    groups.set(key, group);
  }
  return [...groups.values()];
}

function PaidBadge({ paidAt }: { paidAt: string | null | undefined }) {
  return paidAt ? (
    <StatusBadge intent="success">paid</StatusBadge>
  ) : (
    <StatusBadge intent="warning">not marked paid</StatusBadge>
  );
}

const owner = (row: MerchantSummaryRow) =>
  row.owner_name === null && row.owner_code === null
    ? EMPTY
    : `${row.owner_code ?? EMPTY} · ${formatText(row.owner_name)}`;

function groupLabel(group: Group, multiMonth: boolean): string {
  const name = group.processor ?? "No processor";
  return multiMonth ? `${name} · ${formatPeriod(group.period)}` : name;
}

export function MerchantProcessorReport({
  rows,
  paid,
  multiMonth,
}: {
  rows: readonly MerchantSummaryRow[];
  /** When each processor-month was marked paid, keyed `processor|YYYY-MM-DD`. */
  paid: ReadonlyMap<string, string>;
  multiMonth: boolean;
}) {
  const groups = groupsOf(rows);
  const total = rows.find((r) => r.row_kind === "total");
  const paidAt = (group: Group) => paid.get(`${group.processor}|${group.period}`);

  return (
    <div className="flex flex-col gap-4" data-testid="merchant-processor-report">
      <div className="hidden xl:block print:block">
        <Table aria-label="Merchants by processor">
          <TableHeader>
            <TableRow>
              <TableHead>Processor</TableHead>
              <TableHead>Merchant</TableHead>
              <TableHead>Owner</TableHead>
              {FIGURES.map(([key, label]) => (
                <TableHead key={key} className="text-right">{label}</TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {groups.map((group) => (
              <Fragment key={`${group.period}|${group.processor}`}>
                {group.lines.map((row) => (
                  <TableRow key={`${row.period}|${row.processor}|${row.mid}`} data-testid="report-merchant-row">
                    <TableCell>{group.processor ?? EMPTY}</TableCell>
                    <TableCell className="whitespace-normal">
                      {formatText(row.merchant_name)}
                      <span className="block font-mono text-xs text-muted-foreground">{row.mid}</span>
                    </TableCell>
                    <TableCell className="whitespace-normal">{owner(row)}</TableCell>
                    {FIGURES.map(([key]) => (
                      <TableCell key={key} className="text-right tabular-nums">{formatMoney(row[key])}</TableCell>
                    ))}
                  </TableRow>
                ))}
                {group.subtotal && (
                  <TableRow className="bg-muted/40" data-testid="report-processor-row">
                    <TableCell colSpan={3} className="font-semibold">
                      {groupLabel(group, multiMonth)} subtotal <PaidBadge paidAt={paidAt(group)} />
                    </TableCell>
                    {FIGURES.map(([key]) => (
                      <TableCell key={key} className="text-right font-semibold tabular-nums">
                        {formatMoney(group.subtotal![key])}
                      </TableCell>
                    ))}
                  </TableRow>
                )}
              </Fragment>
            ))}
            {total && (
              <TableRow className="border-t-2" data-testid="report-total-row">
                <TableCell colSpan={3} className="font-semibold">Grand total</TableCell>
                {FIGURES.map(([key]) => (
                  <TableCell key={key} className="text-right font-semibold tabular-nums">{formatMoney(total[key])}</TableCell>
                ))}
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <div className="flex flex-col gap-4 xl:hidden print:hidden" data-testid="report-cards">
        {groups.map((group) => (
          <section key={`${group.period}|${group.processor}`} className="flex flex-col gap-2">
            <h3 className="flex flex-wrap items-center gap-2 text-sm font-semibold">
              {groupLabel(group, multiMonth)} <PaidBadge paidAt={paidAt(group)} />
            </h3>
            {group.lines.map((row) => (
              <article key={row.mid} className="rounded-xl border bg-card p-4" data-testid="report-merchant-card">
                <p className="break-words font-semibold">{formatText(row.merchant_name)}</p>
                <p className="break-all font-mono text-xs text-muted-foreground">{row.mid}</p>
                <p className="mb-2 break-words text-sm text-muted-foreground">{owner(row)}</p>
                <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 text-sm">
                  {FIGURES.map(([key, label]) => (
                    <Fragment key={key}>
                      <dt className="text-muted-foreground">{label}</dt>
                      <dd className="text-right tabular-nums">{formatMoney(row[key])}</dd>
                    </Fragment>
                  ))}
                </dl>
              </article>
            ))}
            {group.subtotal && (
              <article className="rounded-xl border bg-muted/40 p-4" data-testid="report-processor-card">
                <p className="mb-2 font-semibold">{groupLabel(group, multiMonth)} subtotal</p>
                <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 text-sm">
                  {FIGURES.map(([key, label]) => (
                    <Fragment key={key}>
                      <dt className="text-muted-foreground">{label}</dt>
                      <dd className="text-right font-semibold tabular-nums">{formatMoney(group.subtotal![key])}</dd>
                    </Fragment>
                  ))}
                </dl>
              </article>
            )}
          </section>
        ))}
        {total && (
          <article className="rounded-xl border bg-muted/40 p-4" data-testid="report-total-card">
            <p className="mb-2 font-semibold">Grand total</p>
            <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 text-sm">
              {FIGURES.map(([key, label]) => (
                <Fragment key={key}>
                  <dt className="text-muted-foreground">{label}</dt>
                  <dd className="text-right font-semibold tabular-nums">{formatMoney(total[key])}</dd>
                </Fragment>
              ))}
            </dl>
          </article>
        )}
      </div>
    </div>
  );
}
