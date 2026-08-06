"use client";

import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";

import { createClient } from "@/lib/supabase/client";
import {
  BILLING_TYPE_OPTIONS,
  type BusinessStepValues,
  LEGAL_ENTITY_TYPES,
  UNSET,
  businessStepSchema,
} from "@/lib/pre-app-validation";
import type { PreApp } from "@/lib/pre-apps";
import {
  maskEin,
  maskPercent,
  maskPhone,
  maskZip,
} from "@/lib/masks";
import { useAutosave } from "@/hooks/use-autosave";
import { useRegisterStep } from "@/components/pre-app-wizard-shell";
import { MaskedInput } from "@/components/masked-input";
import { StateCombobox } from "@/components/state-combobox";
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
}: {
  preApp: PreApp;
  canEdit: boolean;
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
  const agentSplit = form.watch("split_agent_pct");
  const companySplit = deriveCompanySplit(agentSplit);

  return (
    <form className="flex flex-col gap-8">
      <Section title="Business">
        <Field label="DBA name" error={errors.dba_name?.message}>
          <Input {...form.register("dba_name")} disabled={!canEdit} />
        </Field>
        <Field
          label="Legal business name"
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
        <Field label="Street address" error={errors.physical_address?.message}>
          <Input {...form.register("physical_address")} disabled={!canEdit} />
        </Field>
        <Field label="City" error={errors.city?.message}>
          <Input {...form.register("city")} disabled={!canEdit} />
        </Field>
        <Field label="State" error={errors.state?.message}>
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
          mask={maskZip}
          placeholder="37201"
          error={errors.zip?.message}
          disabled={!canEdit}
          value={form.watch("zip")}
          onChange={(v) =>
            form.setValue("zip", v, { shouldDirty: true, shouldValidate: true })
          }
        />
        <Field label="Country" error={errors.country?.message}>
          <Input {...form.register("country")} disabled={!canEdit} />
        </Field>
      </Section>

      <Section title="Business type">
        <Field label="Entity type" error={errors.legal_entity_type?.message}>
          <Input
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
        <Field label="State incorporated" error={errors.state_incorporated?.message}>
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
        <Field label="Business type" error={errors.business_type?.message}>
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
        <Field label="EIN type" error={errors.ein_type?.message}>
          <Input {...form.register("ein_type")} disabled={!canEdit} />
        </Field>
        <MaskedField
          label="EIN"
          mask={maskEin}
          placeholder="12-3456789"
          error={errors.ein_number?.message}
          disabled={!canEdit}
          value={form.watch("ein_number")}
          onChange={(v) =>
            form.setValue("ein_number", v, { shouldDirty: true, shouldValidate: true })
          }
        />
        <Field label="Goods or services sold" error={errors.goods_sold?.message}>
          <Input {...form.register("goods_sold")} disabled={!canEdit} />
        </Field>
      </Section>

      <Section title="Banking and split">
        <Field label="Bank name" error={errors.bank_name?.message}>
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
        <MaskedField
          label="Agent split %"
          mask={maskPercent}
          placeholder="50"
          error={errors.split_agent_pct?.message}
          disabled={!canEdit}
          value={form.watch("split_agent_pct")}
          onChange={(v) =>
            form.setValue("split_agent_pct", v, {
              shouldDirty: true,
              shouldValidate: true,
            })
          }
        />
        <div className="flex flex-col gap-1">
          <span className="text-xs uppercase tracking-wide text-muted-foreground">
            Company split %
          </span>
          {/* Derived, not entered. pre_apps_split_sums_to_100 is a table check,
              so writing one column alone — which is what a dirty-field autosave
              does — would raise 23514 the moment the pair stopped totalling 100.
              Deriving the other half makes that state unreachable. */}
          <span className="text-sm">{companySplit ?? "—"}</span>
          <span className="text-xs text-muted-foreground">
            Derived, always 100 minus the agent split.
          </span>
        </div>
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

function MaskedField({
  label,
  mask,
  value,
  onChange,
  error,
  placeholder,
  disabled,
}: {
  label: string;
  mask: (value: string) => string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  placeholder?: string;
  disabled?: boolean;
}) {
  return (
    <Field label={label} error={error}>
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
    country: s(preApp.country),
    zip: s(preApp.zip),
    state_incorporated: s(preApp.state_incorporated),
    legal_entity_type: s(preApp.legal_entity_type),
    business_type: s(preApp.business_type),
    sub_business_type: s(preApp.sub_business_type),
    business_start_date: s(preApp.business_start_date),
    ein_type: s(preApp.ein_type),
    ein_number: s(preApp.ein_number),
    goods_sold: s(preApp.goods_sold),
    billing_type: preApp.billing_type ?? UNSET,
    bank_name: s(preApp.bank_name),
    split_agent_pct: String(preApp.split_agent_pct),
  };
}

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

    if (key === "billing_type") {
      payload.billing_type = value === UNSET || value === "" ? null : value;
      continue;
    }

    if (key === "split_agent_pct") {
      // Written as a pair, or the sum-to-100 check rejects it. An unparseable
      // or out-of-range entry is omitted entirely rather than nulled: these
      // columns are NOT NULL, and dropping the key preserves the last good
      // value instead of failing the whole save.
      const agent = Number(value);
      if (value === "" || Number.isNaN(agent) || agent < 0 || agent > 100) {
        continue;
      }
      payload.split_agent_pct = agent;
      payload.split_company_pct = Number((100 - agent).toFixed(2));
      continue;
    }

    payload[key] = value === "" ? null : value;
  }

  return payload;
}

function deriveCompanySplit(agentSplit: string): string | null {
  const agent = Number(agentSplit);
  if (agentSplit.trim() === "" || Number.isNaN(agent) || agent < 0 || agent > 100) {
    return null;
  }
  return String(Number((100 - agent).toFixed(2)));
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
  return error.message;
}
