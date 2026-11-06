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
  refused_count: number;
  merchant_count: number;
  ready: boolean;
};

/** 2 MB, stage-merchant-import's own limit; checked here only to say so sooner. */
const MAX_BYTES = 2 * 1024 * 1024;

/** The file's bytes as base64, without the data: URL prefix. */
function readAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error);
    reader.onload = () => {
      const url = String(reader.result ?? "");
      resolve(url.slice(url.indexOf(",") + 1));
    };
    reader.readAsDataURL(file);
  });
}

/**
 * Sends the ISO Hub merchants export to stage-merchant-import.
 *
 * The bytes travel as base64 so one path carries a CSV and an XLSX alike, and
 * the function reads which it is from the bytes, not the name. Nothing here is a
 * security boundary: the function checks the caller is an active admin.
 */
export function MerchantImportUpload() {
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const upload = async (file: File) => {
    setError(null);
    if (file.size > MAX_BYTES) {
      setError("That file is too large to import. The limit is 2 MB.");
      return;
    }
    setBusy(true);

    let encoded: string;
    try {
      encoded = await readAsBase64(file);
    } catch {
      setError("That file could not be read.");
      setBusy(false);
      return;
    }

    const { data, error: callError } = await callAdminFunction<StageResult>(
      "stage-merchant-import",
      { file_name: file.name, file_base64: encoded },
    );

    if (callError || !data) {
      setError(callError ?? "Could not read that file.");
      setBusy(false);
      return;
    }
    router.push(`/admin/merchants/import/${data.batch_id}`);
  };

  return (
    <div className="flex flex-col gap-3 rounded-xl border bg-card p-4">
      <div>
        <p className="text-sm font-medium">Upload the merchants export</p>
        <p className="mt-1 text-xs text-muted-foreground">
          The ISO Hub merchants export, as CSV (best) or XLSX, with the columns{" "}
          <span className="font-mono">Type</span>,{" "}
          <span className="font-mono">Merchant ID</span>,{" "}
          <span className="font-mono">Merchant Name</span>,{" "}
          <span className="font-mono">Split</span>,{" "}
          <span className="font-mono">Agent</span>,{" "}
          <span className="font-mono">Processor</span> and{" "}
          <span className="font-mono">Status</span>. Agent must be the rep&apos;s
          LLC legal name as set on Manage Users. Override Agent is not read: add
          overrides on each merchant afterwards. Up to 2,000 rows and 2 MB.
        </p>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
        <Input
          ref={fileRef}
          type="file"
          aria-label="Merchants export (CSV or XLSX)"
          accept=".csv,.txt,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          disabled={busy}
          className="max-w-sm"
        />
        <Button
          type="button"
          size="sm"
          disabled={busy}
          className="self-start"
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
