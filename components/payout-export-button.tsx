"use client";

import { useState } from "react";
import { DownloadIcon } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { edgeFunctionErrorMessage } from "@/lib/edge-functions";
import { Button } from "@/components/ui/button";

/**
 * Downloads the payout table as an XLSX.
 *
 * The file the export-residuals function returns is **re-importable**: it carries
 * the same nine headers a processor report does, so the way to fill a whole
 * period's figures in bulk is export, type them in Excel, and upload it again.
 * Committing merges by period, agent # and MID, and writes the two money columns
 * only where the file supplies them.
 *
 * Not admin-only. The function reads through the caller's own client, so RLS scopes
 * the file: an admin gets the company, a rep gets their own rows. Nothing here
 * decides that.
 *
 * The response is bytes rather than JSON, so this goes through `invoke` and turns
 * the Blob into a download rather than using callAdminFunction — which exists to
 * unwrap a JSON error body and would have nothing to unwrap on success.
 */
export function PayoutExportButton({
  period,
  agentId,
  label = "Export",
}: {
  /** Stored form, `YYYY-MM-DD`. Omit for every period the caller can see. */
  period?: string;
  /** Narrow to one rep. Omit for everyone the caller can see. */
  agentId?: string;
  label?: string;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const download = async () => {
    setBusy(true);
    setError(null);

    const supabase = createClient();
    const { data, error: callError } = await supabase.functions.invoke(
      "export-residuals",
      { body: { period, agent_id: agentId } },
    );

    if (callError) {
      // The function's own message sits in the response body on a non-2xx, so it
      // is unwrapped rather than shown as the generic invoke() message. Not
      // invokeEdgeFunction() here: this response is a Blob, not JSON, and that
      // helper's null-data guard would be reading the wrong shape.
      setError(
        await edgeFunctionErrorMessage(callError, "Could not build the export."),
      );
      setBusy(false);
      return;
    }

    // A 2xx whose body did not arrive as a Blob. Split out from the branch above
    // rather than folded into it, because the two are not the same failure and
    // merging them cost a debugging session: supabase-js picks its parser from
    // the response Content-Type and falls back to .text(), so the function
    // returning the real spreadsheet media type produced { error: null, data:
    // <string> } — a completely successful export reported as "Could not build
    // the export.", a fallback message with no error behind it to unwrap.
    //
    // Fixed at the source (export-residuals now sends application/octet-stream,
    // which supabase-js reads as a Blob), so reaching here means that agreement
    // has broken again. Say so, because the generic sentence is what hid it.
    if (!(data instanceof Blob)) {
      setError(
        "The export came back in an unexpected format and was not saved. " +
          "This is a bug — please report it.",
      );
      setBusy(false);
      return;
    }

    const url = URL.createObjectURL(data);
    const anchor = document.createElement("a");
    anchor.href = url;
    // The server sets Content-Disposition, but a Blob URL does not carry it, so the
    // filename has to be repeated here or the browser saves it as a random uuid.
    anchor.download = `residuals-${period ? period.slice(0, 7) : "all-periods"}.xlsx`;
    document.body.appendChild(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);

    setBusy(false);
  };

  return (
    <span className="flex flex-col items-end gap-1">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={busy}
        onClick={() => void download()}
      >
        <DownloadIcon size={14} />
        {busy ? "Building…" : label}
      </Button>
      {error && <span className="text-xs text-destructive">{error}</span>}
    </span>
  );
}
