import Link from "next/link";
import { Suspense } from "react";
import { ArrowLeftIcon } from "lucide-react";

import { requireAdmin } from "@/lib/auth";
import { PageHeader } from "@/components/page-header";
import { PageShell } from "@/components/page-shell";
import { NewUserForm } from "@/components/new-user-form";
import { Button } from "@/components/ui/button";

async function NewUser() {
  // Application-level boundary. Not the only one: create-user re-checks
  // is_admin() server-side before it does anything, which is the boundary that
  // actually matters — this only keeps a non-admin from seeing a form that would
  // reject them.
  await requireAdmin();

  return <NewUserForm />;
}

export default function NewUserPage() {
  return (
    <PageShell width="form">
      <Button asChild variant="ghost" size="sm" className="self-start">
        <Link href="/admin/users">
          <ArrowLeftIcon size={16} />
          Back to users
        </Link>
      </Button>

      <PageHeader
        title="New user"
        subtitle="Creates the account and a one-time temporary password. There is no email invite — you hand the password over yourself."
      />

      {/* cacheComponents: true means the requireAdmin() read needs a Suspense
          boundary. */}
      <Suspense
        fallback={<p className="text-sm text-muted-foreground">Loading…</p>}
      >
        <NewUser />
      </Suspense>
    </PageShell>
  );
}
