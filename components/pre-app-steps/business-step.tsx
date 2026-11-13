"use client";

import { cloneElement, isValidElement, useId } from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";

import { createClient } from "@/lib/supabase/client";
import {
  BILLING_TYPE_OPTIONS,
  type BusinessStepValues,
  EIN_TYPE_OPTIONS,
  LEGAL_ENTITY_TYPES,
  SALES_VOLUME_FIELDS,
  UNSET,
  businessStepSchema,
} from "@/lib/pre-app-validation";
import type { PreApp } from "@/lib/pre-apps";
import { SALES_VOLUME_GROUP } from "@/lib/pre-app-form-fields";
import { friendlyDbError } from "@/lib/db-errors";
import { maskMoney, maskPhone, maskZip } from "@/lib/masks";
import { useAutosave } from "@/hooks/use-autosave";
import { useRegisterStep } from "@/components/pre-app-wizard-shell";
import { MaskedInput } from "@/components/masked-input";
import { StateCombobox } from "@/components/state-combobox";
import { ProcessorSelect } from "@/components/processor-select";
import type { Processor } from "@/lib/processors";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Business info — the pre-app parent row.
 *
 * Every field here writes to `pre_apps`, so the whole step is one debounced
 * PATCH of whatever changed.
 */
export function BusinessStep({
  preApp,
  canEdit,
  processors,
  repSplitRate,
}: {
  preApp: PreApp;
  canEdit: boolean;
  /** The processor list, from loadProcessors() in lib/processors.ts. */
  processors: Processor[];
  /**
   * The pre-app's rep's current profiles.split_rate_pct, shown on a draft;
   * null when it could not be read. A submitted pre-app shows its snapshot.
   */
  repSplitRate: number | null;
}) {
  const form = useForm<BusinessStepValues>({
    resolver: zodResolver(businessStepSchema),
    // onChange so a bad format shows immediately and Next greys out, rather than
    // the rep discovering it after filling in the rest of the step.
    mode: "onChange",
    defaultValues: toFormValues(preApp),
  });

  const autosave = useAutosave<BusinessStepValues>({
    form,
    enabled: canEdit,
    save: async (patch) => {
      const supabase = createClient();
      const payload = toPayload(patch);
      if (Object.keys(payload).length === 0) return;

      const { error, count } = await supabase
        .from("pre_apps")
        .update(payload, { count: "exact" })
        .eq("id", preApp.id);

      if (error) throw new Error(describeError(error));
      // RLS filters rather than erroring, so a write outside the caller's book
      // returns no error and touches nothing. Without this check the indicator
      // would report a save that never happened.
      //
      // Note what this does NOT catch: the update policy ignores `status`, so an
      // admin flipping this pre-app to submitted mid-edit leaves the rep's write
      // still matching the policy. That case surfaces as the guard trigger's
      // error instead, which describeError translates.
      if (count === 0) {
        throw new Error(
          "This pre-app is no longer editable. Reload the page to see its current state.",
        );
      }
    },
  });

  // Validity travels to the shell so Next can be disabled while a format is
  // unfinished. Autosave stays blind to it — the value is still persisted.
  useRegisterStep(autosave, form.formState.isValid);

  const errors = form.formState.errors;
  // A draft shows the rate it will be submitted at; after submit, the
  // snapshot (memo §0b.4). Neither is editable here.
  const shownRate =
    preApp.status === "draft" ? repSplitRate : preApp.split_agent_pct;

  return (
    <form className="flex flex-col gap-8">
      <Section title="Business">
        <Field label="DBA name" required error={errors.dba_name?.message}>
          <Input {...form.register("dba_name")} disabled={!canEdit} />
        </Field>
        <Field
          label="Legal business name"
          required
          error={errors.legal_business_name?.message}
        >
          <Input
            {...form.register("legal_business_name")}
            disabled={!canEdit}
          />
        </Field>
        <Field label="Contact name" error={errors.contact_name?.message}>
          <Input {...form.register("contact_name")} disabled={!canEdit} />
        </Field>
        <MaskedField
          label="Contact phone"
          required
          mask={maskPhone}
          placeholder="615-555-1234"
          error={errors.contact_phone?.message}
          disabled={!canEdit}
          value={form.watch("contact_phone")}
          onChange={(v) =>
            form.setValue("contact_phone", v, { shouldDirty: true, shouldValidate: true })
          }
        />
        <MaskedField
          label="Business phone"
          mask={maskPhone}
          placeholder="615-555-1234"
          error={errors.phone_number?.message}
          disabled={!canEdit}
          value={form.watch("phone_number")}
          onChange={(v) =>
            form.setValue("phone_number", v, { shouldDirty: true, shouldValidate: true })
          }
        />
        <MaskedField
          label="Fax"
          mask={maskPhone}
          placeholder="615-555-1234"
          error={errors.fax_number?.message}
          disabled={!canEdit}
          value={form.watch("fax_number")}
          onChange={(v) =>
            form.setValue("fax_number", v, { shouldDirty: true, shouldValidate: true })
          }
        />
        <Field label="Email" error={errors.email_address?.message}>
          <Input
            type="email"
            {...form.register("email_address")}
            disabled={!canEdit}
          />
        </Field>
        <Field label="Website" error={errors.website?.message}>
          <Input
            placeholder="https://"
            {...form.register("website")}
            disabled={!canEdit}
          />
        </Field>
      </Section>

      <Section title="Address">
        <Field label="Street address" required error={errors.physical_address?.message}>
          <Input {...form.register("physical_address")} disabled={!canEdit} />
        </Field>
        <Field label="City" required error={errors.city?.message}>
          <Input {...form.register("city")} disabled={!canEdit} />
        </Field>
        <Field label="State" required error={errors.state?.message}>
          <StateCombobox
            value={form.watch("state")}
            disabled={!canEdit}
            aria-invalid={Boolean(errors.state)}
            onChange={(v) =>
              form.setValue("state", v, { shouldDirty: true, shouldValidate: true })
            }
          />
        </Field>
        <MaskedField
          label="ZIP"
          required
          mask={maskZip}
          placeholder="37201"
          error={errors.zip?.message}
          disabled={!canEdit}
          value={form.watch("zip")}
          onChange={(v) =>
            form.setValue("zip", v, { shouldDirty: true, shouldValidate: true })
          }
        />
        {/* Fixed, not a field: only US merchants are supported, and the
            column holds 'US' and nothing else (pre_apps_country_us, memo
            A14). Relaxing it means relaxing the two-letter state rule too. */}
        <ReadOnlyValue label="Country" value="United States" />
      </Section>

      <Section title="Business type">
        <Field
          label="Entity type"
          required
          htmlFor="legal-entity-type"
          error={errors.legal_entity_type?.message}
        >
          <Input
            id="legal-entity-type"
            list="legal-entity-types"
            {...form.register("legal_entity_type")}
            disabled={!canEdit}
          />
          <datalist id="legal-entity-types">
            {LEGAL_ENTITY_TYPES.map((option) => (
              <option key={option} value={option} />
            ))}
          </datalist>
        </Field>
        <Field label="State incorporated" required error={errors.state_incorporated?.message}>
          <StateCombobox
            value={form.watch("state_incorporated")}
            disabled={!canEdit}
            aria-invalid={Boolean(errors.state_incorporated)}
            onChange={(v) =>
              form.setValue("state_incorporated", v, {
                shouldDirty: true,
                shouldValidate: true,
              })
            }
          />
        </Field>
        <Field label="Business type" required error={errors.business_type?.message}>
          <Input {...form.register("business_type")} disabled={!canEdit} />
        </Field>
        <Field label="Sub type" error={errors.sub_business_type?.message}>
          <Input {...form.register("sub_business_type")} disabled={!canEdit} />
        </Field>
        <Field label="Business start date" error={errors.business_start_date?.message}>
          {/* A native date input emits "" or a complete YYYY-MM-DD, so a partial
              date can never reach a `date` column and produce a 22007. That is
              why dates are not masked. */}
          <Input
            type="date"
            {...form.register("business_start_date")}
            disabled={!canEdit}
          />
        </Field>
        {/* The type only. The number is a secret: it is entered on the
            Sensitive data step, encrypted, and never autosaved. Changing the
            type after the number was entered means entering it again —
            submit_pre_app() counts only a stored number of this kind. */}
        <Field label="EIN type" required error={errors.ein_type?.message}>
          <select
            {...form.register("ein_type")}
            disabled={!canEdit}
            className="border-input bg-background flex h-9 w-full rounded-md border px-3 py-1 text-base shadow-xs disabled:opacity-50 md:text-sm"
          >
            {EIN_TYPE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>
        <Field label="Goods or services sold" error={errors.goods_sold?.message}>
          <Input {...form.register("goods_sold")} disabled={!canEdit} />
        </Field>
        <Field label="Processor" error={errors.processor?.message}>
          <ProcessorSelect
            {...form.register("processor")}
            processors={processors}
            current={preApp.processor}
            disabled={!canEdit}
          />
        </Field>
      </Section>

      <Section title="Banking and split">
        <Field label="Bank name" required error={errors.bank_name?.message}>
          <Input {...form.register("bank_name")} disabled={!canEdit} />
        </Field>
        <Field label="Billing type" error={errors.billing_type?.message}>
          <select
            {...form.register("billing_type")}
            disabled={!canEdit}
            className="border-input bg-background flex h-9 w-full rounded-md border px-3 py-1 text-base shadow-xs disabled:opacity-50 md:text-sm"
          >
            {BILLING_TYPE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </Field>
        {/* Not entered here (memo §0b.4). The rate is the rep's, set by an
            admin on their profile, and submit_pre_app() copies it onto the
            pre-app; no client can write the split columns. */}
        <ReadOnlyValue
          label="Rep split"
          value={
            shownRate === null
              ? "—"
              : `Rep ${formatRate(shownRate)}% · Company ${formatRate(100 - shownRate)}%`
          }
          hint={
            preApp.status === "draft"
              ? "The rep's rate, set by an admin. It is copied onto the application when it is submitted."
              : "Copied from the rep's rate when this was submitted."
          }
        />
      </Section>

      {/* Estimates, but required at submit and above zero (memo A13). No two
          of these figures are checked against each other; see the note in
          businessStepSchema for why that is deliberate. */}
      <Section title={SALES_VOLUME_GROUP}>
        {SALES_VOLUME_FIELDS.map(([name, label]) => (
          <MoneyField
            key={name}
            label={label}
            form={form}
            name={name}
            error={errors[name]?.message}
            disabled={!canEdit}
          />
        ))}
      </Section>
    </form>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <fieldset className="flex flex-col gap-4">
      <legend className="font-semibold text-sm">{title}</legend>
      <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">{children}</div>
    </fieldset>
  );
}

function Field({
  label,
  htmlFor,
  required,
  error,
  children,
}: {
  label: string;
  /** For a field whose control is not its only child (the datalist one). */
  htmlFor?: string;
  /** Required at submit (pre_app_missing_fields); saving a draft never is. */
  required?: boolean;
  error?: string;
  children: React.ReactNode;
}) {
  // The label has to name its control: a bare <Label> beside the input gave
  // no input on this step an accessible name (QA-004). The id goes onto the
  // single child unless it already carries one.
  const generatedId = useId();
  const childId =
    htmlFor ??
    (isValidElement<{ id?: string }>(children)
      ? (children.props.id ?? generatedId)
      : undefined);
  const control =
    isValidElement<{ id?: string }>(children) && children.props.id === undefined
      ? cloneElement(children, { id: generatedId })
      : children;
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={childId}>
        {label}
        {required && <RequiredMark />}
      </Label>
      {control}
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

/**
 * The required marker. aria-hidden, so the field's accessible name stays its
 * label ("City", not "City *"); the requirement itself is enforced and listed
 * by pre_app_missing_fields() on the review step.
 */
function RequiredMark() {
  return (
    <span aria-hidden="true" className="text-muted-foreground" title="Required to submit">
      *
    </span>
  );
}

/** A fixed value shown where a field would be: not an input, not autosaved. */
function ReadOnlyValue({
  label,
  value,
  hint,
}: {
  label: string;
  value: string;
  hint?: string;
}) {
  return (
    <div className="flex flex-col gap-2">
      <span className="text-sm font-medium leading-none">{label}</span>
      <span className="text-sm">{value}</span>
      {hint && <span className="text-xs text-muted-foreground">{hint}</span>}
    </div>
  );
}

/** 50 -> "50", 46.5 -> "46.5": a numeric(5,2) without trailing zeros. */
function formatRate(rate: number): string {
  return String(Number(rate.toFixed(2)));
}

/**
 * A dollar amount, masked as it is typed.
 *
 * Same shape as PercentField in profile-step.tsx, and module-level for the same
 * reason: a component defined inside the step would be a new type on every
 * render, remounting the input and throwing away the caret mid-figure.
 */
function MoneyField({
  label,
  form,
  name,
  error,
  disabled,
}: {
  label: string;
  form: ReturnType<typeof useForm<BusinessStepValues>>;
  name: keyof BusinessStepValues;
  error?: string;
  disabled?: boolean;
}) {
  return (
    <Field label={label} required error={error}>
      <MaskedInput
        mask={maskMoney}
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

function MaskedField({
  label,
  required,
  mask,
  value,
  onChange,
  error,
  placeholder,
  disabled,
}: {
  label: string;
  required?: boolean;
  mask: (value: string) => string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  placeholder?: string;
  disabled?: boolean;
}) {
  return (
    <Field label={label} required={required} error={error}>
      <MaskedInput
        mask={mask}
        value={value}
        onChange={onChange}
        placeholder={placeholder}
        disabled={disabled}
        aria-invalid={Boolean(error)}
      />
    </Field>
  );
}

/** DB row -> form state. Everything becomes a string; null becomes "". */
function toFormValues(preApp: PreApp): BusinessStepValues {
  const s = (value: string | null) => value ?? "";
  // A numeric column arrives as a number (or null) and has to reach the form as
  // a string, the same way profile-step.tsx loads the card-mix percentages.
  const n = (value: number | null) => (value == null ? "" : String(value));
  return {
    dba_name: preApp.dba_name,
    legal_business_name: preApp.legal_business_name,
    contact_name: s(preApp.contact_name),
    contact_phone: s(preApp.contact_phone),
    phone_number: s(preApp.phone_number),
    fax_number: s(preApp.fax_number),
    email_address: s(preApp.email_address),
    website: s(preApp.website),
    physical_address: s(preApp.physical_address),
    city: s(preApp.city),
    state: s(preApp.state),
    zip: s(preApp.zip),
    state_incorporated: s(preApp.state_incorporated),
    legal_entity_type: s(preApp.legal_entity_type),
    business_type: s(preApp.business_type),
    sub_business_type: s(preApp.sub_business_type),
    business_start_date: s(preApp.business_start_date),
    ein_type: preApp.ein_type ?? UNSET,
    goods_sold: s(preApp.goods_sold),
    billing_type: preApp.billing_type ?? UNSET,
    bank_name: s(preApp.bank_name),
    processor: s(preApp.processor),
    est_annual_volume: n(preApp.est_annual_volume),
    est_monthly_volume: n(preApp.est_monthly_volume),
    est_average_ticket: n(preApp.est_average_ticket),
    est_high_ticket: n(preApp.est_high_ticket),
  };
}

/**
 * The columns toPayload must coerce to numbers, derived from the one list
 * rather than retyped — a key missing from a hand-written copy here would fall
 * through to the string branch and be the exact bug the branch exists to stop.
 */
const MONEY_KEYS = new Set<string>(SALES_VOLUME_FIELDS.map(([name]) => name));

/**
 * Form state -> a PATCH body, for the dirty fields only.
 *
 * Empty strings become NULL rather than "", so absent data reads as absent —
 * the convention the other forms in this repo already follow.
 */
function toPayload(
  patch: Partial<BusinessStepValues>,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};

  for (const [key, raw] of Object.entries(patch)) {
    if (raw === undefined) continue;
    const value = typeof raw === "string" ? raw.trim() : raw;

    if (key === "billing_type" || key === "ein_type") {
      payload[key] = value === UNSET || value === "" ? null : value;
      continue;
    }

    if (MONEY_KEYS.has(key)) {
      // These are numeric columns, so the fallthrough below would PATCH a raw
      // string — and a transient "1e" would reach PostgREST as a 22P02 that
      // sticks the indicator on "Save failed" with nothing naming the field.
      //
      // Blank clears the column, which is legal here: these are nullable and
      // "not known" is a real answer while drafting (submit requires > 0). Anything unparseable is
      // omitted entirely, preserving the last good figure rather than wiping it
      // mid-keystroke. SPEC.md §6.1.
      if (value === "") {
        payload[key] = null;
      } else {
        const amount = Number(value);
        if (!Number.isNaN(amount)) payload[key] = amount;
      }
      continue;
    }

    payload[key] = value === "" ? null : value;
  }

  return payload;
}

/** Turns the errors this step can actually provoke into something actionable. */
function describeError(error: { code?: string; message: string }): string {
  // Raised by pre_apps_guard_transitions when a rep edits a pre-app that is no
  // longer a draft — most likely an admin submitted or approved it in another
  // tab while this one was open.
  if (error.code === "P0001" || error.message.includes("can only be edited")) {
    return "This pre-app is no longer a draft. Reload the page to see its current state.";
  }
  if (error.code === "23514") {
    return "That value is outside the range the application allows.";
  }
  if (error.code === "42501") {
    return "You don't have access to change this pre-app.";
  }
  return friendlyDbError(error, "Could not save changes.");
}
