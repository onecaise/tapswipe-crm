"use client";

import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";

import { createClient } from "@/lib/supabase/client";
import {
  TERMINAL_BOOLEANS,
  type TerminalStepValues,
  terminalStepSchema,
} from "@/lib/pre-app-validation";
import type { PreAppTerminal } from "@/lib/pre-apps";
import { maskPercent } from "@/lib/masks";
import { useAutosave } from "@/hooks/use-autosave";
import { useRegisterStep } from "@/components/pre-app-wizard-shell";
import { MaskedInput } from "@/components/masked-input";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Terminal / POS setup — one row in `pre_app_terminal`.
 *
 * The row may not exist yet, so writes are an upsert on `pre_app_id`. That is
 * only legal because of the `unique (pre_app_id)` constraint added in
 * 20260806140000: PostgREST compiles an upsert to `on conflict (pre_app_id) do
 * update`, which Postgres rejects outright without a unique index on that
 * column. The same constraint is what stops a debounced save leaving two rows.
 */
export function TerminalStep({
  preAppId,
  terminal,
  canEdit,
}: {
  preAppId: number;
  terminal: PreAppTerminal | null;
  canEdit: boolean;
}) {
  const form = useForm<TerminalStepValues>({
    resolver: zodResolver(terminalStepSchema),
    mode: "onChange",
    defaultValues: toFormValues(terminal),
  });

  const autosave = useAutosave<TerminalStepValues>({
    form,
    enabled: canEdit,
    save: async (patch) => {
      const payload = toPayload(patch);
      if (Object.keys(payload).length === 0) return;

      const supabase = createClient();
      // PostgREST derives the DO UPDATE SET list from the payload keys, so a
      // partial upsert leaves every untouched column alone — which is exactly
      // what dirty-field saving needs. In particular the ten boolean columns the
      // rep never touched stay NULL rather than becoming false.
      const { error, count } = await supabase
        .from("pre_app_terminal")
        .upsert(
          { pre_app_id: preAppId, ...payload },
          { onConflict: "pre_app_id", count: "exact" },
        );

      if (error) throw new Error(error.message);
      if (count === 0) {
        throw new Error(
          "Those terminal details could not be saved. Reload the page.",
        );
      }
    },
  });

  useRegisterStep(autosave, form.formState.isValid);
  const errors = form.formState.errors;

  return (
    <form className="flex flex-col gap-8">
      <fieldset className="flex flex-col gap-4">
        <legend className="font-semibold text-sm">Terminal</legend>
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Terminal type" error={errors.terminal_type?.message}>
            <Input {...form.register("terminal_type")} disabled={!canEdit} />
          </Field>
          <Field label="Communication method" error={errors.communication_method?.message}>
            <Input {...form.register("communication_method")} disabled={!canEdit} />
          </Field>
          <Field label="Batch-out time" error={errors.batch_out_time?.message}>
            {/* Native time input: emits "" or HH:MM, so a partial value can
                never reach a `time` column and raise 22007. */}
            <Input type="time" {...form.register("batch_out_time")} disabled={!canEdit} />
          </Field>
          <Field label="FNS number" error={errors.fns_number?.message}>
            <Input {...form.register("fns_number")} disabled={!canEdit} />
          </Field>
          <MaskedField
            label="Tax rate %"
            error={errors.tax_rate?.message}
            disabled={!canEdit}
            value={form.watch("tax_rate")}
            onChange={(v) =>
              form.setValue("tax_rate", v, { shouldDirty: true, shouldValidate: true })
            }
          />
          <Field label="Software name / version" error={errors.software_name_version?.message}>
            <Input {...form.register("software_name_version")} disabled={!canEdit} />
          </Field>
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-4">
        <legend className="font-semibold text-sm">Options</legend>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {TERMINAL_BOOLEANS.map(([name, label]) => (
            <label key={name} className="flex items-center gap-2 text-sm">
              <Checkbox
                checked={form.watch(name)}
                disabled={!canEdit}
                onCheckedChange={(checked) =>
                  form.setValue(name, checked === true, {
                    shouldDirty: true,
                    shouldValidate: true,
                  })
                }
              />
              {label}
            </label>
          ))}
        </div>
      </fieldset>

      <fieldset className="flex flex-col gap-4">
        <legend className="font-semibold text-sm">Receipts and paperwork</legend>
        <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Refund policy" error={errors.refund_policy?.message}>
            <Input {...form.register("refund_policy")} disabled={!canEdit} />
          </Field>
          <Field label="Receipt header" error={errors.receipt_header_message?.message}>
            <Input {...form.register("receipt_header_message")} disabled={!canEdit} />
          </Field>
          <Field label="Receipt footer" error={errors.receipt_footer_message?.message}>
            <Input {...form.register("receipt_footer_message")} disabled={!canEdit} />
          </Field>
          <Field label="Pricing provided" error={errors.pricing_provided?.message}>
            <Input {...form.register("pricing_provided")} disabled={!canEdit} />
          </Field>
          <Field label="Statement analysis" error={errors.statement_analysis?.message}>
            <Input {...form.register("statement_analysis")} disabled={!canEdit} />
          </Field>
          <Field label="MP/AP name" error={errors.mp_ap_name?.message}>
            <Input {...form.register("mp_ap_name")} disabled={!canEdit} />
          </Field>
          <Field label="RP name" error={errors.rp_name?.message}>
            <Input {...form.register("rp_name")} disabled={!canEdit} />
          </Field>
        </div>
        <p className="text-xs text-muted-foreground">
          The RP password is entered on the Sensitive data step — it is encrypted
          and never stored alongside these fields.
        </p>
      </fieldset>
    </form>
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
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

function MaskedField({
  label,
  value,
  onChange,
  error,
  disabled,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  error?: string;
  disabled?: boolean;
}) {
  return (
    <Field label={label} error={error}>
      <MaskedInput
        mask={maskPercent}
        value={value}
        onChange={onChange}
        disabled={disabled}
        aria-invalid={Boolean(error)}
      />
    </Field>
  );
}

function toFormValues(terminal: PreAppTerminal | null): TerminalStepValues {
  const s = (value: string | null | undefined) => value ?? "";
  // A NULL boolean shows as unchecked. It stays NULL in the database until the
  // rep actually toggles it, because autosave only sends dirty fields — so
  // "never answered" survives being displayed as "no".
  const b = (value: boolean | null | undefined) => value === true;
  return {
    batch_out_time: s(terminal?.batch_out_time),
    terminal_type: s(terminal?.terminal_type),
    communication_method: s(terminal?.communication_method),
    fns_number: s(terminal?.fns_number),
    tax_rate: terminal?.tax_rate == null ? "" : String(terminal.tax_rate),
    refund_policy: s(terminal?.refund_policy),
    software_name_version: s(terminal?.software_name_version),
    pricing_provided: s(terminal?.pricing_provided),
    statement_analysis: s(terminal?.statement_analysis),
    receipt_header_message: s(terminal?.receipt_header_message),
    receipt_footer_message: s(terminal?.receipt_footer_message),
    mp_ap_name: s(terminal?.mp_ap_name),
    rp_name: s(terminal?.rp_name),
    auto_batch: b(terminal?.auto_batch),
    dial_9_outside: b(terminal?.dial_9_outside),
    reprogram_terminal: b(terminal?.reprogram_terminal),
    equipment_purchase: b(terminal?.equipment_purchase),
    equipment_rental: b(terminal?.equipment_rental),
    next_day_funding: b(terminal?.next_day_funding),
    tip_edit: b(terminal?.tip_edit),
    ebt: b(terminal?.ebt),
    tax_calculation: b(terminal?.tax_calculation),
    print_refund_on_footer: b(terminal?.print_refund_on_footer),
    software_pos_integration: b(terminal?.software_pos_integration),
  };
}

function toPayload(patch: Partial<TerminalStepValues>): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const [key, raw] of Object.entries(patch)) {
    if (raw === undefined) continue;
    if (typeof raw === "boolean") {
      payload[key] = raw;
      continue;
    }
    const value = String(raw).trim();
    if (key === "tax_rate") {
      // numeric(5,3). Omit an unparseable entry rather than nulling it, so a
      // transient state while typing cannot wipe a saved value.
      if (value === "") {
        payload[key] = null;
      } else {
        const n = Number(value);
        if (!Number.isNaN(n)) payload[key] = n;
      }
      continue;
    }
    payload[key] = value === "" ? null : value;
  }
  return payload;
}
