"use client";

import { useRouter } from "next/navigation";
import { useRef, useState } from "react";
import { PaperclipIcon, Trash2Icon, UploadIcon } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import {
  MAX_DOCUMENT_BYTES,
  SUGGESTED_DOC_TYPES,
  type DocumentOwnerType,
  type DocumentRow,
  documentUploadProblem,
  formatBytes,
} from "@/lib/documents";
import { invokeEdgeFunction } from "@/lib/edge-functions";
import { formatDate, formatText } from "@/lib/format";
import { Callout } from "@/components/callout";
import { ConfirmPair } from "@/components/confirm-pair";
import { DownloadDocumentButton } from "@/components/download-document-button";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

const STORAGE_BUCKET = "documents";

type SignedUpload = {
  path: string;
  token: string;
  fileKey: string;
  agentId: string;
};

/**
 * Upload / list / download / remove for one owner record.
 *
 * Reads are Tier 1 (the server component passes them in, scoped by RLS). Every
 * write goes through an Edge Function, because the bucket is private and has no
 * storage policies — a signed URL is the only way in or out, and removing an
 * object needs the service role.
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
  const [notice, setNotice] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<number | null>(null);
  /** Which document's removal is awaiting confirmation, if any. */
  const [confirmingId, setConfirmingId] = useState<number | null>(null);
  const [isUploading, setIsUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const router = useRouter();

  const upload = async (file: File) => {
    setError(null);
    setNotice(null);

    // Before anything is sent. Both of these fail silently otherwise: an empty
    // file uploads happily and produces a document that looks real until you
    // open it, and an oversized one used to sit on "Uploading…" indefinitely
    // because nothing below this had a ceiling.
    const problem = documentUploadProblem(file);
    if (problem) {
      setError(problem);
      // Cleared here too, or re-picking the same corrected file fires no change
      // event. See the finally block.
      if (fileInput.current) fileInput.current.value = "";
      return;
    }

    setIsUploading(true);
    const supabase = createClient();
    /** Set once the bytes are in the bucket, so a later failure can clean up. */
    let orphanKey: string | null = null;

    try {
      // 1. Authorize and get a signed upload URL. The function re-checks that
      //    the caller owns this owner_type/owner_id — documents.owner_id has no
      //    foreign key, so nothing else would stop a file being attached to
      //    someone else's record.
      const { data: signed, error: signError } =
        await invokeEdgeFunction<SignedUpload>(
          supabase,
          "create-upload-url",
          { owner_type: ownerType, owner_id: ownerId },
          "Could not start the upload.",
        );
      if (signError || !signed) throw new Error(signError ?? "No upload URL.");

      // 2. Upload the bytes. Upload-then-insert: if this fails there's no
      //    metadata row, so the row never points at an object that isn't there.
      //    The reverse ordering would leave a row referencing nothing.
      const { error: uploadError } = await supabase.storage
        .from(STORAGE_BUCKET)
        .uploadToSignedUrl(signed.path, signed.token, file);
      if (uploadError) throw uploadError;
      orphanKey = signed.fileKey;

      // 3. Record the metadata. agent_id comes back from the function so the row
      //    and the storage key agree — relevant when an admin uploads for a rep,
      //    and now enforced by documents_file_key_matches_owner, which is also
      //    what stops a forged file_key being readable.
      const { error: insertError } = await supabase.from("documents").insert({
        agent_id: signed.agentId,
        owner_type: ownerType,
        owner_id: ownerId,
        // Trimmed: doc_type is free text and the value is rendered as a badge, so
        // "Statement" and "Statement " would show as two different types.
        doc_type: docType.trim(),
        file_key: signed.fileKey,
        file_name: file.name,
        mime_type: file.type || null,
      });
      if (insertError) throw insertError;

      // Attached, so it is not an orphan.
      orphanKey = null;
      router.refresh();
    } catch (err: unknown) {
      setError(
        err instanceof Error ? err.message : "Upload failed. Nothing was saved.",
      );

      // The bytes landed but the metadata row did not, which leaves an object in
      // the bucket that no page can see and nothing points at. The browser
      // cannot delete it — the bucket is private — so ask the function to,
      // best-effort. Failing that it stays, invisible and unreferenced, which is
      // exactly the state this whole branch exists to avoid.
      if (orphanKey) {
        await invokeEdgeFunction(supabase, "delete-document", {
          file_key: orphanKey,
        });
      }
    } finally {
      // ALWAYS, not only on success. A file input whose value is unchanged fires
      // no `change` event, so after a failed upload picking the very same file
      // again did nothing at all and the retry looked like a dead control.
      if (fileInput.current) fileInput.current.value = "";
      setIsUploading(false);
    }
  };

  const remove = async (documentId: number) => {
    setBusyId(documentId);
    setError(null);
    setNotice(null);
    setConfirmingId(null);
    const supabase = createClient();

    // Through the Edge Function, not a direct delete. A PostgREST delete is
    // properly authorized by the delete policy but can only reach the metadata
    // row: the object needs the service role, and leaving it behind means a
    // driver's licence a rep believes they removed is still in the bucket.
    const { data, error: deleteError } = await invokeEdgeFunction<{
      deleted: boolean;
      storageDeleteFailed?: boolean;
    }>(supabase, "delete-document", { document_id: documentId }, "Could not remove.");

    if (deleteError || !data) {
      setError(deleteError ?? "Could not remove.");
      setBusyId(null);
      return;
    }

    // The row is gone either way, so this is a notice and not an error — but it
    // is said out loud, because the file itself is still there and somebody has
    // to know that.
    if (data.storageDeleteFailed) {
      setNotice(
        "Removed from the list, but the stored file could not be deleted. Tell an admin.",
      );
    }

    setBusyId(null);
    router.refresh();
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

      <p className="text-xs text-muted-foreground">
        Any file type, up to {formatBytes(MAX_DOCUMENT_BYTES)}. Files are stored
        privately and opened through short-lived links.
      </p>

      {error && <p className="text-sm text-destructive">{error}</p>}
      {/* A Callout, not destructive text: the removal the rep asked for did
          happen. What is left is a stored file only an admin can clear, which is
          a warning about state rather than a failed action. */}
      {notice && <Callout tone="warning">{notice}</Callout>}

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
                {confirmingId === doc.id ? (
                  <ConfirmPair
                    label="Remove this document?"
                    confirmLabel="Remove"
                    destructive
                    busy={busyId === doc.id}
                    onConfirm={() => void remove(doc.id)}
                    onCancel={() => setConfirmingId(null)}
                  />
                ) : (
                  <>
                    <DownloadDocumentButton
                      documentId={doc.id}
                      label={doc.file_name}
                    />
                    <Button
                      size="sm"
                      variant="ghost"
                      disabled={busyId === doc.id}
                      onClick={() => setConfirmingId(doc.id)}
                      aria-label={`Remove ${doc.file_name ?? "document"}`}
                    >
                      <Trash2Icon size={14} />
                    </Button>
                  </>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
