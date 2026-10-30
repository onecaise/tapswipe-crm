"use client";

import { useState } from "react";

import { warningsConfirmed } from "@/lib/payouts";
import { Callout } from "@/components/callout";
import { ResidualCommitButton } from "@/components/residual-commit-button";
import { Button } from "@/components/ui/button";

export type WarningBlock = {
  warning: string;
  label: string;
  question: string;
  rows: { rowNumber: number; text: string }[];
};

/** Rows listed before the rest fold away: fee and clawback rows come in bulk. */
const SHOWN = 5;

/**
 * The review screen's yes/no blocks, ONE PER WARNING TYPE present in the
 * import, never one per line (memo §0b.3), and the commit button they gate.
 *
 * The commit is offered only when the import is not refused (`ready`) and every
 * type present has a yes. A no keeps it closed and says what to do instead. The
 * answers are this page's state: nothing stores them in this phase, because the
 * commit is still v2, which reads no warnings. Phase 8's v3 takes the confirmed
 * types as an argument, recomputes every warning itself and refuses a type that
 * was not confirmed -- the database, not this component, is what will enforce
 * the yes.
 */
export function ResidualWarningConfirmations({
  batchId,
  rowCount,
  ready,
  blocks,
}: {
  batchId: number;
  rowCount: number;
  ready: boolean;
  blocks: WarningBlock[];
}) {
  const [answers, setAnswers] = useState<Record<string, "yes" | "no">>({});
  const present = blocks.map((block) => block.warning);
  const confirmed = warningsConfirmed(present, answers);
  const refusedByAdmin = present.some((warning) => answers[warning] === "no");

  return (
    <div className="flex flex-col gap-4">
      {blocks.length > 0 && (
        <section className="flex flex-col gap-2" data-testid="import-warnings">
          <h2 className="text-sm font-semibold tracking-tight">
            Confirm before committing
          </h2>
          <p className="text-xs text-muted-foreground">
            One answer per kind of warning covers every row listed under it.
          </p>
          {blocks.map((block) => {
            const answer = answers[block.warning];
            return (
              <div
                key={block.warning}
                role="group"
                aria-label={block.label}
                data-warning={block.warning}
                className="flex flex-col gap-2 rounded-xl border bg-card px-4 py-3"
              >
                <p className="text-sm font-medium">
                  {block.label}
                  <span className="ml-2 font-normal text-muted-foreground">
                    {block.rows.length} row{block.rows.length === 1 ? "" : "s"}
                  </span>
                </p>
                <RowList rows={block.rows} />
                <div className="flex flex-wrap items-center gap-2">
                  <span className="text-sm">{block.question}</span>
                  <Button
                    type="button"
                    size="sm"
                    variant={answer === "yes" ? "default" : "outline"}
                    aria-pressed={answer === "yes"}
                    onClick={() =>
                      setAnswers((prev) => ({ ...prev, [block.warning]: "yes" }))
                    }
                  >
                    Yes
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant={answer === "no" ? "default" : "outline"}
                    aria-pressed={answer === "no"}
                    onClick={() =>
                      setAnswers((prev) => ({ ...prev, [block.warning]: "no" }))
                    }
                  >
                    No
                  </Button>
                </div>
              </div>
            );
          })}
        </section>
      )}

      {ready && refusedByAdmin && (
        <Callout tone="warning">
          <p className="font-medium">This import will not be committed as it stands.</p>
          <p className="mt-1 text-muted-foreground">
            Abandon it, or correct the merchants or the file and choose &ldquo;Read
            again&rdquo;.
          </p>
        </Callout>
      )}

      {ready && !refusedByAdmin && (
        <Callout tone="success">
          <p className="font-medium">
            {confirmed
              ? `All ${rowCount} rows read. This import is ready.`
              : "Answer each question above to commit."}
          </p>
          <p className="mt-1 text-muted-foreground">
            Each line is paid to the owner of the merchant its MID names.
          </p>
          {confirmed && (
            <div className="mt-3">
              <ResidualCommitButton batchId={batchId} rowCount={rowCount} />
            </div>
          )}
        </Callout>
      )}
    </div>
  );
}

/** The first few rows, then the rest behind a disclosure. */
export function RowList({ rows }: { rows: { rowNumber: number; text: string }[] }) {
  const item = (row: { rowNumber: number; text: string }) => (
    <li key={row.rowNumber} className="break-words text-xs text-muted-foreground">
      {/* The spreadsheet line, because that is what an admin counts when they
          open the file to fix it. */}
      Row {row.rowNumber} — {row.text}
    </li>
  );
  return (
    <div className="flex flex-col gap-0.5">
      <ul className="flex flex-col gap-0.5">{rows.slice(0, SHOWN).map(item)}</ul>
      {rows.length > SHOWN && (
        <details>
          <summary className="cursor-pointer text-xs text-muted-foreground underline underline-offset-4">
            {rows.length - SHOWN} more
          </summary>
          <ul className="mt-0.5 flex flex-col gap-0.5">{rows.slice(SHOWN).map(item)}</ul>
        </details>
      )}
    </div>
  );
}
