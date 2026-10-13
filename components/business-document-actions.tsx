"use client";

import { useState } from "react";
import { DownloadIcon, EyeIcon, PrinterIcon } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { invokeEdgeFunction } from "@/lib/edge-functions";
import { reachableStorageUrl } from "@/lib/storage-url";
import {
  type BusinessDocument,
  friendlyLibraryError,
} from "@/lib/business-documents";
import { Button } from "@/components/ui/button";

type SignedRead = {
  signedUrl: string;
  fileName: string | null;
  mimeType: string | null;
  disposition: "inline" | "attachment";
};

type Action = "view" | "download" | "print";

const FALLBACK = "Could not open that document. Try again in a minute.";

/**
 * View / Download / Print for one business document.
 *
 * MarketingMaterialActions minus two things, each on purpose:
 *
 *   * No event row. Marketing logs every action because "what did we send this
 *     lead" is a question about a deal. A business document is read for the
 *     rep's own reference, and there is no table to log to.
 *   * No Email. Nothing here is sent to a merchant.
 *
 * Everything else is the marketing component's hard-won behaviour, kept
 * verbatim in spirit -- see that file for the measurements behind each:
 *
 *   * View and Print open the tab SYNCHRONOUSLY, before any await, so a popup
 *     blocker counts it as part of the click, and then point it at the URL.
 *   * WITHOUT "noopener": window.open(..., "noopener") returns null by spec,
 *     which silently sent every click to the fallback and orphaned a blank tab.
 *     Tabnabbing is closed at the source instead -- business-document-file-url
 *     signs inline only for a small allow-list of passive types.
 *   * Print does not call print() on the opened window: it is on the storage
 *     origin, cross-origin, so that would throw. The file opens ready to print.
 *   * Download navigates the current tab: the response is an attachment, so
 *     the browser saves it and stays here.
 */
export function BusinessDocumentActions({
  document: doc,
}: {
  document: BusinessDocument;
}) {
  const [busy, setBusy] = useState<Action | null>(null);
  const [error, setError] = useState<string | null>(null);

  const signedUrl = async (download: boolean): Promise<string | null> => {
    const supabase = createClient();
    const { data, error: fnError, status } = await invokeEdgeFunction<SignedRead>(
      supabase,
      "business-document-file-url",
      { document_id: doc.id, download },
      FALLBACK,
    );

    if (fnError || !data?.signedUrl) {
      setError(friendlyLibraryError(fnError, status, FALLBACK));
      return null;
    }

    // The function signs with its own SUPABASE_URL, which on the local stack
    // is the container-internal http://kong:8000. A no-op in production.
    return reachableStorageUrl(data.signedUrl, process.env.NEXT_PUBLIC_SUPABASE_URL);
  };

  const openInline = async (action: "view" | "print") => {
    setError(null);
    setBusy(action);

    const tab = window.open("", "_blank");

    const url = await signedUrl(false);
    if (!url) {
      tab?.close();
      setBusy(null);
      return;
    }

    if (tab) {
      tab.location.href = url;
    } else {
      // A popup blocker refused the window outright. The file renders inline,
      // so the back button returns here.
      window.location.assign(url);
    }
    setBusy(null);
  };

  const download = async () => {
    setError(null);
    setBusy("download");
    const url = await signedUrl(true);
    if (url) window.location.assign(url);
    setBusy(null);
  };

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button
          size="sm"
          variant="outline"
          disabled={busy !== null}
          onClick={() => void openInline("view")}
          aria-label={`View ${doc.title}`}
        >
          <EyeIcon size={14} />
          {busy === "view" ? "Opening…" : "View"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy !== null}
          onClick={() => void download()}
          aria-label={`Download ${doc.title}`}
        >
          <DownloadIcon size={14} />
          {busy === "download" ? "Opening…" : "Download"}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={busy !== null}
          onClick={() => void openInline("print")}
          aria-label={`Print ${doc.title}`}
        >
          <PrinterIcon size={14} />
          {busy === "print" ? "Opening…" : "Print"}
        </Button>
      </div>
      {error && (
        <span role="alert" className="text-right text-xs text-destructive">
          {error}
        </span>
      )}
    </div>
  );
}
