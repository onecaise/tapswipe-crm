"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ArchiveIcon, ArchiveRestoreIcon, SaveIcon } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { formatDate } from "@/lib/format";
// SUGGESTED_CATEGORIES is deliberately NOT imported here: the category input
// below points at #material-category-suggestions, which MarketingMaterialUpload
// renders once on the same page. Declaring a second copy per row would mean one
// duplicate element id per material.
import {
  type MarketingMaterial,
  hasFile,
} from "@/lib/marketing-materials";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * One row of the admin's organize list: rename, recategorise, archive, restore.
 *
 * All four are plain PostgREST updates, not Edge Function calls. The
 * "admin updates" policy backs every one of them, and there is nothing
 * privileged involved — only the FILE needs the service role, because the
 * bucket has no storage policies. Routing a title edit through a function would
 * add a service-role hop to a write RLS already decides correctly, which is the
 * same reasoning that keeps event logging on PostgREST.
 *
 * There is no delete, here or anywhere. Archiving is the retirement mechanism:
 * a material exists to be referenced by marketing_material_events, and deleting
 * one would either cascade that history away or be blocked by the FK forever.
 * The table has no DELETE policy and no DELETE grant, so this is not a UI
 * omission that a future button could quietly undo.
 */
export function MarketingMaterialAdminRow({
  material,
}: {
  material: MarketingMaterial;
}) {
  const [category, setCategory] = useState(material.category);
  const [title, setTitle] = useState(material.title);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const router = useRouter();

  const isArchived = material.archived_at !== null;
  const dirty =
    category.trim() !== material.category || title.trim() !== material.title;

  const save = async () => {
    if (category.trim() === "" || title.trim() === "") {
      setError("Category and title are both required.");
      return;
    }
    setBusy(true);
    setError(null);

    const supabase = createClient();
    const { error: updateError } = await supabase
      .from("marketing_materials")
      // Trimmed: category is rendered as a grouping heading, so "Rate cards"
      // and "Rate cards " would split the library into two sections that look
      // identical.
      .update({ category: category.trim(), title: title.trim() })
      .eq("id", material.id);

    if (updateError) {
      setError(updateError.message);
      setBusy(false);
      return;
    }

    setBusy(false);
    router.refresh();
  };

  const setArchived = async (archived: boolean) => {
    setBusy(true);
    setError(null);

    const supabase = createClient();
    const { error: updateError } = await supabase
      .from("marketing_materials")
      .update({ archived_at: archived ? new Date().toISOString() : null })
      .eq("id", material.id);

    if (updateError) {
      setError(updateError.message);
      setBusy(false);
      return;
    }

    setBusy(false);
    router.refresh();
  };

  return (
    <li className="flex flex-col gap-2 p-3">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div className="flex flex-wrap items-end gap-2">
          <div className="grid gap-1">
            <label
              className="text-xs text-muted-foreground"
              htmlFor={`category-${material.id}`}
            >
              Category
            </label>
            <Input
              id={`category-${material.id}`}
              list="material-category-suggestions"
              value={category}
              onChange={(e) => setCategory(e.target.value)}
              className="w-48"
            />
          </div>
          <div className="grid gap-1">
            <label
              className="text-xs text-muted-foreground"
              htmlFor={`title-${material.id}`}
            >
              Title
            </label>
            <Input
              id={`title-${material.id}`}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className="w-64"
            />
          </div>
        </div>

        <div className="flex items-center gap-2">
          {/* Only offered when something changed, so the row does not present a
              save affordance for a no-op write. */}
          {dirty && (
            <Button size="sm" disabled={busy} onClick={() => void save()}>
              <SaveIcon size={14} />
              Save
            </Button>
          )}
          {isArchived ? (
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void setArchived(false)}
            >
              <ArchiveRestoreIcon size={14} />
              Restore
            </Button>
          ) : (
            // Outline, not destructive. Archiving is reversible and takes
            // nothing away — destructive red is reserved for the irreversible,
            // and there is nothing irreversible on this table by design.
            <Button
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void setArchived(true)}
            >
              <ArchiveIcon size={14} />
              Archive
            </Button>
          )}
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
        <span className="truncate">{material.file_name ?? "—"}</span>
        <span>·</span>
        <span>Added {formatDate(material.uploaded_at)}</span>
        {isArchived && (
          <StatusBadge intent="neutral">Archived</StatusBadge>
        )}
        {/* An upload that was started and never finished. Its own warning
            rather than an error: the row is legitimate and the fix is to
            publish the file again, which is what the admin needs told. */}
        {!hasFile(material) && (
          <StatusBadge intent="warning">No file — re-publish it</StatusBadge>
        )}
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}
    </li>
  );
}
