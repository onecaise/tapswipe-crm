import Link from "next/link";
import { Suspense } from "react";
import { SettingsIcon } from "lucide-react";

import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import {
  MATERIAL_LIST_COLUMNS,
  type MarketingMaterial,
  hasFile,
} from "@/lib/marketing-materials";
import { PageHeader } from "@/components/page-header";
import { PageShell } from "@/components/page-shell";
import { MarketingLibrary } from "@/components/marketing-library";
import { Button } from "@/components/ui/button";

async function Library() {
  const profile = await requireUser();
  const supabase = await createClient();

  // Tier 1. The select policy on marketing_materials is "any active signed-in
  // user" — no agent_id to scope by, because this is company reference data —
  // so this is the same query for a rep and for an admin.
  //
  // archived_at is filtered HERE rather than relying on the partial index: the
  // index makes the query fast, it does not make it correct.
  const { data, error } = await supabase
    .from("marketing_materials")
    .select(MATERIAL_LIST_COLUMNS)
    .is("archived_at", null)
    .order("category", { ascending: true })
    .order("title", { ascending: true });

  if (error) {
    return (
      <p className="text-sm text-destructive">
        Could not load the library: {error.message}
      </p>
    );
  }

  // A material whose upload never finished has a null file_key, and every
  // action on it would 409. Hidden from reps rather than shown as a broken row;
  // /marketing/manage deliberately shows them, because fixing one is admin work.
  const materials = ((data ?? []) as MarketingMaterial[]).filter(hasFile);

  return (
    <>
      {profile.role === "admin" && (
        <div className="flex justify-end">
          <Button asChild size="sm" variant="outline">
            <Link href="/marketing/manage">
              <SettingsIcon size={16} />
              Manage library
            </Link>
          </Button>
        </div>
      )}

      {/* leadId is null: these actions are being taken on the library itself,
          not on a deal. marketing_material_events.lead_id is nullable for
          exactly this, so library browsing is logged rather than dropped. */}
      <MarketingLibrary
        materials={materials}
        leadId={null}
        agentId={profile.id}
        emptyMessage="No marketing materials have been published yet."
      />
    </>
  );
}

export default function MarketingPage() {
  return (
    <PageShell width="list">
      <PageHeader
        title="Marketing materials"
        subtitle="Sell sheets, rate cards and one-pagers, published by the office. Open one from a lead to record it against that deal."
      />

      <Suspense
        fallback={
          <p className="text-sm text-muted-foreground">Loading library…</p>
        }
      >
        <Library />
      </Suspense>
    </PageShell>
  );
}
