import Link from "next/link";
import { Suspense } from "react";
import { ArrowLeftIcon } from "lucide-react";

import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import {
  BUSINESS_DOCUMENT_COLUMNS,
  type BusinessDocument,
  hasFile,
} from "@/lib/business-documents";
import { Callout } from "@/components/callout";
import { PageHeader } from "@/components/page-header";
import { PageShell } from "@/components/page-shell";
import { BusinessDocumentAdminRow } from "@/components/business-document-admin-row";
import { BusinessDocumentUpload } from "@/components/business-document-upload";
import { Button } from "@/components/ui/button";

async function ManageDocuments() {
  // Application-level boundary: a rep is redirected rather than shown a page
  // whose every write the database would refuse. The database is the real
  // boundary -- insert and update are is_admin() policies, and the function's
  // upload branch checks callerIsAdmin.
  await requireAdmin();
  const supabase = await createClient();

  // Live rows only, unlike /marketing/manage, which lists archived materials
  // with a Restore button. Here archiving is what "Delete" does, so a deleted
  // document is gone from this page too; the row and its file remain in the
  // database for recovery by an engineer.
  const { data, error } = await supabase
    .from("business_documents")
    .select(BUSINESS_DOCUMENT_COLUMNS)
    .is("archived_at", null)
    .order("category", { ascending: true })
    .order("title", { ascending: true });

  if (error) {
    return (
      <p role="alert" className="text-sm text-destructive">
        Could not load the library. Refresh the page to try again.
      </p>
    );
  }

  const documents = (data ?? []) as BusinessDocument[];
  const unfinished = documents.filter((d) => !hasFile(d)).length;

  return (
    <>
      {/* Declares #business-document-category-suggestions once; every row's
          category input below points at it. A second copy per row would be a
          duplicate element id. */}
      <BusinessDocumentUpload />

      {unfinished > 0 && (
        <Callout tone="warning">
          {unfinished === 1
            ? "One document has no file behind it — its upload did not finish. Delete it and publish the file again."
            : `${unfinished} documents have no file behind them — their uploads did not finish. Delete them and publish those files again.`}
        </Callout>
      )}

      <section className="flex flex-col gap-2" aria-label="Published documents">
        <h2 className="font-semibold">Published documents</h2>
        {documents.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing published yet. The form above puts the first one in front of
            every rep.
          </p>
        ) : (
          <ul className="flex flex-col divide-y rounded-md border">
            {documents.map((doc) => (
              <BusinessDocumentAdminRow key={doc.id} document={doc} />
            ))}
          </ul>
        )}
      </section>
    </>
  );
}

export default function ManageDocumentsPage() {
  return (
    <PageShell width="list">
      <Button asChild variant="ghost" size="sm" className="self-start">
        <Link href="/documents">
          <ArrowLeftIcon size={16} />
          Back to the Document Center
        </Link>
      </Button>

      <PageHeader
        title="Manage documents"
        subtitle="Add, rename, recategorise and delete. Everything here is visible to every active rep."
      />

      <Suspense
        fallback={
          <p className="text-sm text-muted-foreground">Loading documents…</p>
        }
      >
        <ManageDocuments />
      </Suspense>
    </PageShell>
  );
}
