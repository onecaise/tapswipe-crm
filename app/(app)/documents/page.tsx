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
import { PageHeader } from "@/components/page-header";
import { PageShell } from "@/components/page-shell";
import { DownloadDocumentButton } from "@/components/download-document-button";
import { ListTable, type ListColumn } from "@/components/list-table";
import { Badge } from "@/components/ui/badge";

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

  // The list's shape as data, so the table and the stacked-card view below lg
  // cannot disagree about it. Two things here the other list pages do not have:
  //
  //   * The primary column is NOT a link. A document's name identifies the row,
  //     but the thing you act on is the download button, and the bytes are only
  //     reachable through a short-lived signed URL.
  //   * The download button is a LABEL-LESS column (header ""), which renders
  //     under a bare <TableHead /> in the table and, on a card, full width
  //     under the fields rather than beside an empty label.
  //
  // The hand-counted colSpan={isAdmin ? 6 : 5} it replaces was correct — the
  // trailing action column was included in that count. Taking the number from
  // the definition keeps it correct when a column is added.
  const columns: ListColumn<DocumentRow>[] = [
    {
      header: "File",
      primary: true,
      className: "font-medium",
      cell: (doc) => formatText(doc.file_name),
    },
    {
      header: "Type",
      cell: (doc) => <Badge variant="secondary">{doc.doc_type}</Badge>,
    },
    {
      header: "Attached to",
      cell: (doc) => {
        const href = ownerHref(doc.owner_type, doc.owner_id);
        const label = `${OWNER_TYPE_LABELS[doc.owner_type]} #${doc.owner_id}`;
        return href ? (
          <Link href={href} className="underline underline-offset-4">
            {label}
          </Link>
        ) : (
          // Unreachable while all four owner types have a detail page, and kept
          // for the next one that lands in the check constraint before its page
          // exists: an unlinked reference beats a dead link. ownerHref is where
          // that decision lives.
          <span className="text-muted-foreground">{label}</span>
        );
      },
    },
    ...(isAdmin
      ? [
          {
            header: "Agent",
            className: "text-muted-foreground",
            cell: (doc: DocumentRow) => formatText(agentNames.get(doc.agent_id)),
          },
        ]
      : []),
    {
      header: "Uploaded",
      className: "text-muted-foreground",
      cell: (doc) => formatDate(doc.uploaded_at),
    },
    {
      header: "",
      cell: (doc) => (
        <DownloadDocumentButton documentId={doc.id} label={doc.file_name} />
      ),
    },
  ];

  return (
    <ListTable
      columns={columns}
      rows={documents}
      rowKey={(doc) => doc.id}
      emptyMessage="No documents yet. Upload one from a merchant, lead, pre-app or support ticket."
    />
  );
}

export default function DocumentsPage() {
  return (
    <PageShell width="list">
      <PageHeader
        title="Document Center"
        subtitle="Every document you have access to. Files themselves live in a private bucket and are only reachable through short-lived signed links."
      />

      <Suspense
        fallback={
          <p className="text-sm text-muted-foreground">Loading documents…</p>
        }
      >
        <DocumentCenter />
      </Suspense>
    </PageShell>
  );
}
