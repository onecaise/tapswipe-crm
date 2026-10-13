import Link from "next/link";
import { Suspense } from "react";
import { SettingsIcon } from "lucide-react";

import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import {
  BUSINESS_DOCUMENT_COLUMNS,
  type BusinessDocument,
  hasFile,
} from "@/lib/business-documents";
import { PageHeader } from "@/components/page-header";
import { PageShell } from "@/components/page-shell";
import { BusinessDocumentLibrary } from "@/components/business-document-library";
import { Button } from "@/components/ui/button";

/**
 * The Document Center: the company's business document library.
 *
 * Until 13 Oct 2026 this page was the cross-record index over `documents` --
 * reps' uploads of merchant paperwork on leads, merchants, pre-apps and
 * tickets. The CRM no longer accepts that paperwork; the path is closed in the
 * database (20261013121000) and the page became the library, modelled on
 * /marketing.
 */
async function Library() {
  const profile = await requireUser();
  const supabase = await createClient();

  // Tier 1. The select policy is "every active user, live rows; an admin, all
  // rows", so archived_at is filtered HERE too: for a rep the policy already
  // hides deleted documents, and for an admin this page should read like a
  // rep's -- the manage page is where an admin sees the real state.
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

  // An unfinished upload would 409 on every action; hidden from reps, shown
  // on the manage page where fixing it is admin work.
  const documents = ((data ?? []) as BusinessDocument[]).filter(hasFile);

  return (
    <>
      {profile.role === "admin" && (
        <div className="flex justify-end">
          <Button asChild size="sm" variant="outline">
            <Link href="/documents/manage">
              <SettingsIcon size={16} />
              Manage documents
            </Link>
          </Button>
        </div>
      )}

      <BusinessDocumentLibrary
        documents={documents}
        emptyMessage="No documents have been published yet."
      />
    </>
  );
}

export default function DocumentsPage() {
  return (
    <PageShell width="list">
      <PageHeader
        title="Document Center"
        subtitle="Company policies, agreements, forms and guides, published by the office. View, download or print any of them."
      />

      <Suspense
        fallback={
          <p className="text-sm text-muted-foreground">Loading documents…</p>
        }
      >
        <Library />
      </Suspense>
    </PageShell>
  );
}
