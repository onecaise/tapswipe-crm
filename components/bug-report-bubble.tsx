"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { BugIcon, ListChecksIcon, SendIcon, XIcon } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import {
  BUG_REPORT_MAX_LENGTH,
  bugReportPageOptions,
  defaultBugReportPage,
} from "@/lib/bug-reports";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

/**
 * The report-a-bug bubble, fixed bottom-right on every CRM page.
 *
 * A panel anchored to the bubble rather than a modal, and that is a house
 * convention rather than a preference: this repo has no dialog primitive, and
 * owners-step.tsx states why — "a native dialog blocks the page until
 * dismissed". Not blocking matters more here than anywhere else, because the
 * thing being described is on the page behind the panel.
 *
 * Role changes only the entry point. An agent's click opens the form; an admin's
 * opens a two-item menu, because they have somewhere else to go. Both get the
 * same form, and `isAdmin` arrives as a prop from the server (see
 * bug-report-launcher.tsx) — the same way the sidebar learns it.
 */
export function BugReportBubble({
  agentId,
  isAdmin,
}: {
  agentId: string;
  isAdmin: boolean;
}) {
  const pathname = usePathname();
  const router = useRouter();
  // The whole corner — bubble AND panel — not just the panel. Scoped to the
  // panel alone, the bubble counts as "outside", so the click that opens it is
  // also a click-away: the panel opens and closes within the same gesture, and
  // only a synthetic .click() with no mousedown appears to work.
  const rootRef = useRef<HTMLDivElement>(null);

  const [open, setOpen] = useState(false);
  const [page, setPage] = useState(() => defaultBugReportPage(pathname, isAdmin));
  const [description, setDescription] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);

  // Reopening on a different page should default to that page, not to wherever
  // the bubble was last opened.
  useEffect(() => {
    if (!open) setPage(defaultBugReportPage(pathname, isAdmin));
  }, [open, pathname, isAdmin]);

  // Escape and click-away close it. Both because the panel is not modal: it
  // takes no focus trap, so the ways out have to be the ordinary ones.
  useEffect(() => {
    if (!open) return;

    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    const onPointer = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };

    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onPointer);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onPointer);
    };
  }, [open]);

  const submit = async () => {
    setBusy(true);
    setError(null);

    const supabase = createClient();
    // agent_id is what the insert policy's `with check` requires, and it is
    // pinned to auth.uid() there — sending anyone else's is refused outright
    // rather than filtered, so a report cannot be filed under another name.
    const { error: insertError } = await supabase.from("bug_reports").insert({
      agent_id: agentId,
      page,
      description: description.trim(),
    });

    if (insertError) {
      setError(insertError.message);
      setBusy(false);
      return;
    }

    setDescription("");
    setBusy(false);
    setSent(true);
    // Nothing on the current page shows reports, but an admin sitting on the
    // queue should see their own arrive.
    router.refresh();
  };

  const openForm = () => {
    setSent(false);
    setError(null);
    setOpen(true);
  };

  const options = bugReportPageOptions(pathname, isAdmin);

  return (
    <div
      ref={rootRef}
      className="fixed bottom-6 right-6 z-50 flex flex-col items-end gap-3"
    >
      {open && (
        <div
          role="group"
          aria-label="Report a bug"
          className="w-[22rem] max-w-[calc(100vw-3rem)] rounded-xl border bg-card p-4 shadow-lg"
        >
          <div className="flex items-center justify-between gap-2 pb-3">
            <h2 className="text-sm font-semibold">Report a bug</h2>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              aria-label="Close"
              onClick={() => setOpen(false)}
            >
              <XIcon size={16} />
            </Button>
          </div>

          {sent ? (
            <div className="flex flex-col items-start gap-3">
              <p className="text-sm text-muted-foreground">
                Thanks — that&apos;s been sent to the admins.
              </p>
              <Button type="button" size="sm" variant="outline" onClick={openForm}>
                Report another
              </Button>
            </div>
          ) : (
            <div className="flex flex-col gap-3">
              <div className="grid gap-2">
                <Label htmlFor="bug-report-page">Page</Label>
                {/* Native select: the repo has no shadcn select, and every
                    other form here uses a native one. */}
                <select
                  id="bug-report-page"
                  className="border-input bg-background ring-offset-background focus-visible:ring-ring flex h-10 w-full rounded-md border px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
                  value={page}
                  disabled={busy}
                  onChange={(event) => setPage(event.target.value)}
                >
                  {options.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid gap-2">
                <Label htmlFor="bug-report-description">What happened?</Label>
                <Textarea
                  id="bug-report-description"
                  rows={4}
                  value={description}
                  disabled={busy}
                  maxLength={BUG_REPORT_MAX_LENGTH}
                  placeholder="What you did, what you expected, and what happened instead."
                  onChange={(event) => setDescription(event.target.value)}
                />
              </div>

              {error && <p className="text-sm text-destructive">{error}</p>}

              <Button
                type="button"
                size="sm"
                className="self-start"
                disabled={busy || description.trim() === ""}
                onClick={() => void submit()}
              >
                <SendIcon size={16} />
                {busy ? "Sending…" : "Send report"}
              </Button>
            </div>
          )}
        </div>
      )}

      {isAdmin ? (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <button type="button" className={BUBBLE_CLASS} aria-label="Report a bug">
              <BugIcon size={20} />
            </button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" side="top">
            <DropdownMenuItem onSelect={openForm}>
              <BugIcon size={16} />
              Report a Bug
            </DropdownMenuItem>
            <DropdownMenuItem asChild>
              <Link href="/admin/bug-reports">
                <ListChecksIcon size={16} />
                See All Reports
              </Link>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <button
          type="button"
          className={BUBBLE_CLASS}
          aria-label="Report a bug"
          aria-expanded={open}
          onClick={() => (open ? setOpen(false) : openForm())}
        >
          <BugIcon size={20} />
        </button>
      )}
    </div>
  );
}

/**
 * `primary`, not `destructive`: this is the page's own action, and destructive
 * red is reserved for delete behind a confirmation. Tokens only — no palette
 * literals — so it follows the theme like everything else.
 */
const BUBBLE_CLASS = cn(
  "flex h-12 w-12 items-center justify-center rounded-full",
  "bg-primary text-primary-foreground shadow-lg transition-colors",
  "hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2",
  "focus-visible:ring-ring focus-visible:ring-offset-2",
);
