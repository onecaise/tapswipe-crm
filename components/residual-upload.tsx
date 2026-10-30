"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { UploadIcon } from "lucide-react";

import { callAdminFunction } from "@/lib/admin-users";
import { formatDate, formatPeriod } from "@/lib/format";
import { createClient } from "@/lib/supabase/client";
import type { Processor } from "@/lib/processors";
import { RESIDUAL_BUCKET } from "@/lib/payouts";
import { abandonResidualBatch } from "@/lib/residual-batches";
import { Callout } from "@/components/callout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type MintedUpload = {
  batch_id: number;
  path: string;
  token: string;
  fileKey: string;
};

/** What residual-import-file-url answers when that month is already committed. */
type CommittedMonth = {
  batch_id: number;
  file_name: string;
  committed_at: string | null;
  paid: boolean;
};

type MintResponse = MintedUpload | { exists: CommittedMonth };

type ParseResult = {
  batch_id: number;
  row_count: number;
  blocked_count: number;
};

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

const SELECT_CLASS =
  "border-input bg-background ring-offset-background focus-visible:ring-ring flex h-9 w-full rounded-md border px-3 py-1 text-sm focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none disabled:opacity-50";

/**
 * Uploads a residual XLSX for one processor and month, and sends the admin to
 * its review screen.
 *
 * The processor and month are chosen HERE and are the batch's (phase 7 of
 * docs/design/intake-and-reports.md, §2.2): the file has no Period column, and
 * its Processor column is only compared against this choice. `months` is the
 * import window (this month and the 24 before it, A11), computed on the server;
 * the database's guard_payout_batch_period() is the authority.
 *
 * Three steps, and the order is forced by the Storage key containing the batch id:
 *
 *   1. residual-import-file-url creates the batch row and signs an upload URL --
 *      or, when that processor and month is already COMMITTED, creates nothing
 *      and says so, and this asks "Replace it?" (phase 9). Yes asks again with
 *      replace_batch_id, which creates a batch that REPLACES the committed one;
 *      it then goes through the same read, review and confirm steps, and the
 *      replace happens at commit (commit_residual_import_v3). A month marked
 *      paid is not offered the Yes: it is refused, and says how to fix it.
 *   2. The browser PUTs the file straight to Storage. The bytes never pass
 *      through a function.
 *   3. parse-residual-import reads the stored file and stages its rows.
 *
 * A file the parser REFUSES outright (a 400: not a spreadsheet, a missing
 * column, a CRM export) is abandoned straight away -- it can never parse, so a
 * `review` row for it was only clutter (D-08). An empty file is refused before
 * step 1. Any other failure at step 2 or 3 leaves a `review` batch with
 * row_count 0, which the list shows and offers to re-read or abandon.
 *
 * Nothing here is a security boundary. Both functions verify the caller is an
 * active admin server-side; the page's requireAdmin() only keeps a rep from
 * seeing a form that would reject them.
 */
export function ResidualUpload({
  processors,
  months,
}: {
  processors: readonly Processor[];
  /** The months that may be imported, `YYYY-MM-01`, newest first. */
  months: readonly string[];
}) {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);

  const [processor, setProcessor] = useState("");
  const [year, setYear] = useState("");
  const [month, setMonth] = useState("");
  const [busy, setBusy] = useState<null | "uploading" | "parsing">(null);
  const [error, setError] = useState<string | null>(null);
  const [committed, setCommitted] = useState<
    (CommittedMonth & { processor: string; period: string; file: File }) | null
  >(null);

  const years = [...new Set(months.map((value) => value.slice(0, 4)))];
  const monthsInYear = months
    .filter((value) => value.startsWith(`${year}-`))
    .map((value) => value.slice(5, 7))
    .sort();
  const period = year && month ? `${year}-${month}-01` : "";

  const upload = async (file: File, replaceBatchId?: number) => {
    setError(null);
    setCommitted(null);

    if (processor === "") {
      setError("Choose the processor this file is from.");
      return;
    }
    if (period === "" || !months.includes(period)) {
      setError("Choose the month and year this file is for.");
      return;
    }
    // Refused before a batch exists (D-08): an empty file cannot be a report.
    if (file.size === 0) {
      setError("That file is empty.");
      return;
    }

    setBusy("uploading");

    const { data: minted, error: mintError } =
      await callAdminFunction<MintResponse>("residual-import-file-url", {
        file_name: file.name,
        processor,
        period,
        ...(replaceBatchId === undefined ? {} : { replace_batch_id: replaceBatchId }),
      });

    if (mintError || !minted) {
      setError(mintError ?? "Could not start the import.");
      setBusy(null);
      return;
    }

    if ("exists" in minted) {
      setCommitted({ ...minted.exists, processor, period, file });
      setBusy(null);
      return;
    }

    const supabase = createClient();
    const { error: uploadError } = await supabase.storage
      .from(RESIDUAL_BUCKET)
      .uploadToSignedUrl(minted.path, minted.token, file, {
        contentType: file.type || undefined,
      });

    if (uploadError) {
      setError(`Could not upload the file: ${uploadError.message}`);
      setBusy(null);
      // The batch row survives, so the list shows an import that got as far as
      // being started. Refreshed so it appears rather than being invisible until
      // the next navigation.
      router.refresh();
      return;
    }

    setBusy("parsing");

    const {
      data: parsed,
      error: parseError,
      status: parseStatus,
    } = await callAdminFunction<ParseResult>("parse-residual-import", {
      batch_id: minted.batch_id,
    });

    if (parseError || !parsed) {
      // A 400 is the parser refusing the file itself. Re-parsing that batch can
      // never succeed, so it is abandoned through the same path as the Abandon
      // button rather than left in Review (D-08). Any other failure leaves the
      // batch for Read again: the file may be fine.
      if (parseStatus === 400) {
        const problem = await abandonResidualBatch(supabase, minted.batch_id);
        setError(
          problem === null
            ? `${parseError} No batch was kept in Review.`
            : `${parseError} The batch could not be removed from Review: ${problem}`,
        );
      } else {
        setError(parseError ?? "Could not read that file.");
      }
      setBusy(null);
      router.refresh();
      return;
    }

    // Straight to the review screen: an import is never finished at upload, and
    // landing back on a list would hide the thing that needs attention.
    router.push(`/payouts/import/${parsed.batch_id}`);
  };

  return (
    <div className="flex flex-col gap-3 rounded-xl border bg-card p-4">
      <div>
        <p className="text-sm font-medium">Upload a residual report</p>
        <p className="mt-1 text-xs text-muted-foreground">
          The processor&apos;s monthly XLSX, with the six columns Processor,
          Merchant Number, Merchant Name, Income Type, Volume and Residual. Each
          line is paid to the owner of the merchant its Merchant Number names.
        </p>
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <div className="flex flex-col gap-1">
          <Label htmlFor="residual-processor">Processor</Label>
          <select
            id="residual-processor"
            className={SELECT_CLASS}
            value={processor}
            disabled={busy !== null}
            onChange={(event) => setProcessor(event.target.value)}
          >
            <option value="">Choose…</option>
            {processors.map((p) => (
              <option key={p.code} value={p.code}>
                {p.label}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="residual-month">Month</Label>
          <select
            id="residual-month"
            className={SELECT_CLASS}
            value={month}
            disabled={busy !== null || year === ""}
            onChange={(event) => setMonth(event.target.value)}
          >
            <option value="">{year === "" ? "Choose a year first" : "Choose…"}</option>
            {monthsInYear.map((mm) => (
              <option key={mm} value={mm}>
                {MONTH_NAMES[Number(mm) - 1]}
              </option>
            ))}
          </select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="residual-year">Year</Label>
          <select
            id="residual-year"
            className={SELECT_CLASS}
            value={year}
            disabled={busy !== null}
            onChange={(event) => {
              const next = event.target.value;
              setYear(next);
              // A month that the new year does not offer (a future one) is
              // cleared rather than silently kept.
              if (!months.includes(`${next}-${month}-01`)) setMonth("");
            }}
          >
            <option value="">Choose…</option>
            {years.map((yyyy) => (
              <option key={yyyy} value={yyyy}>
                {yyyy}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Input
          ref={fileRef}
          type="file"
          // The heading above is a <p>, so the input needs its own name (QA-005).
          aria-label="Residual report (XLSX)"
          // Advisory only, and the reason the parse step reports its own error:
          // an accept attribute filters a file picker, it does not stop a .csv
          // renamed to .xlsx from being chosen.
          accept=".xlsx,.xls,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          disabled={busy !== null}
          className="max-w-sm"
        />
        <Button
          type="button"
          size="sm"
          disabled={busy !== null}
          onClick={() => {
            const file = fileRef.current?.files?.[0];
            if (!file) {
              setError("Choose a file first.");
              return;
            }
            void upload(file);
          }}
        >
          <UploadIcon size={16} />
          {busy === "uploading"
            ? "Uploading…"
            : busy === "parsing"
              ? "Reading…"
              : "Upload"}
        </Button>
      </div>

      {committed && (
        <Callout tone="warning">
          <div data-testid="replace-blocked">
            <p className="font-medium">
              {committed.processor} for {formatPeriod(committed.period)} was
              already imported
              {committed.committed_at
                ? ` on ${formatDate(committed.committed_at)}`
                : ""}
              {committed.paid
                ? " and is marked paid, so it cannot be replaced."
                : ". Replace it?"}
            </p>
            <p className="mt-1 text-muted-foreground">
              {committed.paid
                ? "Reopen the month on the Payouts page (with a reason) to replace it, or post an adjustment there instead. Nothing was uploaded."
                : "Yes reads this file into a new import for you to review. Its lines replace the committed ones only when you commit it; until then nothing changes."}{" "}
              <Link
                href={`/payouts/import/${committed.batch_id}`}
                className="underline underline-offset-4"
              >
                Open {committed.file_name}
              </Link>
            </p>
            {!committed.paid && (
              <div className="mt-2 flex items-center gap-2">
                <Button
                  type="button"
                  size="sm"
                  disabled={busy !== null}
                  onClick={() => void upload(committed.file, committed.batch_id)}
                >
                  Yes, replace it
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  disabled={busy !== null}
                  onClick={() => setCommitted(null)}
                >
                  No
                </Button>
              </div>
            )}
          </div>
        </Callout>
      )}

      {error && <Callout tone="warning">{error}</Callout>}
    </div>
  );
}
