import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Suspense } from "react";
import { ArrowLeftIcon } from "lucide-react";

import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import {
  canEditPreApp,
  type PreApp,
  type PreAppBusinessProfile,
  type PreAppOwner,
  type PreAppTerminal,
  parsePreAppStep,
} from "@/lib/pre-apps";
import { PageShell } from "@/components/page-shell";
import { PreAppWizardShell } from "@/components/pre-app-wizard-shell";
import { BusinessStep } from "@/components/pre-app-steps/business-step";
import { OwnersStep } from "@/components/pre-app-steps/owners-step";
import { ProfileStep } from "@/components/pre-app-steps/profile-step";
import { ReviewStep } from "@/components/pre-app-steps/review-step";
import { SecretsStep } from "@/components/pre-app-steps/secrets-step";
import { TerminalStep } from "@/components/pre-app-steps/terminal-step";
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

  // Only the active step's rows are fetched. Loading all four sections on every
  // step change would triple the query count for data the step cannot show.
  // Review is the one step that needs more than its own section: it mirrors
  // submit_pre_app's rules, which span owners and the card mix.
  const [owners, terminal, cardMix] = await Promise.all([
    step === "owners" || step === "secrets" || step === "review"
      ? supabase
          .from("pre_app_owners")
          .select("*")
          .eq("pre_app_id", preApp.id)
          .order("id")
          .then(({ data }) => (data ?? []) as PreAppOwner[])
      : Promise.resolve<PreAppOwner[]>([]),
    // Review needs this too now that it renders the full summary — without it
    // the terminal section would read "No terminal details recorded yet" on
    // every pre-app that has them.
    step === "terminal" || step === "review"
      ? supabase
          .from("pre_app_terminal")
          .select("*")
          .eq("pre_app_id", preApp.id)
          .maybeSingle()
          .then(({ data }) => (data ?? null) as PreAppTerminal | null)
      : Promise.resolve<PreAppTerminal | null>(null),
    step === "profile" || step === "review"
      ? supabase
          .from("pre_app_business_profile")
          .select("*")
          .eq("pre_app_id", preApp.id)
          .maybeSingle()
          .then(({ data }) => (data ?? null) as PreAppBusinessProfile | null)
      : Promise.resolve<PreAppBusinessProfile | null>(null),
  ]);

  return (
    <PreAppWizardShell
      preAppId={preApp.id}
      dbaName={preApp.dba_name}
      step={step}
      status={preApp.status}
      isAdmin={isAdmin}
    >
      {step === "business" && <BusinessStep preApp={preApp} canEdit />}
      {step === "owners" && (
        <OwnersStep preAppId={preApp.id} owners={owners} canEdit />
      )}
      {step === "terminal" && (
        <TerminalStep preAppId={preApp.id} terminal={terminal} canEdit />
      )}
      {step === "profile" && (
        <ProfileStep preAppId={preApp.id} profile={cardMix} canEdit />
      )}
      {step === "secrets" && (
        <SecretsStep preAppId={preApp.id} owners={owners} canEdit />
      )}
      {step === "review" && (
        <ReviewStep
          preApp={preApp}
          owners={owners}
          profile={cardMix}
          terminal={terminal}
          isAdmin={isAdmin}
        />
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
    <PageShell width="form">
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
    </PageShell>
  );
}
