"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { createClient } from "@/lib/supabase/client";
import {
  MAX_CITY_LENGTH,
  MERCHANT_STATUSES,
  type Merchant,
  type MerchantStatus,
} from "@/lib/merchants";
import { US_STATES, isZip } from "@/lib/masks";
import { EMPTY } from "@/lib/format";
import type { OwnerOption } from "@/lib/merchant-owners";
import { friendlyDbError } from "@/lib/db-errors";
import {
  useTypedInput,
  useUnsavedChangesWarning,
} from "@/hooks/use-unsaved-changes-warning";
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
import { Callout } from "@/components/callout";

type FormState = {
  agent_id: string;
  dba: string;
  legal_business_name: string;
  mid: string;
  status: MerchantStatus;
  processor: string;
  split_agent_pct: string;
  split_company_pct: string;
  date_added: string;
  street: string;
  city: string;
  state: string;
  zip: string;
};

function toFormState(merchant?: Merchant): FormState {
  return {
    // No default on create: the admin picks the owner, themself included.
    agent_id: merchant?.agent_id ?? "",
    dba: merchant?.dba ?? "",
    legal_business_name: merchant?.legal_business_name ?? "",
    mid: merchant?.mid ?? "",
    status: merchant?.status ?? "active",
    processor: merchant?.processor ?? "",
    split_agent_pct: merchant?.split_agent_pct?.toString() ?? "",
    split_company_pct: merchant?.split_company_pct?.toString() ?? "",
    date_added: merchant?.date_added ?? "",
    street: merchant?.street ?? "",
    city: merchant?.city ?? "",
    state: merchant?.state ?? "",
    zip: merchant?.zip ?? "",
  };
}

/**
 * The company half of the split, derived from the agent half.
 *
 * Returns null for anything that isn't a usable percentage, so a blank or
 * half-typed field writes NULL to both columns rather than a number derived
 * from nonsense — null/null is the one uneven pair merchants_split_totals_100
 * still allows.
 */
function companySplitFrom(agentSplit: string): number | null {
  if (agentSplit.trim() === "") return null;
  const agent = Number(agentSplit);
  if (!Number.isFinite(agent) || agent < 0 || agent > 100) return null;
  return 100 - agent;
}

/** Empty text inputs become NULL, not "". Numbers parse or become NULL. */
function toPayload(form: FormState) {
  const text = (v: string) => (v.trim() === "" ? null : v.trim());
  const num = (v: string) => (v.trim() === "" ? null : Number(v));

  const company = companySplitFrom(form.split_agent_pct);

  return {
    agent_id: form.agent_id,
    dba: form.dba.trim(),
    legal_business_name: text(form.legal_business_name),
    mid: text(form.mid),
    status: form.status,
    processor: text(form.processor),
    // Both or neither. Sending an agent half with a null company half would
    // trip the constraint, and the rep has no field to correct it with.
    split_agent_pct: company === null ? null : num(form.split_agent_pct),
    split_company_pct: company,
    date_added: text(form.date_added),
    // Blank goes as NULL, never "": a legacy merchant with no location is
    // saved with none (merchants_location_guard only requires one on INSERT),
    // and merchants_location_format would refuse an empty string.
    street: text(form.street),
    city: text(form.city),
    state: form.state === "" ? null : form.state,
    zip: text(form.zip),
    // updated_at is deliberately absent — the set_updated_at() trigger owns it.
  };
}

export function MerchantForm({
  merchant,
  owners,
}: {
  /** Present when editing; absent when creating. */
  merchant?: Merchant;
  /** Who the merchant can belong to: ownerOptions() in lib/merchant-owners.ts. */
  owners: OwnerOption[];
}) {
  const isEdit = merchant !== undefined;
  // Required for a NEW merchant, and for one that already has a location
  // (the database will not let it be removed). Optional only on an existing
  // merchant that predates the columns — so it can still be edited — and
  // that case is announced above the fields rather than left to look normal.
  const hadLocation =
    merchant !== undefined && merchant.city !== null && merchant.state !== null;
  const locationRequired = !isEdit || hadLocation;
  const missingLocation = isEdit && !hadLocation;
  const [form, setForm] = useState<FormState>(() => toFormState(merchant));
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const router = useRouter();
  // Warn before a reload or close throws away typed input (D-07). Nothing is
  // kept in browser storage — see hooks/use-unsaved-changes-warning.ts.
  const { dirty, onInput } = useTypedInput();
  useUnsavedChangesWarning(dirty);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const derivedCompanySplit = companySplitFrom(form.split_agent_pct);
  const companySplitLabel =
    derivedCompanySplit === null ? EMPTY : `${derivedCompanySplit}`;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    // `required` on the inputs stops an empty submit, but not one that is
    // only spaces, a half-filled location, or a malformed ZIP. The database
    // is the boundary (merchants_location_guard / _format); this says it in
    // words first.
    if (form.agent_id === "") {
      setError("Choose the rep this merchant belongs to.");
      return;
    }
    const problem = locationProblem(form, locationRequired);
    if (problem !== null) {
      setError(problem);
      return;
    }
    setIsSaving(true);

    const supabase = createClient();
    const payload = toPayload(form);

    try {
      if (isEdit) {
        // count: "exact" matters. RLS filters rather than erroring, so an
        // update the policy refuses returns no error and touches nothing —
        // this form would otherwise report a successful save that never
        // happened. Since 20261021120000 only an admin passes that policy.
        const { error: updateError, count } = await supabase
          .from("merchants")
          .update(payload, { count: "exact" })
          .eq("id", merchant.id);

        if (updateError) throw updateError;
        if (count === 0) {
          throw new Error(
            "That merchant could not be updated. It may have been deleted, or your account may no longer be an admin.",
          );
        }

        router.push(`/merchants/${merchant.id}`);
      } else {
        // agent_id is the owner the admin picked. "admin insert only" admits
        // any owner for an admin and nobody else; log_cross_agent_change()
        // records a merchant created into another rep's book.
        const { data, error: insertError } = await supabase
          .from("merchants")
          .insert(payload)
          .select("id")
          .single();

        if (insertError) throw insertError;
        // replace, not push (D-07): the filled create form must not be in history,
        // or Back returns to it and a second submit makes a second record.
        router.replace(`/merchants/${data.id}`);
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
            ? "Only admins can change merchant information. Changing the owner moves the merchant to that rep's book."
            : "Choose the rep whose book this merchant belongs to."}{" "}
          {"The owner decides who can see the merchant, not who is paid: residuals follow the Agent # on the processor's file, and a shared account's split is set on the merchant page."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          onSubmit={handleSubmit}
          onInput={onInput}
          className="flex flex-col gap-6"
        >
          <fieldset className="flex flex-col gap-4 rounded-lg border p-4">
            <legend className="px-1 text-sm font-semibold">Location</legend>
            {missingLocation && (
              <Callout tone="warning">
                <p data-testid="merchant-missing-location">
                  This merchant has no location on record. Add its city and
                  state if you can — every new merchant needs them. You can
                  still save other changes without one.
                </p>
              </Callout>
            )}
            <div className="grid gap-6 sm:grid-cols-2">
              <div className="grid gap-2 sm:col-span-2">
                <Label htmlFor="street">Street</Label>
                <Input
                  id="street"
                  autoComplete="street-address"
                  value={form.street}
                  onChange={(e) => set("street", e.target.value)}
                />
              </div>

              <div className="grid gap-2">
                <Label htmlFor="city">{locationRequired ? "City *" : "City"}</Label>
                <Input
                  id="city"
                  required={locationRequired}
                  maxLength={MAX_CITY_LENGTH}
                  autoComplete="address-level2"
                  value={form.city}
                  onChange={(e) => set("city", e.target.value)}
                />
              </div>

              <div className="grid gap-2">
                <Label htmlFor="state">{locationRequired ? "State *" : "State"}</Label>
                <select
                  id="state"
                  required={locationRequired}
                  className="border-input bg-background ring-offset-background focus-visible:ring-ring flex h-10 w-full rounded-md border px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
                  value={form.state}
                  onChange={(e) => set("state", e.target.value)}
                >
                  <option value="">Choose a state</option>
                  {US_STATES.map((s) => (
                    <option key={s.code} value={s.code}>
                      {s.code} — {s.name}
                    </option>
                  ))}
                </select>
              </div>

              <div className="grid gap-2">
                <Label htmlFor="zip">ZIP</Label>
                <Input
                  id="zip"
                  inputMode="numeric"
                  autoComplete="postal-code"
                  value={form.zip}
                  onChange={(e) => set("zip", e.target.value)}
                />
              </div>
            </div>
          </fieldset>

          <div className="grid gap-2">
            <Label htmlFor="agent_id">Owner *</Label>
            <select
              id="agent_id"
              required
              className="border-input bg-background ring-offset-background focus-visible:ring-ring flex h-10 w-full rounded-md border px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
              value={form.agent_id}
              onChange={(e) => set("agent_id", e.target.value)}
            >
              <option value="">Choose an owner</option>
              {owners.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
          </div>

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

            {/* Only the agent half is an input; the company half is derived,
                the same shape the pre-app wizard's business step uses. Both
                being free text is what let 60/45 be saved, and the database now
                refuses it (merchants_split_totals_100) — so leaving two boxes
                here would just turn a silent wrong number into a constraint
                error the rep cannot act on. Blank stays blank: a merchant whose
                split is not recorded yet is an ordinary state, and both columns
                null is the one pair the constraint still allows. */}
            <div className="grid gap-2">
              <Label htmlFor="split_agent_pct">Agent split %</Label>
              <Input
                id="split_agent_pct"
                type="number"
                min="0"
                max="100"
                step="0.01"
                value={form.split_agent_pct}
                onChange={(e) => set("split_agent_pct", e.target.value)}
              />
            </div>

            <div className="grid gap-2">
              <span className="text-xs uppercase tracking-wide text-muted-foreground">
                Company split %
              </span>
              <p className="text-sm">{companySplitLabel}</p>
              <p className="text-xs text-muted-foreground">
                Derived, always 100 minus the agent split.
              </p>
            </div>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

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

  // The location's SHAPE (20261013130000). Matched by name, because 23514 is
  // also what merchants_split_totals_100 raises. Whether a location is
  // REQUIRED comes back from merchants_location_guard as PT422 with its own
  // sentence, which friendlyDbError passes through.
  if (code === "23514" && /merchants_location_format/.test(messageOf(err))) {
    return "Enter a real city name (2 to 60 characters) and pick a state.";
  }

  // Failed the insert/update `with check` — e.g. trying to write a row owned by
  // someone else.
  if (code === "42501") {
    return "You don't have access to save that merchant.";
  }

  return friendlyDbError(err, "Something went wrong.");
}

function messageOf(err: unknown): string {
  return typeof err === "object" && err !== null && "message" in err
    ? String((err as { message: unknown }).message)
    : "";
}

/**
 * The location rules a person can be told about before the round trip. The
 * database still decides; this exists so the answer is a sentence.
 */
function locationProblem(
  form: FormState,
  required: boolean,
): string | null {
  const hasCity = form.city.trim() !== "";
  const hasState = form.state !== "";
  if (required && !hasCity) return "Enter the merchant's city.";
  if (required && !hasState) return "Pick the merchant's state.";
  // Optional (an older merchant with none yet) means both or neither: half a
  // location is neither findable nor fixed.
  if (hasCity && !hasState) return "Pick the merchant's state, or clear the city.";
  if (hasState && !hasCity) return "Enter the merchant's city, or clear the state.";
  if (hasCity && !/[\p{L}\p{N}].*[\p{L}\p{N}]/u.test(form.city)) {
    return "Enter a real city name.";
  }
  if (!isZip(form.zip.trim())) return "ZIP must be 12345 or 12345-6789.";
  return null;
}
