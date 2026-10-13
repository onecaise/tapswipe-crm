"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { UploadIcon } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { invokeEdgeFunction } from "@/lib/edge-functions";
import {
  BUSINESS_DOCUMENTS_BUCKET,
  MAX_BUSINESS_DOCUMENT_BYTES,
  SUGGESTED_CATEGORIES,
  businessDocumentUploadProblem,
  formatBytes,
  friendlyLibraryError,
  friendlyUploadError,
} from "@/lib/business-documents";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type SignedUpload = {
  document_id: number;
  path: string;
  token: string;
  fileKey: string;
};

const START_FALLBACK =
  "Could not start the upload. The library may be unavailable — try again in a minute.";
const PUT_FALLBACK =
  "The file did not finish uploading. Delete the unfinished entry below and publish it again.";

/**
 * Admin-only: publish a document into the library.
 *
 * MarketingMaterialUpload's sequencing exactly, and its two failure cases:
 *
 *   * Signing fails (the function's last step): the function ARCHIVES the row
 *     before returning the error, so nothing reaches a rep.
 *   * Signing succeeds but this browser's PUT then fails: the row stays with a
 *     file_key and no object. The function cannot see that happen. This form
 *     says so in words, and the manage list offers Delete on that row.
 *
 * The upload uses BUSINESS_DOCUMENTS_BUCKET, the same constant the function
 * signs against (re-exported, not copied).
 */
export function BusinessDocumentUpload() {
  const [category, setCategory] = useState<string>(SUGGESTED_CATEGORIES[0]);
  const [title, setTitle] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const router = useRouter();

  const ready = category.trim() !== "" && title.trim() !== "";

  const upload = async (file: File) => {
    setError(null);

    const problem = businessDocumentUploadProblem(file);
    if (problem) {
      setError(problem);
      // Cleared, or re-picking the same corrected file fires no change event.
      if (fileInput.current) fileInput.current.value = "";
      return;
    }

    setIsUploading(true);
    const supabase = createClient();

    try {
      const { data: signed, error: signError, status } =
        await invokeEdgeFunction<SignedUpload>(
          supabase,
          "business-document-file-url",
          {
            category: category.trim(),
            title: title.trim(),
            file_name: file.name,
            mime_type: file.type || null,
            size_bytes: file.size,
          },
          START_FALLBACK,
        );
      if (signError || !signed) {
        setError(friendlyLibraryError(signError, status, START_FALLBACK));
        return;
      }

      const { error: uploadError } = await supabase.storage
        .from(BUSINESS_DOCUMENTS_BUCKET)
        .uploadToSignedUrl(signed.path, signed.token, file);
      if (uploadError) {
        setError(friendlyUploadError(uploadError, PUT_FALLBACK));
        router.refresh();
        return;
      }

      setTitle("");
      router.refresh();
    } finally {
      // ALWAYS: a file input whose value has not changed fires no `change`
      // event, so after a failure the same file could not be picked again.
      if (fileInput.current) fileInput.current.value = "";
      setIsUploading(false);
    }
  };

  return (
    <section className="flex flex-col gap-4 rounded-md border p-4">
      <h2 className="font-semibold">Add a document</h2>

      <div className="flex flex-wrap items-end gap-3">
        <div className="grid min-w-0 gap-2">
          <Label htmlFor="business_document_category">Category</Label>
          <Input
            id="business_document_category"
            list="business-document-category-suggestions"
            value={category}
            onChange={(e) => setCategory(e.target.value)}
            className="w-56 max-w-full"
          />
          {/* Declared ONCE on the manage page; every admin row's category
              input points at this id too. */}
          <datalist id="business-document-category-suggestions">
            {SUGGESTED_CATEGORIES.map((item) => (
              <option key={item} value={item} />
            ))}
          </datalist>
        </div>

        <div className="grid min-w-0 gap-2">
          <Label htmlFor="business_document_title">Title</Label>
          <Input
            id="business_document_title"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Chargeback policy"
            className="w-72 max-w-full"
          />
        </div>

        <div className="grid min-w-0 gap-2">
          <Label htmlFor="business_document_file">File</Label>
          <Input
            id="business_document_file"
            type="file"
            ref={fileInput}
            disabled={isUploading || !ready}
            onChange={(e) => {
              const file = e.target.files?.[0];
              if (file) void upload(file);
            }}
            className="w-72 max-w-full"
          />
        </div>

        {isUploading && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <UploadIcon size={14} />
            Publishing…
          </p>
        )}
      </div>

      <p className="text-xs text-muted-foreground">
        {ready
          ? `Any file type, up to ${formatBytes(MAX_BUSINESS_DOCUMENT_BYTES)}.`
          : "Give it a category and a title first."}{" "}
        Every active rep can read anything published here. Merchant paperwork
        (voided checks, IDs, statements) does not belong in the CRM at all.
      </p>

      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </section>
  );
}
