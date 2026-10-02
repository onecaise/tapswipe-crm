import Link from "next/link";
import { Suspense } from "react";
import { ArrowLeftIcon } from "lucide-react";

import { requireAdmin } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import {
  MATERIAL_LIST_COLUMNS,
  type MarketingMaterial,
} from "@/lib/marketing-materials";
import { Callout } from "@/components/callout";
import { PageHeader } from "@/components/page-header";
import { PageShell } from "@/components/page-shell";
import { MarketingMaterialAdminRow } from "@/components/marketing-material-admin-row";
import { MarketingMaterialUpload } from "@/components/marketing-material-upload";
import { Button } from "@/components/ui/button";

async function ManageLibrary() {
  // Application-level boundary: non-admins never render this page. The database
  // is the real boundary — the insert and update policies are is_admin() — so a
  // rep who typed this URL would see the page and have every write refused. The
  // guard is so they see a sensible redirect instead of a wall of errors.
  await requireAdmin();
  const supabase = await createClient();

  // Everything, archived and unfinished included. That is the difference
  // between this page and /marketing: a rep reads a curated list, an admin
  // reads the real state of the table.
  const { data, error } = await supabase
    .from("marketing_materials")
    .select(MATERIAL_LIST_COLUMNS)
    .order("archived_at", { ascending: true, nullsFirst: true })
    .order("category", { ascending: true })
    .order("title", { ascending: true });

  if (error) {
    return (
      <p className="text-sm text-destructive">
        Could not load the library: {error.message}
      </p>
    );
  }

  const materials = (data ?? []) as MarketingMaterial[];
  const unfinished = materials.filter((m) => m.file_key === null).length;

  return (
    <>
      <MarketingMaterialUpload />

      {/* No datalist here. MarketingMaterialUpload above declares
          #material-category-suggestions once, and every admin row below points
          its category input at that same id — a second copy on this page would
          be a duplicate element id, which is invalid HTML and makes the
          suggestions resolve unpredictably. The coupling is deliberate but
          invisible, which is why it is written down: the upload form is always
          rendered on this page, so the list is always there for the rows. */}
      {unfinished > 0 && (
        <Callout tone="warning">
          {unfinished === 1
            ? "One material has no file behind it — its upload did not finish. Publish the file again to replace it."
            : `${unfinished} materials have no file behind them — their uploads did not finish. Publish those files again.`}
        </Callout>
      )}

      <section className="flex flex-col gap-2">
        <h2 className="font-semibold">Published materials</h2>
        {materials.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            Nothing published yet. The form above puts the first one in front of
            every rep.
          </p>
        ) : (
          <ul className="flex flex-col divide-y rounded-md border">
            {materials.map((material) => (
              <MarketingMaterialAdminRow
                key={material.id}
                material={material}
              />
            ))}
          </ul>
        )}
      </section>

      <p className="text-xs text-muted-foreground">
        Materials are archived, never deleted: every view, download, print and
        email is recorded against the material, and removing one would take that
        history with it. An archived material disappears from every rep&apos;s
        library and stays readable in the record.
      </p>
    </>
  );
}

export default function ManageMarketingPage() {
  return (
    <PageShell width="list">
      <Button asChild variant="ghost" size="sm" className="self-start">
        <Link href="/marketing">
          <ArrowLeftIcon size={16} />
          Back to the library
        </Link>
      </Button>

      <PageHeader
        title="Manage the library"
        subtitle="Publish, rename, recategorise and archive. Everything here is visible to every active rep."
      />

      <Suspense
        fallback={
          <p className="text-sm text-muted-foreground">Loading library…</p>
        }
      >
        <ManageLibrary />
      </Suspense>
    </PageShell>
  );
}
