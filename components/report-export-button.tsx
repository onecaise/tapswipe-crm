"use client";

import { useState } from "react";
import { DownloadIcon } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { edgeFunctionErrorMessage } from "@/lib/edge-functions";
import { reportFileName, type ReportFilters } from "@/lib/reports";
import { Button } from "@/components/ui/button";

/**
 * "Export Excel" on /admin/reports (phase 12b): the report on screen, for the
 * same months and processor, as an .xlsx from the export-report function.
 *
 * The function is admin-only and reads through the caller's own session, so
 * nothing here decides who may download; this button only appears on a page
 * requireAdmin() has already let through. The workbook is built on the
 * server (SheetJS never reaches the browser bundle); this turns the bytes into
 * a download, as PayoutExportButton does, and names the file itself because a
 * Blob URL carries no Content-Disposition.
 */
export function ReportExportButton({ filters }: { filters: ReportFilters }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const download = async () => {
    setBusy(true);
    setError(null);

    const { data, error: callError } = await createClient().functions.invoke("export-report", {
      body: { report: filters.report, from: filters.from, to: filters.to, processor: filters.processor },
    });

    if (callError) {
      setError(await edgeFunctionErrorMessage(callError, "Could not build the export."));
      setBusy(false);
      return;
    }
    // A 2xx that did not arrive as a Blob: the function's octet-stream
    // agreement with supabase-js has broken (PayoutExportButton explains).
    if (!(data instanceof Blob)) {
      setError("The export came back in an unexpected format and was not saved. This is a bug — please report it.");
      setBusy(false);
      return;
    }

    const url = URL.createObjectURL(data);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = reportFileName(filters);
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
    setBusy(false);
  };

  return (
    <span className="flex flex-col items-start gap-1 print:hidden">
      <Button type="button" variant="outline" size="sm" disabled={busy} onClick={() => void download()}>
        <DownloadIcon size={14} />
        {busy ? "Building…" : "Export Excel"}
      </Button>
      {error && <span className="text-xs text-destructive" role="alert">{error}</span>}
    </span>
  );
}
