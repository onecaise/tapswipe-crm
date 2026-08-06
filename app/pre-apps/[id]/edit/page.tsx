import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { ArrowLeftIcon } from "lucide-react";

import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import {
  canEditPreApp,
  PRE_APP_STEP_LABELS,
  type PreApp,
  parsePreAppStep,
} from "@/lib/pre-apps";
import { PreAppWizardShell } from "@/components/pre-app-wizard-shell";
import { BusinessStep } from "@/components/pre-app-steps/business-step";
import { Button } from "@/components/ui/button";

async function PreAppEditor({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ step?: string }>;
}) {
  const [{ id }, { step: rawStep }] = await Promise.all([params, searchParams]);
  const profile = await requireUser();
  const supabase = await createClient();

  const preAppId = Number(id);
  if (!Number.isInteger(preAppId)) {
    notFound();
  }

  const { data, error } = await supabase
    .from("pre_apps")
    .select("*")
    .eq("id", preAppId)
    .maybeSingle();

  // Missing and not-yours are both zero rows, and both 404.
  if (error || !data) {
    notFound();
  }

  const preApp = data as PreApp;
  const isAdmin = profile.role === "admin";

  // Read-only lives on the detail page, so there is exactly one surface where
  // masking of sensitive values has to be right. A locked pre-app redirects
  // there rather than rendering a disabled wizard.
  if (!canEditPreApp(preApp.status, isAdmin)) {
    redirect(`/pre-apps/${preApp.id}`);
  }

  const step = parsePreAppStep(rawStep);

  return (
    <PreAppWizardShell
      preAppId={preApp.id}
      dbaName={preApp.dba_name}
      step={step}
      status={preApp.status}
      isAdmin={isAdmin}
    >
      {step === "business" ? (
        <BusinessStep preApp={preApp} canEdit />
      ) : (
        <p className="rounded-md border border-dashed p-6 text-sm text-muted-foreground">
          The {PRE_APP_STEP_LABELS[step].toLowerCase()} step isn&rsquo;t built
          yet. Navigation and autosave work; the fields land in a later change.
        </p>
      )}
    </PreAppWizardShell>
  );
}

export default function EditPreAppPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ step?: string }>;
}) {
  return (
    <div className="flex-1 w-full flex flex-col gap-6 p-6 md:p-10 max-w-3xl mx-auto">
      <Button asChild variant="ghost" size="sm" className="self-start">
        <Link href="/pre-apps">
          <ArrowLeftIcon size={16} />
          Back to pre-apps
        </Link>
      </Button>

      {/* Both promises stay unawaited here — awaiting either outside a Suspense
          boundary is what cacheComponents rejects at build time. One boundary,
          not keyed on the step: a keyed boundary is a new boundary, which would
          force the fallback on every step change instead of letting the current
          step stay visible through the transition. */}
      <Suspense
        fallback={<p className="text-sm text-muted-foreground">Loading…</p>}
      >
        <PreAppEditor params={params} searchParams={searchParams} />
      </Suspense>
    </div>
  );
}
