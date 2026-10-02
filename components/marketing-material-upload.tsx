"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { UploadIcon } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { invokeEdgeFunction } from "@/lib/edge-functions";
import {
  MAX_MATERIAL_BYTES,
  SUGGESTED_CATEGORIES,
  formatBytes,
  materialUploadProblem,
} from "@/lib/marketing-materials";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const MARKETING_BUCKET = "marketing";

type SignedUpload = {
  material_id: number;
  path: string;
  token: string;
  fileKey: string;
};

/**
 * Admin-only: publish a new material into the library.
 *
 * The opposite ordering to DocumentsPanel, and the difference is worth knowing.
 * There, the browser uploads the bytes and THEN inserts the metadata row, so a
 * failure never leaves a row pointing at nothing. Here the row is created first
 * — by the Edge Function, because the storage key is {material_id}/{file_name}
 * and the id has to exist before the key can be built.
 *
 * So the failure modes are mirrored too. There, a dead upload leaves an orphan
 * OBJECT that no row names, which the panel cleans up by asking delete-document
 * to remove it. Here, a dead upload leaves an orphan ROW with a null file_key
 * and no object — which is visible, harmless, and recoverable: the admin list
 * shows it as "No file" and offers a retry. Nothing to clean up, because there
 * is no table this app can delete from (marketing_materials has no delete path
 * at all) and nothing in the bucket to orphan.
 */
export function MarketingMaterialUpload() {
  const [category, setCategory] = useState<string>(SUGGESTED_CATEGORIES[0]);
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const router = useRouter();

  const ready = category.trim() !== "" && title.trim() !== "";

  const upload = async (file: File) => {
    setError(null);

    // Before anything is sent. An empty file uploads perfectly happily and
    // produces a material that looks real until a rep opens it in front of a
    // merchant, which is the worst place to find out.
    const problem = materialUploadProblem(file);
    if (problem) {
      setError(problem);
      // Cleared here too, or re-picking the same corrected file fires no change
      // event at all. See the finally block.
      if (fileInput.current) fileInput.current.value = "";
      return;
    }

    setIsUploading(true);
    const supabase = createClient();

    try {
      const { data: signed, error: signError } =
        await invokeEdgeFunction<SignedUpload>(
          supabase,
          "marketing-material-file-url",
          {
            category: category.trim(),
            title: title.trim(),
            file_name: file.name,
            mime_type: file.type || null,
          },
          "Could not start the upload.",
        );
      if (signError || !signed) throw new Error(signError ?? "No upload URL.");

      const { error: uploadError } = await supabase.storage
        .from(MARKETING_BUCKET)
        .uploadToSignedUrl(signed.path, signed.token, file);
      if (uploadError) throw uploadError;

      setTitle("");
      router.refresh();
    } catch (err: unknown) {
      setError(
        err instanceof Error
          ? err.message
          : "Upload failed. The material was not published.",
      );
    } finally {
      // ALWAYS, not only on success. A file input whose value has not changed
      // fires no `change` event, so after a failure picking the very same file
      // again does nothing and the retry looks like a dead control.
      if (fileInput.current) fileInput.current.value = "";
      setIsUploading(false);
    }
  };

  return (
    <section className="flex flex-col gap-4 rounded-md border p-4">
      <h2 className="font-semibold">Publish a material</h2>

      <div className="flex flex-wrap items-end gap-3">
        <div className="grid gap-2">
          <Label htmlFor="material_category">Category</Label>
          <Input
            id="material_category"
            list="material-category-suggestions"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="w-56"
          />
          {/* A datalist, not a select: category is free text in the schema on
              purpose, so marketing can invent a new kind of collateral without
              a migration. These are suggestions. */}
          <datalist id="material-category-suggestions">
            {SUGGESTED_CATEGORIES.map((item) => (
              <option key={item} value={item} />
            ))}
          </datalist>
        </div>

        <div className="grid gap-2">
          <Label htmlFor="material_title">Title</Label>
          <Input
            id="material_title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Retail rate card 2026"
            className="w-72"
          />
        </div>

        <div className="grid gap-2">
          <Label htmlFor="material_file">File</Label>
          <Input
            id="material_file"
            type="file"
            ref={fileInput}
            disabled={isUploading || !ready}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void upload(file);
            }}
            className="w-72"
          />
        </div>

        {isUploading && (
          <p className="text-sm text-muted-foreground flex items-center gap-2">
            <UploadIcon size={14} />
            Publishing…
          </p>
        )}
      </div>

      <p className="text-xs text-muted-foreground">
        {ready
          ? `Any file type, up to ${formatBytes(MAX_MATERIAL_BYTES)}.`
          : "Give it a category and a title first."}{" "}
        Every rep can read anything published here, so nothing confidential
        belongs in the library.
      </p>

      {error && <p className="text-sm text-destructive">{error}</p>}
    </section>
  );
}
