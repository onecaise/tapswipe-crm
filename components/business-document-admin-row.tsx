"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { SaveIcon, Trash2Icon } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { friendlyDbError } from "@/lib/db-errors";
import { formatDate } from "@/lib/format";
import {
  type BusinessDocument,
  formatBytes,
  hasFile,
} from "@/lib/business-documents";
import { ConfirmPair } from "@/components/confirm-pair";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * One row of the admin's manage list: rename, recategorise, delete.
 *
 * All three are plain PostgREST updates, not function calls -- the "admin
 * updates" policy backs every one, and only the FILE needs the service role.
 * MarketingMaterialAdminRow's arrangement.
 *
 * "DELETE" IS AN ARCHIVE UNDER THE HOOD, and the label is deliberate. To every
 * rep the document is gone: the select policy hides archived rows from them,
 * and business-document-file-url signs an archived document for nobody. The
 * row and its file stay, which is what makes a mistaken click an engineer's
 * one-line UPDATE rather than a lost file -- but nothing on any page offers to
 * bring it back, so to the person clicking it is a delete, and it says so.
 * It sits behind ConfirmPair, the house confirmation step (never
 * window.confirm), in destructive red.
 */
export function BusinessDocumentAdminRow({
  document: doc,
}: {
  document: BusinessDocument;
}) {
  const [category, setCategory] = useState(doc.category);
  const [title, setTitle] = useState(doc.title);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  const dirty = category.trim() !== doc.category || title.trim() !== doc.title;

  const save = async () => {
    if (category.trim() === "" || title.trim() === "") {
      setError("Category and title are both required.");
      return;
    }
    setBusy(true);
    setError(null);

    const supabase = createClient();
    const { error: updateError } = await supabase
      .from("business_documents")
      // Trimmed: category is a grouping heading, and "Policies" and
      // "Policies " would render as two identical-looking sections.
      .update({ category: category.trim(), title: title.trim() })
      .eq("id", doc.id);

    setBusy(false);
    if (updateError) {
      setError(friendlyDbError(updateError, "Could not save that change."));
      return;
    }
    router.refresh();
  };

  const remove = async () => {
    setBusy(true);
    setError(null);

    const supabase = createClient();
    // .select() so a write RLS filtered to zero rows (a session that is no
    // longer an admin) is reported instead of looking like a success.
    const { data, error: updateError } = await supabase
      .from("business_documents")
      .update({ archived_at: new Date().toISOString() })
      .eq("id", doc.id)
      .select("id");

    setBusy(false);
    setConfirming(false);
    if (updateError || !data || data.length === 0) {
      setError(
        updateError
          ? friendlyDbError(updateError, "Could not delete that document.")
          : "Could not delete that document. Your session may no longer be an admin one — sign in again.",
      );
      return;
    }
    router.refresh();
  };

  return (
    <li className="flex flex-col gap-2 p-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex min-w-0 flex-wrap items-end gap-2">
          <div className="grid min-w-0 gap-1">
            <label
              className="text-xs text-muted-foreground"
              htmlFor={`business-document-category-${doc.id}`}
            >
              Category
            </label>
            <Input
              id={`business-document-category-${doc.id}`}
              list="business-document-category-suggestions"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="w-48 max-w-full"
            />
          </div>
          <div className="grid min-w-0 gap-1">
            <label
              className="text-xs text-muted-foreground"
              htmlFor={`business-document-title-${doc.id}`}
            >
              Title
            </label>
            <Input
              id={`business-document-title-${doc.id}`}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-64 max-w-full"
            />
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {dirty && (
            <Button size="sm" disabled={busy} onClick={() => void save()}>
              <SaveIcon size={14} />
              Save
            </Button>
          )}
          {confirming ? (
            <ConfirmPair
              label="Delete for every rep?"
              confirmLabel="Delete"
              destructive
              busy={busy}
              onConfirm={() => void remove()}
              onCancel={() => setConfirming(false)}
            />
          ) : (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => setConfirming(true)}
              aria-label={`Delete ${doc.title}`}
            >
              <Trash2Icon size={14} />
              Delete
            </Button>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span className="min-w-0 truncate">{doc.file_name ?? "—"}</span>
        {doc.size_bytes !== null && (
          <>
            <span>·</span>
            <span>{formatBytes(doc.size_bytes)}</span>
          </>
        )}
        <span>·</span>
        <span>Added {formatDate(doc.uploaded_at)}</span>
        {!hasFile(doc) && (
          <StatusBadge intent="warning">No file — publish it again</StatusBadge>
        )}
      </div>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </li>
  );
}
