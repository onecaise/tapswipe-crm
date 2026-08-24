"use client";

import { useState } from "react";
import { DownloadIcon } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { reachableStorageUrl } from "@/lib/documents";
import { invokeEdgeFunction } from "@/lib/edge-functions";
import { Button } from "@/components/ui/button";

/**
 * Fetches a short-lived signed URL and opens it.
 *
 * The URL is never rendered into the page — it's requested on click and opened
 * immediately, so it doesn't sit in the DOM where it could be copied out and
 * shared while still valid. It is also why expiry is close to unreachable from
 * the UI: nothing here holds a URL long enough for the 60 seconds to run out.
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
    const { data, error: fnError } = await invokeEdgeFunction<{
      signedUrl: string;
    }>(
      supabase,
      "create-download-url",
      { document_id: documentId },
      "Could not open that document.",
    );

    if (fnError || !data?.signedUrl) {
      // The function's own message — "Account is not active", "Document not
      // found" — rather than invoke()'s generic "Edge Function returned a
      // non-2xx status code", which is what this used to show for every one of
      // those cases.
      setError(fnError ?? "Could not open that document.");
      setIsBusy(false);
      return;
    }

    // Navigation, not window.open(). Two reasons, and the first is the one that
    // bites: this runs after an await, so the browser no longer counts it as
    // part of the click, and a popup blocker is entitled to swallow it — leaving
    // a button that looks like it worked and did nothing. The second is that
    // window.open leaves a stray blank tab behind when the response is a
    // download rather than a page.
    //
    // Safe to navigate the current tab because create-download-url signs every
    // URL with `download`, so Storage answers Content-Disposition: attachment.
    // The browser saves the file and stays on the page. Were that option ever
    // removed, this would navigate away from the record — and an uploaded .html
    // would render on the storage origin, which is the more interesting problem
    // of the two. tests/live/document-lifecycle.test.ts pins the header.
    //
    // The origin is re-pointed at the URL this client knows the project by. The
    // function signs with its OWN SUPABASE_URL, which on the local stack is the
    // container-internal `http://kong:8000` — so in development every one of
    // these links was unresolvable and the button silently did nothing. A no-op
    // in production, where both are the public URL.
    window.location.assign(
      reachableStorageUrl(
        data.signedUrl,
        process.env.NEXT_PUBLIC_SUPABASE_URL,
      ),
    );
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
      {error && <span className="text-xs text-destructive">{error}</span>}
    </div>
  );
}
