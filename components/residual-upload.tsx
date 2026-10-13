"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { UploadIcon } from "lucide-react";

import { callAdminFunction } from "@/lib/admin-users";
import { createClient } from "@/lib/supabase/client";
import { RESIDUAL_BUCKET } from "@/lib/payouts";
import { abandonResidualBatch } from "@/lib/residual-batches";
import { Callout } from "@/components/callout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type MintedUpload = {
  batch_id: number;
  path: string;
  token: string;
  fileKey: string;
};

type ParseResult = {
  batch_id: number;
  row_count: number;
  blocked_count: number;
};

/**
 * Uploads a residual XLSX and sends the admin to its review screen.
 *
 * Three steps, and the order is forced by the Storage key containing the batch id:
 *
 *   1. residual-import-file-url creates the batch row and signs an upload URL.
 *   2. The browser PUTs the file straight to Storage. Same upload-then-act shape
 *      documents-panel.tsx uses — the bytes never pass through a function.
 *   3. parse-residual-import reads the stored file and stages its rows.
 *
 * A file the parser REFUSES (a 400: not a spreadsheet, a missing column) is
 * abandoned straight away — it can never parse, so a `review` row for it was
 * only clutter an admin had to find and abandon by hand (D-08). An empty file
 * is refused before step 1. Any other failure at step 2 or 3 (upload error,
 * function down) still leaves a `review` batch with row_count 0, which the list
 * shows and offers to re-parse or abandon: there the file may well be fine.
 * Abandoned batches keep their file downloadable either way.
 *
 * Nothing here is a security boundary. Both functions verify the caller is an
 * active admin server-side; the page's requireAdmin() only keeps a rep from seeing
 * a form that would reject them.
 */
export function ResidualUpload() {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);

  const [busy, setBusy] = useState<null | "uploading" | "parsing">(null);
  const [error, setError] = useState<string | null>(null);

  const upload = async (file: File) => {
    setError(null);

    // Refused before a batch exists (D-08): an empty file cannot be a report,
    // and checking here costs nothing. Whether a non-empty file is a
    // spreadsheet with the right columns only the parser can say — SheetJS
    // lives in the function, not in this bundle — so that case is cleaned up
    // after the parse instead (below).
    if (file.size === 0) {
      setError("That file is empty.");
      return;
    }

    setBusy("uploading");

    const { data: minted, error: mintError } =
      await callAdminFunction<MintedUpload>("residual-import-file-url", {
        file_name: file.name,
      });

    if (mintError || !minted) {
      setError(mintError ?? "Could not start the import.");
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
      // A 400 is the parser refusing the file itself — not a spreadsheet, no
      // sheets, a required column missing. Re-parsing that batch can never
      // succeed, so it is abandoned through the same path as the Abandon
      // button rather than left in Review for an admin to find (D-08). Any
      // other failure (function down, 5xx, no response) leaves the batch for
      // Re-parse, as before: the file may be fine.
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
          The processor&apos;s monthly XLSX. It needs the columns Period, Agent #,
          MID, Merchant name, Volume, Average ticket and Total cost — Residual
          income and Rep split are filled in here afterwards, or supplied by
          re-importing an export.
        </p>
      </div>

      <div className="flex items-center gap-2">
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

      {error && <Callout tone="warning">{error}</Callout>}
    </div>
  );
}
