"use client";

import { useState } from "react";
import { DownloadIcon } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
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

    if (callError || !(data instanceof Blob)) {
      // The function's own message sits in the response body on a non-2xx, exactly
      // as callAdminFunction documents, so it is worth unwrapping here too.
      const response = (callError as { context?: Response } | null)?.context;
      let message = callError?.message ?? "Could not build the export.";
      if (response && typeof response.json === "function") {
        try {
          const payload = (await response.json()) as { error?: unknown };
          if (payload?.error) message = String(payload.error);
        } catch {
          // Not JSON — keep the generic message.
        }
      }
      setError(message);
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
