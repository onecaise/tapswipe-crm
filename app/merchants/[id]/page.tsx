import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { ArrowLeftIcon, PencilIcon } from "lucide-react";

import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import {
  type Merchant,
  formatDate,
  formatPct,
  statusBadgeVariant,
} from "@/lib/merchants";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

async function MerchantDetail({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const profile = await requireUser();
  const supabase = await createClient();

  const merchantId = Number(id);
  if (!Number.isInteger(merchantId)) {
    notFound();
  }

  const { data, error } = await supabase
    .from("merchants")
    .select("*")
    .eq("id", merchantId)
    .maybeSingle();

  // A merchant that doesn't exist and one owned by another agent are both zero
  // rows here, and both 404. That's deliberate: distinguishing them (403 vs 404)
  // would tell a probing agent which merchant ids exist.
  if (error || !data) {
    notFound();
  }

  const merchant = data as Merchant;

  let agentName: string | null = null;
  if (profile.role === "admin") {
    const { data: agent } = await supabase
      .from("profiles")
      .select("full_name")
      .eq("id", merchant.agent_id)
      .maybeSingle();
    agentName = (agent?.full_name as string | undefined) ?? null;
  }

  return (
    <>
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-2">
          <h1 className="text-2xl font-bold">{merchant.dba}</h1>
          <div className="flex items-center gap-2">
            <Badge variant={statusBadgeVariant(merchant.status)}>
              {merchant.status}
            </Badge>
            {merchant.mid && (
              <span className="text-sm text-muted-foreground">
                MID {merchant.mid}
              </span>
            )}
          </div>
        </div>
        <Button asChild size="sm">
          <Link href={`/merchants/${merchant.id}/edit`}>
            <PencilIcon size={16} />
            Edit
          </Link>
        </Button>
      </div>

      <dl className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
        <Field label="Legal business name">
          {merchant.legal_business_name ?? "—"}
        </Field>
        <Field label="MID">{merchant.mid ?? "—"}</Field>
        <Field label="Processor">{merchant.processor ?? "—"}</Field>
        <Field label="Agent split">{formatPct(merchant.split_agent_pct)}</Field>
        <Field label="Company split">
          {formatPct(merchant.split_company_pct)}
        </Field>
        <Field label="Date added">{formatDate(merchant.date_added)}</Field>
        {agentName !== null && <Field label="Agent">{agentName}</Field>}
        <Field label="Last updated">{formatDate(merchant.updated_at)}</Field>
      </dl>
    </>
  );
}

export default function MerchantDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  // params is passed down unawaited on purpose. Awaiting it here would put
  // dynamic data access outside the Suspense boundary, which cacheComponents
  // rejects at build time. Same shape as app/auth/error/page.tsx.
  return (
    <div className="flex-1 w-full flex flex-col gap-6 p-6 md:p-10 max-w-5xl mx-auto">
      <Button asChild variant="ghost" size="sm" className="self-start">
        <Link href="/merchants">
          <ArrowLeftIcon size={16} />
          Back to merchants
        </Link>
      </Button>

      <Suspense
        fallback={<p className="text-sm text-muted-foreground">Loading…</p>}
      >
        <MerchantDetail params={params} />
      </Suspense>
    </div>
  );
}
