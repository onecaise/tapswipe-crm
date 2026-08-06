"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { useFieldArray, useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { PlusIcon } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import {
  type OwnerRowValues,
  type OwnersStepValues,
  ownersStepSchema,
} from "@/lib/pre-app-validation";
import type { PreAppOwner } from "@/lib/pre-apps";
import { maskPercent, maskPhone, maskZip } from "@/lib/masks";
import { useAutosave } from "@/hooks/use-autosave";
import { useRegisterStep } from "@/components/pre-app-wizard-shell";
import { MaskedInput } from "@/components/masked-input";
import { StateCombobox } from "@/components/state-combobox";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Ownership — a repeating sub-form over `pre_app_owners`.
 *
 * Two things here are load-bearing and easy to get wrong:
 *
 * 1. The primary key is `rowId` in form state, because `useFieldArray` puts its
 *    own generated `id` on every entry of `fields`. A field named `id` would be
 *    shadowed, and `.eq("id", …)` would target RHF's string.
 *
 * 2. **Adding an owner INSERTs immediately** rather than appending an unsaved
 *    row. Every row therefore always has a real id, autosave is a pure UPDATE,
 *    and two debounced saves cannot race into inserting the same owner twice.
 *    It also matters for the secrets step: `pre_app_owner_secrets` has a foreign
 *    key to `pre_app_owners`, so an SSN has nowhere to go until the owner row
 *    exists. `pre_app_owners` has no NOT NULL column besides `pre_app_id`, so
 *    the empty insert is legal.
 */
export function OwnersStep({
  preAppId,
  owners,
  canEdit,
}: {
  preAppId: number;
  owners: PreAppOwner[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [rowError, setRowError] = useState<string | null>(null);
  // Two-click confirm rather than window.confirm: a native dialog blocks the
  // page until dismissed, and the repo has no dialog component to reach for.
  const [pendingRemoval, setPendingRemoval] = useState<number | null>(null);

  const form = useForm<OwnersStepValues>({
    resolver: zodResolver(ownersStepSchema),
    mode: "onChange",
    defaultValues: { owners: owners.map(toFormRow) },
  });

  const { fields, append, remove } = useFieldArray({
    control: form.control,
    name: "owners",
  });

  const autosave = useAutosave<OwnersStepValues>({
    form,
    enabled: canEdit,
    save: async (_patch, keys) => {
      const supabase = createClient();
      const values = form.getValues();

      // Dirty keys arrive as paths — "owners.2.home_city". Group them by row so
      // one row's worth of edits is one UPDATE rather than one per field.
      const byRow = new Map<number, Record<string, unknown>>();
      for (const key of keys) {
        const match = key.match(/^owners\.(\d+)\.(.+)$/);
        if (!match) continue; // "owners" itself, from an append/remove
        const index = Number(match[1]);
        const field = match[2];
        if (field === "rowId") continue;
        const row = values.owners[index];
        if (!row) continue; // removed since the key was queued
        const next = coerce(field, row[field as keyof OwnerRowValues]);
        // undefined means "not writable yet" (a mid-typing numeric). Skipping it
        // rather than assigning matters: JSON.stringify drops undefined values,
        // so it would otherwise leave an empty PATCH body that PostgREST rejects.
        if (next === undefined) continue;
        const payload = byRow.get(index) ?? {};
        payload[field] = next;
        byRow.set(index, payload);
      }

      for (const [index, payload] of byRow) {
        const rowId = values.owners[index]?.rowId;
        if (!rowId || Object.keys(payload).length === 0) continue;
        const { error, count } = await supabase
          .from("pre_app_owners")
          .update(payload, { count: "exact" })
          .eq("id", rowId);
        if (error) throw new Error(error.message);
        if (count === 0) {
          throw new Error(
            "That owner could not be saved. Reload the page — it may have been removed.",
          );
        }
      }
    },
  });

  useRegisterStep(autosave, form.formState.isValid);

  const values = form.watch("owners");
  const total = values.reduce((sum, row) => {
    const n = Number(row.percent_owned);
    return sum + (Number.isNaN(n) ? 0 : n);
  }, 0);
  const hasControlOwner = values.some((row) => Number(row.percent_owned) >= 51);

  const addOwner = async () => {
    setBusy(true);
    setRowError(null);
    try {
      // Flush first. Pending keys are indexed, so appending or removing a row
      // before they are written would point them at the wrong owner.
      await autosave.flush();

      const supabase = createClient();
      const { data, error } = await supabase
        .from("pre_app_owners")
        .insert({ pre_app_id: preAppId })
        .select("*")
        .single();
      if (error) throw new Error(error.message);

      append(toFormRow(data as PreAppOwner));
      router.refresh();
    } catch (err: unknown) {
      setRowError(err instanceof Error ? err.message : "Could not add an owner.");
    } finally {
      setBusy(false);
    }
  };

  const removeOwner = async (index: number) => {
    setBusy(true);
    setRowError(null);
    try {
      await autosave.flush();

      const rowId = form.getValues().owners[index]?.rowId;
      const supabase = createClient();
      const { error, count } = await supabase
        .from("pre_app_owners")
        .delete({ count: "exact" })
        .eq("id", rowId);
      if (error) throw new Error(error.message);
      if (count === 0) {
        throw new Error("That owner could not be removed.");
      }

      // The SSN goes with it, via the cascade on
      // pre_app_owner_secrets.pre_app_owner_id — no client can clear that table
      // first, so the cascade is the only thing that makes this delete possible.
      remove(index);
      setPendingRemoval(null);
      router.refresh();
    } catch (err: unknown) {
      setRowError(
        err instanceof Error ? err.message : "Could not remove that owner.",
      );
    } finally {
      setBusy(false);
    }
  };

  const errors = form.formState.errors;

  return (
    <div className="flex flex-col gap-6">
      {fields.length === 0 && (
        <p className="rounded-md border border-dashed p-6 text-sm text-muted-foreground">
          No owners yet. At least one owner holding 51% or more is required
          before this application can be submitted.
        </p>
      )}

      {fields.map((field, index) => (
        // key is RHF's generated id, which is what it is for. The database id
        // lives in `rowId` and is never used as a React key.
        <fieldset key={field.id} className="flex flex-col gap-4 rounded-md border p-4">
          <div className="flex items-center justify-between gap-4">
            <legend className="font-semibold text-sm">Owner {index + 1}</legend>
            {canEdit &&
              (pendingRemoval === index ? (
                <span className="flex items-center gap-2">
                  <Button
                    type="button"
                    size="sm"
                    variant="destructive"
                    disabled={busy}
                    onClick={() => void removeOwner(index)}
                  >
                    Confirm remove
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    onClick={() => setPendingRemoval(null)}
                  >
                    Cancel
                  </Button>
                </span>
              ) : (
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={busy}
                  onClick={() => setPendingRemoval(index)}
                >
                  Remove
                </Button>
              ))}
          </div>

          <div className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="Name" error={errors.owners?.[index]?.owner_name?.message}>
              <Input {...form.register(`owners.${index}.owner_name`)} disabled={!canEdit} />
            </Field>
            <Field label="Title" error={errors.owners?.[index]?.title?.message}>
              <Input {...form.register(`owners.${index}.title`)} disabled={!canEdit} />
            </Field>
            <MaskedField
              label="Ownership %"
              mask={maskPercent}
              placeholder="51"
              disabled={!canEdit}
              error={errors.owners?.[index]?.percent_owned?.message}
              value={form.watch(`owners.${index}.percent_owned`)}
              onChange={(v) =>
                form.setValue(`owners.${index}.percent_owned`, v, {
                  shouldDirty: true,
                  shouldValidate: true,
                })
              }
            />
            <MaskedField
              label="Home phone"
              mask={maskPhone}
              placeholder="615-555-1234"
              disabled={!canEdit}
              error={errors.owners?.[index]?.home_phone?.message}
              value={form.watch(`owners.${index}.home_phone`)}
              onChange={(v) =>
                form.setValue(`owners.${index}.home_phone`, v, {
                  shouldDirty: true,
                  shouldValidate: true,
                })
              }
            />
            <Field label="Date of birth" error={errors.owners?.[index]?.dob?.message}>
              <Input type="date" {...form.register(`owners.${index}.dob`)} disabled={!canEdit} />
            </Field>
            <Field label="Ownership length" error={errors.owners?.[index]?.length_of_ownership?.message}>
              <Input {...form.register(`owners.${index}.length_of_ownership`)} disabled={!canEdit} />
            </Field>

            <Field label="ID type" error={errors.owners?.[index]?.id_type?.message}>
              <Input {...form.register(`owners.${index}.id_type`)} disabled={!canEdit} />
            </Field>
            <Field label="ID number" error={errors.owners?.[index]?.id_number?.message}>
              <Input {...form.register(`owners.${index}.id_number`)} disabled={!canEdit} />
            </Field>
            <Field label="ID state" error={errors.owners?.[index]?.id_state?.message}>
              <StateCombobox
                value={form.watch(`owners.${index}.id_state`)}
                disabled={!canEdit}
                aria-invalid={Boolean(errors.owners?.[index]?.id_state)}
                onChange={(v) =>
                  form.setValue(`owners.${index}.id_state`, v, {
                    shouldDirty: true,
                    shouldValidate: true,
                  })
                }
              />
            </Field>
            <Field label="ID issued" error={errors.owners?.[index]?.id_issue_date?.message}>
              <Input type="date" {...form.register(`owners.${index}.id_issue_date`)} disabled={!canEdit} />
            </Field>
            <Field label="ID expires" error={errors.owners?.[index]?.id_expiration_date?.message}>
              <Input type="date" {...form.register(`owners.${index}.id_expiration_date`)} disabled={!canEdit} />
            </Field>

            <Field label="Home address" error={errors.owners?.[index]?.home_address?.message}>
              <Input {...form.register(`owners.${index}.home_address`)} disabled={!canEdit} />
            </Field>
            <Field label="Home city" error={errors.owners?.[index]?.home_city?.message}>
              <Input {...form.register(`owners.${index}.home_city`)} disabled={!canEdit} />
            </Field>
            <Field label="Home state" error={errors.owners?.[index]?.home_state?.message}>
              <StateCombobox
                value={form.watch(`owners.${index}.home_state`)}
                disabled={!canEdit}
                aria-invalid={Boolean(errors.owners?.[index]?.home_state)}
                onChange={(v) =>
                  form.setValue(`owners.${index}.home_state`, v, {
                    shouldDirty: true,
                    shouldValidate: true,
                  })
                }
              />
            </Field>
            <MaskedField
              label="Home ZIP"
              mask={maskZip}
              placeholder="37201"
              disabled={!canEdit}
              error={errors.owners?.[index]?.home_zip?.message}
              value={form.watch(`owners.${index}.home_zip`)}
              onChange={(v) =>
                form.setValue(`owners.${index}.home_zip`, v, {
                  shouldDirty: true,
                  shouldValidate: true,
                })
              }
            />
            <Field label="Home country" error={errors.owners?.[index]?.home_country?.message}>
              <Input {...form.register(`owners.${index}.home_country`)} disabled={!canEdit} />
            </Field>
          </div>
        </fieldset>
      ))}

      {rowError && <p className="text-sm text-red-500">{rowError}</p>}

      {canEdit && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="self-start"
          disabled={busy}
          onClick={() => void addOwner()}
        >
          <PlusIcon size={16} />
          {busy ? "Working…" : "Add owner"}
        </Button>
      )}

      {fields.length > 0 && (
        <div className="flex flex-col gap-1 border-t pt-4 text-sm">
          <span>
            Total ownership: <strong>{round(total)}%</strong>
          </span>
          {!hasControlOwner && (
            // A submit blocker, not a step blocker — Next stays enabled. The
            // rep may legitimately not know the split yet, and submit_pre_app
            // is where the rule is actually enforced.
            <span className="text-muted-foreground">
              One owner must hold at least 51% before this can be submitted.
            </span>
          )}
        </div>
      )}
    </div>
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

function toFormRow(owner: PreAppOwner): OwnerRowValues {
  const s = (value: string | null) => value ?? "";
  return {
    rowId: owner.id,
    owner_name: s(owner.owner_name),
    title: s(owner.title),
    id_type: s(owner.id_type),
    id_number: s(owner.id_number),
    id_issue_date: s(owner.id_issue_date),
    id_expiration_date: s(owner.id_expiration_date),
    id_state: s(owner.id_state),
    dob: s(owner.dob),
    home_phone: s(owner.home_phone),
    percent_owned: owner.percent_owned === null ? "" : String(owner.percent_owned),
    length_of_ownership: s(owner.length_of_ownership),
    home_address: s(owner.home_address),
    home_city: s(owner.home_city),
    home_state: s(owner.home_state),
    home_country: s(owner.home_country),
    home_zip: s(owner.home_zip),
  };
}

/**
 * Form string -> column value.
 *
 * `percent_owned` is numeric: an unparseable entry is dropped rather than
 * nulled, so a transient state while typing cannot wipe a good value.
 */
function coerce(field: string, raw: unknown): unknown {
  const value = typeof raw === "string" ? raw.trim() : raw;
  if (field === "percent_owned") {
    if (value === "") return null;
    const n = Number(value);
    return Number.isNaN(n) ? undefined : n;
  }
  return value === "" ? null : value;
}

const round = (n: number) => Math.round(n * 100) / 100;
