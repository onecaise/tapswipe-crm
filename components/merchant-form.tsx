"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { createClient } from "@/lib/supabase/client";
import {
  MERCHANT_STATUSES,
  type Merchant,
  type MerchantStatus,
} from "@/lib/merchants";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

type FormState = {
  dba: string;
  legal_business_name: string;
  mid: string;
  status: MerchantStatus;
  processor: string;
  split_agent_pct: string;
  split_company_pct: string;
  date_added: string;
};

function toFormState(merchant?: Merchant): FormState {
  return {
    dba: merchant?.dba ?? "",
    legal_business_name: merchant?.legal_business_name ?? "",
    mid: merchant?.mid ?? "",
    status: merchant?.status ?? "active",
    processor: merchant?.processor ?? "",
    split_agent_pct: merchant?.split_agent_pct?.toString() ?? "",
    split_company_pct: merchant?.split_company_pct?.toString() ?? "",
    date_added: merchant?.date_added ?? "",
  };
}

/** Empty text inputs become NULL, not "". Numbers parse or become NULL. */
function toPayload(form: FormState) {
  const text = (v: string) => (v.trim() === "" ? null : v.trim());
  const num = (v: string) => (v.trim() === "" ? null : Number(v));

  return {
    dba: form.dba.trim(),
    legal_business_name: text(form.legal_business_name),
    mid: text(form.mid),
    status: form.status,
    processor: text(form.processor),
    split_agent_pct: num(form.split_agent_pct),
    split_company_pct: num(form.split_company_pct),
    date_added: text(form.date_added),
    // updated_at is deliberately absent — the set_updated_at() trigger owns it.
  };
}

export function MerchantForm({
  merchant,
  agentId,
}: {
  /** Present when editing; absent when creating. */
  merchant?: Merchant;
  /** The caller's own profile id, used as agent_id on insert. */
  agentId: string;
}) {
  const isEdit = merchant !== undefined;
  const [form, setForm] = useState<FormState>(() => toFormState(merchant));
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const router = useRouter();

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSaving(true);
    setError(null);

    const supabase = createClient();
    const payload = toPayload(form);

    try {
      if (isEdit) {
        // count: "exact" matters. RLS filters rather than erroring, so updating
        // a merchant you don't own returns no error and touches nothing — this
        // form would otherwise report a successful save that never happened.
        const { error: updateError, count } = await supabase
          .from("merchants")
          .update(payload, { count: "exact" })
          .eq("id", merchant.id);

        if (updateError) throw updateError;
        if (count === 0) {
          throw new Error(
            "That merchant could not be updated. It may no longer be in your book.",
          );
        }

        router.push(`/merchants/${merchant.id}`);
      } else {
        // agent_id is the caller's own. The insert policy's `with check` means
        // an agent physically cannot create a row owned by someone else, so
        // this supplies the value the policy requires rather than enforcing it.
        const { data, error: insertError } = await supabase
          .from("merchants")
          .insert({ ...payload, agent_id: agentId })
          .select("id")
          .single();

        if (insertError) throw insertError;
        router.push(`/merchants/${data.id}`);
      }

      // Server components cache per-request; without this the detail page can
      // render the pre-save row.
      router.refresh();
    } catch (err: unknown) {
      setError(describeError(err));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{isEdit ? "Edit merchant" : "New merchant"}</CardTitle>
        <CardDescription>
          {isEdit
            ? "Changes are scoped by your own access — you can only edit merchants in your book."
            : "This merchant will be added to your own book."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="flex flex-col gap-6">
          <div className="grid gap-6 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="dba">DBA *</Label>
              <Input
                id="dba"
                required
                value={form.dba}
                onChange={(e) => set("dba", e.target.value)}
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="legal_business_name">Legal business name</Label>
              <Input
                id="legal_business_name"
                value={form.legal_business_name}
                onChange={(e) => set("legal_business_name", e.target.value)}
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="mid">MID</Label>
              <Input
                id="mid"
                value={form.mid}
                onChange={(e) => set("mid", e.target.value)}
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="status">Status</Label>
              <select
                id="status"
                className="border-input bg-background ring-offset-background focus-visible:ring-ring flex h-10 w-full rounded-md border px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
                value={form.status}
                onChange={(e) => set("status", e.target.value as MerchantStatus)}
              >
                {MERCHANT_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {status}
                  </option>
                ))}
              </select>
            </div>

            <div className="grid gap-2">
              <Label htmlFor="processor">Processor</Label>
              <Input
                id="processor"
                value={form.processor}
                onChange={(e) => set("processor", e.target.value)}
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="date_added">Date added</Label>
              <Input
                id="date_added"
                type="date"
                value={form.date_added}
                onChange={(e) => set("date_added", e.target.value)}
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="split_agent_pct">Agent split %</Label>
              <Input
                id="split_agent_pct"
                type="number"
                min="0"
                max="999.99"
                step="0.01"
                value={form.split_agent_pct}
                onChange={(e) => set("split_agent_pct", e.target.value)}
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="split_company_pct">Company split %</Label>
              <Input
                id="split_company_pct"
                type="number"
                min="0"
                max="999.99"
                step="0.01"
                value={form.split_company_pct}
                onChange={(e) => set("split_company_pct", e.target.value)}
              />
            </div>
          </div>

          {error && <p className="text-sm text-red-500">{error}</p>}

          <div className="flex gap-2">
            <Button type="submit" disabled={isSaving}>
              {isSaving ? "Saving…" : isEdit ? "Save changes" : "Create merchant"}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => router.back()}
              disabled={isSaving}
            >
              Cancel
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

function describeError(err: unknown): string {
  const code =
    typeof err === "object" && err !== null && "code" in err
      ? String((err as { code: unknown }).code)
      : null;

  // merchants.mid is globally unique. The raw message names the conflicting
  // constraint, which would confirm that MID exists on a row this agent can't
  // see — so replace it rather than surfacing it.
  if (code === "23505") {
    return "That MID is already in use.";
  }

  // Failed the insert/update `with check` — e.g. trying to write a row owned by
  // someone else.
  if (code === "42501") {
    return "You don't have access to save that merchant.";
  }

  return err instanceof Error ? err.message : "Something went wrong.";
}
