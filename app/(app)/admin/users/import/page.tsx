import Link from "next/link";
import { Suspense } from "react";
import { ArrowLeftIcon } from "lucide-react";

import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { formatDate, formatText } from "@/lib/format";
import {
  USER_IMPORT_BATCH_COLUMNS,
  batchStatusIntent,
  type UserImportBatch,
} from "@/lib/user-imports";
import { PageHeader } from "@/components/page-header";
import { PageShell } from "@/components/page-shell";
import { StatusBadge } from "@/components/status-badge";
import { UserImportUpload } from "@/components/user-import-upload";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/**
 * Import reps: the upload form, and every import ever started.
 *
 * Two independent boundaries, as on the other admin pages: requireAdmin() here,
 * and admin-only policies on user_import_batches. Strip the first and a rep
 * still gets nothing back.
 */
async function ImportBatches() {
  await requireAdmin();

  const supabase = await createClient();
  const { data, error } = await supabase
    .from("user_import_batches")
    .select(USER_IMPORT_BATCH_COLUMNS)
    .order("id", { ascending: false });

  if (error) {
    return (
      <p className="text-sm text-destructive">
        Could not load imports: {error.message}
      </p>
    );
  }

  const batches = (data ?? []) as UserImportBatch[];

  return (
    <div className="flex flex-col gap-6">
      <UserImportUpload />

      {batches.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No rep lists have been imported yet.
        </p>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>File</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Rows</TableHead>
              <TableHead>Uploaded</TableHead>
              <TableHead>Finished</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {batches.map((batch) => (
              <TableRow key={batch.id}>
                <TableCell className="font-medium">
                  <Link
                    href={`/admin/users/import/${batch.id}`}
                    className="text-primary hover:underline"
                  >
                    {formatText(batch.file_name)}
                  </Link>
                </TableCell>
                <TableCell>
                  <StatusBadge intent={batchStatusIntent(batch.status)}>
                    {batch.status}
                  </StatusBadge>
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {batch.row_count}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {formatDate(batch.uploaded_at)}
                </TableCell>
                <TableCell className="text-muted-foreground">
                  {formatDate(batch.committed_at)}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}

export default function UserImportPage() {
  return (
    <PageShell width="list">
      <Button asChild variant="ghost" size="sm" className="self-start">
        <Link href="/admin/users">
          <ArrowLeftIcon size={16} />
          Back to users
        </Link>
      </Button>

      <PageHeader
        title="Import reps"
        subtitle="Create many accounts from one CSV. Nothing is created until you have seen what the file contains — and everyone created here needs a password issued to them afterwards, from the users list."
      />

      {/* cacheComponents: true means dynamic fetches need a Suspense boundary. */}
      <Suspense
        fallback={
          <p className="text-sm text-muted-foreground">Loading imports…</p>
        }
      >
        <ImportBatches />
      </Suspense>
    </PageShell>
  );
}
