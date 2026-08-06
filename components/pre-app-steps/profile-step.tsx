"use client";

import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";

import { createClient } from "@/lib/supabase/client";
import {
  type ProfileStepValues,
  profileStepSchema,
} from "@/lib/pre-app-validation";
import type { PreAppBusinessProfile } from "@/lib/pre-apps";
import { maskPercent } from "@/lib/masks";
import { useAutosave } from "@/hooks/use-autosave";
import { useRegisterStep } from "@/components/pre-app-wizard-shell";
import { MaskedInput } from "@/components/masked-input";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Card mix — one row in `pre_app_business_profile`, upserted on `pre_app_id`.
 *
 * The submission rule is **two independent pairs**: swiped + keyed must total
 * 100, and card-present + card-not-present must total 100. MOTO and internet are
 * informational — captured and displayed, never constrained, and deliberately
 * not summed against card-not-present even though in reality they are subsets of
 * it. A single six-column total would reject every honestly-filled form.
 *
 * The totals are shown live but do not block the step: a draft with 60/30 has to
 * remain saveable. `submit_pre_app` is where the pairs are enforced, and
 * `preAppSubmitBlockers` mirrors it so the rep sees the same wording before
 * spending a round trip.
 */
export function ProfileStep({
  preAppId,
  profile,
  canEdit,
}: {
  preAppId: number;
  profile: PreAppBusinessProfile | null;
  canEdit: boolean;
}) {
  const form = useForm<ProfileStepValues>({
    resolver: zodResolver(profileStepSchema),
    mode: "onChange",
    defaultValues: toFormValues(profile),
  });

  const autosave = useAutosave<ProfileStepValues>({
    form,
    enabled: canEdit,
    save: async (patch) => {
      const payload = toPayload(patch);
      if (Object.keys(payload).length === 0) return;

      const supabase = createClient();
      const { error, count } = await supabase
        .from("pre_app_business_profile")
        .upsert(
          { pre_app_id: preAppId, ...payload },
          { onConflict: "pre_app_id", count: "exact" },
        );

      if (error) throw new Error(error.message);
      if (count === 0) {
        throw new Error("That card mix could not be saved. Reload the page.");
      }
    },
  });

  useRegisterStep(autosave, form.formState.isValid);
  const errors = form.formState.errors;

  const readPair = (a: keyof ProfileStepValues, b: keyof ProfileStepValues) => {
    const left = form.watch(a) as string;
    const right = form.watch(b) as string;
    if (left.trim() === "" && right.trim() === "") return null;
    const sum = (Number(left) || 0) + (Number(right) || 0);
    return Math.round(sum * 100) / 100;
  };

  const readTotal = readPair("card_swiped_pct", "card_keyed_pct");
  const presentTotal = readPair("card_present_pct", "card_not_present_pct");

  return (
    <form className="flex flex-col gap-8">
      <fieldset className="flex flex-col gap-4">
        <legend className="font-semibold text-sm">
          How the card is read — must total 100
        </legend>
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          <PercentField
            label="Swiped %"
            form={form}
            name="card_swiped_pct"
            error={errors.card_swiped_pct?.message}
            disabled={!canEdit}
          />
          <PercentField
            label="Keyed %"
            form={form}
            name="card_keyed_pct"
            error={errors.card_keyed_pct?.message}
            disabled={!canEdit}
          />
        </div>
        <PairTotal total={readTotal} />
      </fieldset>

      <fieldset className="flex flex-col gap-4">
        <legend className="font-semibold text-sm">
          Whether the card is present — must total 100
        </legend>
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          <PercentField
            label="Card present %"
            form={form}
            name="card_present_pct"
            error={errors.card_present_pct?.message}
            disabled={!canEdit}
          />
          <PercentField
            label="Card not present %"
            form={form}
            name="card_not_present_pct"
            error={errors.card_not_present_pct?.message}
            disabled={!canEdit}
          />
        </div>
        <PairTotal total={presentTotal} />
      </fieldset>

      <fieldset className="flex flex-col gap-4">
        <legend className="font-semibold text-sm">
          Breakdown — informational
        </legend>
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          <PercentField
            label="MOTO %"
            form={form}
            name="moto_pct"
            error={errors.moto_pct?.message}
            disabled={!canEdit}
          />
          <PercentField
            label="Internet %"
            form={form}
            name="internet_pct"
            error={errors.internet_pct?.message}
            disabled={!canEdit}
          />
          <Field label="Test product type" error={errors.test_product_type?.message}>
            <Input {...form.register("test_product_type")} disabled={!canEdit} />
          </Field>
        </div>
        <p className="text-xs text-muted-foreground">
          Not checked against any total — these describe the card-not-present
          share rather than standing alongside it.
        </p>
      </fieldset>

      <fieldset className="flex flex-col gap-4">
        <legend className="font-semibold text-sm">Notes</legend>
        <Field label="Notes" error={errors.notes?.message}>
          <Input {...form.register("notes")} disabled={!canEdit} />
        </Field>
      </fieldset>
    </form>
  );
}

function PairTotal({ total }: { total: number | null }) {
  if (total === null) {
    return (
      <p className="text-xs text-muted-foreground">
        Leave both blank if this split isn&rsquo;t known yet.
      </p>
    );
  }
  const ok = total === 100;
  return (
    <p className={`text-sm ${ok ? "text-muted-foreground" : "text-amber-600"}`}>
      Total: <strong>{total}%</strong>
      {!ok && " — must be 100 before this can be submitted."}
    </p>
  );
}

function Field({
  label,
  error,
  children,
}: {
  label: string;
  error?: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <Label>{label}</Label>
      {children}
      {error && <p className="text-xs text-red-500">{error}</p>}
    </div>
  );
}

function PercentField({
  label,
  form,
  name,
  error,
  disabled,
}: {
  label: string;
  form: ReturnType<typeof useForm<ProfileStepValues>>;
  name: keyof ProfileStepValues;
  error?: string;
  disabled?: boolean;
}) {
  return (
    <Field label={label} error={error}>
      <MaskedInput
        mask={maskPercent}
        value={form.watch(name) as string}
        disabled={disabled}
        aria-invalid={Boolean(error)}
        onChange={(v) =>
          form.setValue(name, v, { shouldDirty: true, shouldValidate: true })
        }
      />
    </Field>
  );
}

function toFormValues(
  profile: PreAppBusinessProfile | null,
): ProfileStepValues {
  const n = (value: number | null | undefined) =>
    value == null ? "" : String(value);
  return {
    card_swiped_pct: n(profile?.card_swiped_pct),
    card_keyed_pct: n(profile?.card_keyed_pct),
    card_present_pct: n(profile?.card_present_pct),
    card_not_present_pct: n(profile?.card_not_present_pct),
    moto_pct: n(profile?.moto_pct),
    internet_pct: n(profile?.internet_pct),
    test_product_type: profile?.test_product_type ?? "",
    notes: profile?.notes ?? "",
  };
}

function toPayload(patch: Partial<ProfileStepValues>): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(patch)) {
    if (raw === undefined) continue;
    const value = String(raw).trim();
    if (key === "test_product_type" || key === "notes") {
      payload[key] = value === "" ? null : value;
      continue;
    }
    // The six numeric columns. Omit an unparseable entry rather than nulling it.
    if (value === "") {
      payload[key] = null;
    } else {
      const n = Number(value);
      if (!Number.isNaN(n)) payload[key] = n;
    }
  }
  return payload;
}
