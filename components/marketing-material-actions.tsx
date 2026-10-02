"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  DownloadIcon,
  EyeIcon,
  MailIcon,
  PrinterIcon,
} from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { reachableStorageUrl } from "@/lib/documents";
import { invokeEdgeFunction } from "@/lib/edge-functions";
import type {
  MarketingEventType,
  MarketingMaterial,
} from "@/lib/marketing-materials";
import { Button } from "@/components/ui/button";

type SignedRead = {
  signedUrl: string;
  fileName: string | null;
  mimeType: string | null;
  disposition: "inline" | "attachment";
};

/**
 * View / Download / Print / Email for one material, logging each as an event.
 *
 * Every action writes a marketing_material_events row through PostgREST rather
 * than through the Edge Function, deliberately: an event is an ordinary insert
 * the rep's own policy admits, so routing it through a service-role hop would
 * add a privileged step to a write RLS already decides correctly. The function
 * is reached only for the signed URL, which is the one thing the browser cannot
 * do for itself.
 *
 * THE EVENT IS LOGGED BEFORE THE URL IS OPENED, and that ordering is a choice.
 * A log written afterwards would miss every action where the tab navigates away
 * first, which on a download is most of them. The cost is that an action the
 * user abandons still appears in the history — acceptable, because the question
 * this log answers is "what did we send this merchant", and a rep who opened a
 * rate card and changed their mind still looked at it. The reverse error, a
 * sent sheet with no record, is the one that matters in front of a merchant.
 *
 * ON "EMAIL": it sends nothing. There is no proposal-email feature in this
 * codebase yet — nothing under app/ or supabase/functions/ sends mail, and
 * `proposal_sent` is a lead status rather than an action. So this logs the
 * event and says plainly that nothing was sent. When the email phase lands, the
 * send goes HERE, next to this log line; the event row does not change, because
 * it is a record of intent either way. Building a parallel send path now would
 * be the thing to avoid — one email path, added once.
 */
export function MarketingMaterialActions({
  material,
  leadId,
  agentId,
  compact = false,
}: {
  material: MarketingMaterial;
  /** The lead this happened on, or null when browsing the library itself. */
  leadId: number | null;
  agentId: string;
  compact?: boolean;
}) {
  const [busy, setBusy] = useState<MarketingEventType | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const router = useRouter();

  /**
   * Writes the event row. Returns false if it failed, so the caller can stop.
   *
   * Failing closed on a log write is the right call for the three actions that
   * hand a file over: the whole point of the feature is the trail, and an
   * untracked send is worse than a refused one the rep can retry. It matches
   * how create-upload-url treats its own audit row.
   */
  const logEvent = async (eventType: MarketingEventType): Promise<boolean> => {
    const supabase = createClient();
    const { error: insertError } = await supabase
      .from("marketing_material_events")
      .insert({
        material_id: material.id,
        lead_id: leadId,
        agent_id: agentId,
        event_type: eventType,
      });

    if (insertError) {
      setError(
        `Could not record that you ${eventType} this. Nothing was opened.`,
      );
      return false;
    }
    return true;
  };

  /** Fetches a signed URL for the file, inline or as an attachment. */
  const signedUrl = async (download: boolean): Promise<string | null> => {
    const supabase = createClient();
    const { data, error: fnError } = await invokeEdgeFunction<SignedRead>(
      supabase,
      "marketing-material-file-url",
      { material_id: material.id, download },
      "Could not open that material.",
    );

    if (fnError || !data?.signedUrl) {
      // The function's own message — "Account is not active", "Material has no
      // file yet" — rather than invoke()'s fixed "Edge Function returned a
      // non-2xx status code", which is what every one of those would otherwise
      // read as.
      setError(fnError ?? "Could not open that material.");
      return null;
    }

    // The function signs with its OWN SUPABASE_URL, which on the local stack is
    // the container-internal http://kong:8000 — unresolvable from the browser,
    // so in development the link silently does nothing. A no-op in production.
    return reachableStorageUrl(
      data.signedUrl,
      process.env.NEXT_PUBLIC_SUPABASE_URL,
    );
  };

  /**
   * View and Print both open the file inline in a new tab.
   *
   * The tab is opened SYNCHRONOUSLY, before any await, and pointed at the URL
   * afterwards. Opening it after the await would put the call outside the
   * browser's notion of the click, and a popup blocker is entitled to swallow
   * it — leaving a button that looks like it worked and did nothing. That is
   * the same class of bug DownloadDocumentButton avoids by navigating instead
   * of calling window.open at all; here a new tab is wanted, so the handle is
   * taken first instead.
   *
   * WITHOUT "noopener", and without `tab.opener = null` either. Both were
   * tried, and each breaks the feature in its own silent way:
   *
   *   - `window.open(..., "noopener")` RETURNS NULL BY SPEC. There is no handle
   *     to give back, because severing the link between the two windows is the
   *     whole point of the flag. So `tab` was always null, every View and Print
   *     fell through to the fallback below and navigated the CURRENT tab, and
   *     the blank tab the browser had already created sat orphaned. Measured in
   *     a real browser.
   *   - `tab.opener = null` keeps the handle but disowns the window, and in
   *     Chromium the assignment to `tab.location.href` afterwards then does
   *     NOTHING. Measured under Playwright: no error, no console message, the
   *     tab simply stays on about:blank forever.
   *
   * Both failures are silent, neither raises anything, and the only symptom of
   * either is the file not being where the rep expects. That is why this is
   * written down rather than left as a bare `window.open`.
   *
   * What the opener link would otherwise risk is tabnabbing — the opened page
   * calling `window.opener.location = ...` to steer the CRM tab somewhere
   * else. That is closed at the source instead: marketing-material-file-url
   * refuses to sign an INLINE url for anything outside a small allow-list of
   * passive types, so a material that could run script is served as an
   * attachment and never renders in that tab at all. See INLINE_SAFE_TYPES
   * there.
   *
   * Print does not call print() on the opened window: the document is on the
   * storage origin, so it is cross-origin and `tab.print()` would throw. What
   * this does is put the file in front of the rep ready to print, and record
   * that they went to print it. The button label says Print because that is the
   * intent being recorded; the Ctrl-P is theirs.
   */
  const openInline = async (eventType: "viewed" | "printed") => {
    setError(null);
    setNotice(null);
    setBusy(eventType);

    const tab = window.open("", "_blank");

    if (!(await logEvent(eventType))) {
      tab?.close();
      setBusy(null);
      return;
    }

    const url = await signedUrl(false);
    if (!url) {
      tab?.close();
      setBusy(null);
      return;
    }

    if (tab) {
      tab.location.href = url;
    } else {
      // A popup blocker refused the window outright. Navigating the current tab
      // is worse than a new one but much better than nothing, and the file
      // renders inline so the back button returns here. This branch should now
      // be genuinely rare — it used to be the only branch, which is exactly how
      // the noopener bug above stayed invisible.
      window.location.assign(url);
    }

    setBusy(null);
    router.refresh();
  };

  const download = async () => {
    setError(null);
    setNotice(null);
    setBusy("downloaded");

    if (!(await logEvent("downloaded"))) {
      setBusy(null);
      return;
    }

    const url = await signedUrl(true);
    if (!url) {
      setBusy(null);
      return;
    }

    // Navigation rather than a new tab: the response carries
    // Content-Disposition: attachment, so the browser saves the file and stays
    // on this page. A new tab here would leave a stray blank one behind.
    window.location.assign(url);
    setBusy(null);
    router.refresh();
  };

  const email = async () => {
    setError(null);
    setNotice(null);
    setBusy("emailed");

    if (!(await logEvent("emailed"))) {
      setBusy(null);
      return;
    }

    // Said out loud, every time. An admin reading the engagement history will
    // see "Emailed" against this lead, and a rep who was not told would
    // reasonably believe the merchant received something.
    setNotice(
      leadId === null
        ? "Logged as emailed. No email was sent — sending is not built yet."
        : "Logged against this lead. No email was sent — sending is not built yet.",
    );
    setBusy(null);
    router.refresh();
  };

  const size = compact ? "sm" : "sm";

  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex flex-wrap items-center gap-2 justify-end">
        <Button
          size={size}
          variant="outline"
          disabled={busy !== null}
          onClick={() => void openInline("viewed")}
          aria-label={`View ${material.title}`}
        >
          <EyeIcon size={14} />
          {busy === "viewed" ? "Opening…" : "View"}
        </Button>
        <Button
          size={size}
          variant="outline"
          disabled={busy !== null}
          onClick={() => void download()}
          aria-label={`Download ${material.title}`}
        >
          <DownloadIcon size={14} />
          {busy === "downloaded" ? "Opening…" : "Download"}
        </Button>
        <Button
          size={size}
          variant="outline"
          disabled={busy !== null}
          onClick={() => void openInline("printed")}
          aria-label={`Print ${material.title}`}
        >
          <PrinterIcon size={14} />
          {busy === "printed" ? "Opening…" : "Print"}
        </Button>
        <Button
          size={size}
          variant="outline"
          disabled={busy !== null}
          onClick={() => void email()}
          aria-label={`Email ${material.title}`}
        >
          <MailIcon size={14} />
          {busy === "emailed" ? "Logging…" : "Email"}
        </Button>
      </div>

      {error && <span className="text-xs text-destructive">{error}</span>}
      {/* Muted rather than a Callout: nothing went wrong, and nothing is
          pending. The row was written exactly as asked — the sentence exists so
          the rep does not infer a send that did not happen. */}
      {notice && (
        <span className="text-xs text-muted-foreground text-right">
          {notice}
        </span>
      )}
    </div>
  );
}
