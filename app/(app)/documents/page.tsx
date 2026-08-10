import Link from "next/link";
import { Suspense } from "react";

import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import {
  DOCUMENT_LIST_COLUMNS,
  OWNER_TYPE_LABELS,
  type DocumentRow,
  ownerHref,
} from "@/lib/documents";
import { formatDate, formatText } from "@/lib/format";
import { DownloadDocumentButton } from "@/components/download-document-button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

async function DocumentCenter() {
  const profile = await requireUser();
  const supabase = await createClient();

  // Tier 1: the documents select policy scopes this to the caller's own rows,
  // or everything for an admin.
  const { data, error } = await supabase
    .from("documents")
    .select(DOCUMENT_LIST_COLUMNS)
    .order("uploaded_at", { ascending: false });

  if (error) {
    return (
      <p className="text-sm text-destructive">
        Could not load documents: {error.message}
      </p>
    );
  }

  const documents = (data ?? []) as DocumentRow[];
  const isAdmin = profile.role === "admin";

  let agentNames = new Map<string, string>();
  if (isAdmin && documents.length > 0) {
    const agentIds = [...new Set(documents.map((d) => d.agent_id))];
    const { data: agents } = await supabase
      .from("profiles")
      .select("id, full_name")
      .in("id", agentIds);
    agentNames = new Map(
      (agents ?? []).map((a) => [a.id as string, a.full_name as string]),
    );
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>File</TableHead>
          <TableHead>Type</TableHead>
          <TableHead>Attached to</TableHead>
          {isAdmin && <TableHead>Agent</TableHead>}
          <TableHead>Uploaded</TableHead>
          <TableHead />
        </TableRow>
      </TableHeader>
      <TableBody>
        {documents.length === 0 ? (
          <TableRow>
            <TableCell
              colSpan={isAdmin ? 6 : 5}
              className="text-muted-foreground"
            >
              No documents yet. Upload one from a merchant or lead.
            </TableCell>
          </TableRow>
        ) : (
          documents.map((doc) => {
            const href = ownerHref(doc.owner_type, doc.owner_id);
            return (
              <TableRow key={doc.id}>
                <TableCell className="font-medium">
                  {formatText(doc.file_name)}
                </TableCell>
                <TableCell>
                  <Badge variant="secondary">{doc.doc_type}</Badge>
                </TableCell>
                <TableCell>
                  {href ? (
                    <Link href={href} className="underline underline-offset-4">
                      {OWNER_TYPE_LABELS[doc.owner_type]} #{doc.owner_id}
                    </Link>
                  ) : (
                    // pre_apps and support_tickets have no pages yet, so the
                    // reference is shown without a link rather than a dead one.
                    <span className="text-muted-foreground">
                      {OWNER_TYPE_LABELS[doc.owner_type]} #{doc.owner_id}
                    </span>
                  )}
                </TableCell>
                {isAdmin && (
                  <TableCell className="text-muted-foreground">
                    {formatText(agentNames.get(doc.agent_id))}
                  </TableCell>
                )}
                <TableCell className="text-muted-foreground">
                  {formatDate(doc.uploaded_at)}
                </TableCell>
                <TableCell>
                  <DownloadDocumentButton
                    documentId={doc.id}
                    label={doc.file_name}
                  />
                </TableCell>
              </TableRow>
            );
          })
        )}
      </TableBody>
    </Table>
  );
}

export default function DocumentsPage() {
  return (
    <div className="flex-1 w-full flex flex-col gap-6 max-w-6xl mx-auto">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-bold">Document Center</h1>
        <p className="text-sm text-muted-foreground">
          Every document you have access to. Files themselves live in a private
          bucket and are only reachable through short-lived signed links.
        </p>
      </div>

      <Suspense
        fallback={
          <p className="text-sm text-muted-foreground">Loading documents…</p>
        }
      >
        <DocumentCenter />
      </Suspense>
    </div>
  );
}
