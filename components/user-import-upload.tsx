"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { UploadIcon } from "lucide-react";

import { callAdminFunction } from "@/lib/admin-users";
import { Callout } from "@/components/callout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

type StageResult = {
  batch_id: number;
  row_count: number;
  blocked_count: number;
  skipped_count: number;
  ready: boolean;
};

/**
 * Reads a rep CSV and sends it to stage-user-import.
 *
 * TWO STEPS, WHERE THE RESIDUAL UPLOAD NEEDS THREE. That one has to mint a
 * signed URL, PUT the bytes to Storage, then ask a function to parse them,
 * because an XLSX is binary and can be megabytes. A rep list is small text, so
 * the browser reads it with File.text() and posts the string — no bucket, no
 * signed URL, and no window in which a batch row exists with no file behind it.
 *
 * Nothing here is a security boundary. stage-user-import verifies the caller is
 * an active admin server-side; the page's requireAdmin() only keeps a rep from
 * seeing a form that would reject them.
 */
export function UserImportUpload() {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const upload = async (file: File) => {
    setError(null);
    setBusy(true);

    let text: string;
    try {
      text = await file.text();
    } catch {
      // A directory, a file deleted between picking and reading, a permission
      // problem. Reported rather than thrown, so the form can say so.
      setError("That file could not be read.");
      setBusy(false);
      return;
    }

    const { data, error: callError } = await callAdminFunction<StageResult>(
      "stage-user-import",
      { file_name: file.name, source_text: text },
    );

    if (callError || !data) {
      // The function's own message — which column is missing, how many rows over
      // the cap, and so on. Never the generic non-2xx string.
      setError(callError ?? "Could not read that file.");
      setBusy(false);
      return;
    }

    // Straight to the review screen: an import is never finished at upload, and
    // landing back on a list would hide the thing that needs attention.
    router.push(`/admin/users/import/${data.batch_id}`);
  };

  return (
    <div className="flex flex-col gap-3 rounded-xl border bg-card p-4">
      <div>
        <p className="text-sm font-medium">Upload a list of reps</p>
        <p className="mt-1 text-xs text-muted-foreground">
          A CSV with the columns <span className="font-mono">Full name</span> and{" "}
          <span className="font-mono">Email</span>.{" "}
          <span className="font-mono">Role</span> and{" "}
          <span className="font-mono">Agent #</span> are optional — a row with no
          role becomes an agent. Save as CSV from Excel; up to 200 rows per file.
        </p>
      </div>

      <div className="flex items-center gap-2">
        <Input
          ref={fileRef}
          type="file"
          // Advisory only, and the reason the staging step reports its own error:
          // an accept attribute filters a file picker, it does not stop a
          // spreadsheet renamed to .csv from being chosen.
          accept=".csv,.txt,text/csv"
          disabled={busy}
          className="max-w-sm"
        />
        <Button
          type="button"
          size="sm"
          disabled={busy}
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
          {busy ? "Reading…" : "Upload"}
        </Button>
      </div>

      {error && <Callout tone="warning">{error}</Callout>}
    </div>
  );
}
