"use client";

import { useState } from "react";
import { DownloadIcon } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";

/**
 * Fetches a short-lived signed URL and opens it.
 *
 * The URL is never rendered into the page — it's requested on click and opened
 * immediately, so it doesn't sit in the DOM where it could be copied out and
 * shared while still valid.
 */
export function DownloadDocumentButton({
  documentId,
  label,
}: {
  documentId: number;
  label?: string | null;
}) {
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const open = async () => {
    setIsBusy(true);
    setError(null);

    const supabase = createClient();
    const { data, error: fnError } = await supabase.functions.invoke(
      "create-download-url",
      { body: { document_id: documentId } },
    );

    if (fnError) {
      setError(fnError.message);
      setIsBusy(false);
      return;
    }

    window.open(data.signedUrl, "_blank", "noopener,noreferrer");
    setIsBusy(false);
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <Button
        size="sm"
        variant="outline"
        disabled={isBusy}
        onClick={() => void open()}
        aria-label={`Download ${label ?? "document"}`}
      >
        <DownloadIcon size={14} />
        {isBusy ? "Opening…" : "Download"}
      </Button>
      {error && <span className="text-xs text-red-500">{error}</span>}
    </div>
  );
}
