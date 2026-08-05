"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { PaperclipIcon, Trash2Icon, UploadIcon } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import {
  type DocumentOwnerType,
  type DocumentRow,
  SUGGESTED_DOC_TYPES,
} from "@/lib/documents";
import { formatDate, formatText } from "@/lib/format";
import { DownloadDocumentButton } from "@/components/download-document-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const STORAGE_BUCKET = "documents";

/**
 * Upload / list / download for one owner record.
 *
 * Reads are Tier 1 (the server component passes them in, scoped by RLS). Writes
 * go through the two Edge Functions, because the bucket is private and has no
 * storage policies — a signed URL is the only way in or out.
 */
export function DocumentsPanel({
  ownerType,
  ownerId,
  documents,
}: {
  ownerType: DocumentOwnerType;
  ownerId: number;
  documents: DocumentRow[];
}) {
  const [docType, setDocType] = useState<string>(SUGGESTED_DOC_TYPES[0]);
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const router = useRouter();

  const upload = async (file: File) => {
    setIsUploading(true);
    setError(null);
    const supabase = createClient();

    try {
      // 1. Authorize and get a signed upload URL. The function re-checks that
      //    the caller owns this owner_type/owner_id — documents.owner_id has no
      //    foreign key, so nothing else would stop a file being attached to
      //    someone else's record.
      const { data: signed, error: signError } = await supabase.functions.invoke(
        "create-upload-url",
        { body: { owner_type: ownerType, owner_id: ownerId } },
      );
      if (signError) throw signError;

      // 2. Upload the bytes. Upload-then-insert: if this fails there's no
      //    metadata row, so the row never points at an object that isn't there.
      //    The reverse ordering would leave a row referencing nothing.
      const { error: uploadError } = await supabase.storage
        .from(STORAGE_BUCKET)
        .uploadToSignedUrl(signed.path, signed.token, file);
      if (uploadError) throw uploadError;

      // 3. Record the metadata. agent_id comes back from the function so the row
      //    and the storage key agree — relevant when an admin uploads for a rep.
      //    A failure here strands the object; see the note in the panel footer.
      const { error: insertError } = await supabase.from("documents").insert({
        agent_id: signed.agentId,
        owner_type: ownerType,
        owner_id: ownerId,
        doc_type: docType,
        file_key: signed.fileKey,
        file_name: file.name,
        mime_type: file.type || null,
      });
      if (insertError) throw insertError;

      if (fileInput.current) fileInput.current.value = "";
      router.refresh();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Upload failed.");
    } finally {
      setIsUploading(false);
    }
  };

  const remove = async (documentId: number) => {
    setBusyId(documentId);
    setError(null);
    const supabase = createClient();

    try {
      // Metadata only. The object stays in the bucket — deleting it needs the
      // service role, and there's no Edge Function for that yet. Since the
      // bucket is private and unreachable without a signed URL, an orphaned
      // object isn't exposed; it's a storage-cost cleanup task, not a leak.
      const { error: deleteError, count } = await supabase
        .from("documents")
        .delete({ count: "exact" })
        .eq("id", documentId);

      if (deleteError) throw deleteError;
      if (count === 0) {
        throw new Error("That document could not be removed.");
      }

      router.refresh();
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Could not remove.");
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section className="flex flex-col gap-4">
      <h2 className="font-semibold text-lg">Documents</h2>

      <div className="flex flex-wrap items-end gap-3">
        <div className="grid gap-2">
          <Label htmlFor="doc_type">Document type</Label>
          <Input
            id="doc_type"
            list="doc-type-suggestions"
            value={docType}
            onChange={(e) => setDocType(e.target.value)}
            className="w-56"
          />
          <datalist id="doc-type-suggestions">
            {SUGGESTED_DOC_TYPES.map((type) => (
              <option key={type} value={type} />
            ))}
          </datalist>
        </div>

        <div className="grid gap-2">
          <Label htmlFor="file">File</Label>
          <Input
            id="file"
            type="file"
            ref={fileInput}
            disabled={isUploading || docType.trim() === ""}
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
            Uploading…
          </p>
        )}
      </div>

      {error && <p className="text-sm text-red-500">{error}</p>}

      {documents.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No documents attached yet.
        </p>
      ) : (
        <ul className="flex flex-col divide-y rounded-md border">
          {documents.map((doc) => (
            <li
              key={doc.id}
              className="flex items-center justify-between gap-4 p-3"
            >
              <div className="flex items-center gap-3 min-w-0">
                <PaperclipIcon
                  size={16}
                  className="text-muted-foreground shrink-0"
                />
                <div className="flex flex-col min-w-0">
                  <span className="text-sm font-medium truncate">
                    {formatText(doc.file_name)}
                  </span>
                  <span className="text-xs text-muted-foreground">
                    {doc.doc_type} · {formatDate(doc.uploaded_at)}
                  </span>
                </div>
              </div>
              <div className="flex items-start gap-2 shrink-0">
                <DownloadDocumentButton
                  documentId={doc.id}
                  label={doc.file_name}
                />
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={busyId === doc.id}
                  onClick={() => void remove(doc.id)}
                  aria-label={`Remove ${doc.file_name ?? "document"}`}
                >
                  <Trash2Icon size={14} />
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
