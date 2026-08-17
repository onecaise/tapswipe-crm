"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { UploadIcon } from "lucide-react";

import { callAdminFunction } from "@/lib/admin-users";
import { createClient } from "@/lib/supabase/client";
import { RESIDUAL_BUCKET } from "@/lib/payouts";
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
 * A failure at step 2 or 3 leaves a `review` batch with row_count 0, which the
 * list on this page shows and offers to abandon. That is deliberately not cleaned
 * up automatically: a batch that failed to parse is worth seeing, and the file is
 * still there to download and look at.
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

    const { data: parsed, error: parseError } =
      await callAdminFunction<ParseResult>("parse-residual-import", {
        batch_id: minted.batch_id,
      });

    if (parseError || !parsed) {
      setError(parseError ?? "Could not read that file.");
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
