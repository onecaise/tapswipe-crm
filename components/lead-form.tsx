"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { createClient } from "@/lib/supabase/client";
import { type Lead } from "@/lib/leads";
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

/** Every editable column, as strings — form state is text until submit. */
const FIELDS = [
  "dba",
  "merchant_legal_name",
  "contact_name",
  "contact_phone",
  "business_phone",
  "mobile_phone",
  "contact_email",
  "address",
  "city",
  "state",
  "zip",
  "country",
  "lead_source",
  "industry_vertical",
  "probability_to_close",
  "preferred_communication_method",
  "next_followup_date",
  "status",
] as const;

type FieldName = (typeof FIELDS)[number];
type FormState = Record<FieldName, string>;

const LABELS: Record<FieldName, string> = {
  dba: "DBA",
  merchant_legal_name: "Legal business name",
  contact_name: "Contact name",
  contact_phone: "Contact phone",
  business_phone: "Business phone",
  mobile_phone: "Mobile phone",
  contact_email: "Email",
  address: "Address",
  city: "City",
  state: "State",
  zip: "ZIP",
  country: "Country",
  lead_source: "Lead source",
  industry_vertical: "Industry / vertical",
  probability_to_close: "Probability to close",
  preferred_communication_method: "Preferred contact method",
  next_followup_date: "Next follow-up date",
  status: "Status",
};

const SECTIONS: { title: string; fields: readonly FieldName[] }[] = [
  {
    title: "Contact",
    fields: [
      "contact_name",
      "contact_phone",
      "business_phone",
      "mobile_phone",
      "contact_email",
      "preferred_communication_method",
    ],
  },
  {
    title: "Business",
    fields: [
      "dba",
      "merchant_legal_name",
      "industry_vertical",
      "address",
      "city",
      "state",
      "zip",
      "country",
    ],
  },
  {
    title: "Pipeline",
    fields: [
      "lead_source",
      "probability_to_close",
      "next_followup_date",
      "status",
    ],
  },
];

const INPUT_TYPES: Partial<Record<FieldName, string>> = {
  contact_email: "email",
  next_followup_date: "date",
};

function toFormState(lead?: Lead): FormState {
  return Object.fromEntries(
    FIELDS.map((field) => [field, lead?.[field] ?? ""]),
  ) as FormState;
}

/** Empty strings become NULL rather than "", so absent data reads as absent. */
function toPayload(form: FormState) {
  const payload = Object.fromEntries(
    FIELDS.map((field) => {
      const value = form[field].trim();
      return [field, value === "" ? null : value];
    }),
  );
  // updated_at is deliberately absent — the set_updated_at() trigger owns it.
  return payload;
}

export function LeadForm({
  lead,
  agentId,
}: {
  /** Present when editing; absent when creating. */
  lead?: Lead;
  /** The caller's own profile id, used as agent_id on insert. */
  agentId: string;
}) {
  const isEdit = lead !== undefined;
  const [form, setForm] = useState<FormState>(() => toFormState(lead));
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const router = useRouter();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSaving(true);
    setError(null);

    const supabase = createClient();
    const payload = toPayload(form);

    try {
      if (isEdit) {
        // count: "exact" matters. RLS filters rather than erroring, so editing a
        // lead outside your book returns no error and touches nothing — this
        // would otherwise report a save that never happened.
        const { error: updateError, count } = await supabase
          .from("leads")
          .update(payload, { count: "exact" })
          .eq("id", lead.id);

        if (updateError) throw updateError;
        if (count === 0) {
          throw new Error(
            "That lead could not be updated. It may no longer be in your book.",
          );
        }

        router.push(`/leads/${lead.id}`);
      } else {
        // The insert policy's `with check` is what prevents creating a row owned
        // by someone else; this supplies the value that policy requires.
        const { data, error: insertError } = await supabase
          .from("leads")
          .insert({ ...payload, agent_id: agentId })
          .select("id")
          .single();

        if (insertError) throw insertError;
        router.push(`/leads/${data.id}`);
      }

      router.refresh();
    } catch (err: unknown) {
      setError(
        err instanceof Error ? err.message : "Something went wrong saving.",
      );
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{isEdit ? "Edit lead" : "New lead"}</CardTitle>
        <CardDescription>
          {isEdit
            ? "You can only edit leads in your own book."
            : "This lead will be added to your own book."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="flex flex-col gap-8">
          {SECTIONS.map((section) => (
            <fieldset key={section.title} className="flex flex-col gap-4">
              <legend className="font-semibold text-sm">{section.title}</legend>
              <div className="grid gap-6 sm:grid-cols-2">
                {section.fields.map((field) => (
                  <div key={field} className="grid gap-2">
                    <Label htmlFor={field}>
                      {LABELS[field]}
                      {field === "dba" ? " *" : ""}
                    </Label>
                    <Input
                      id={field}
                      type={INPUT_TYPES[field] ?? "text"}
                      required={field === "dba"}
                      value={form[field]}
                      onChange={(e) =>
                        setForm((prev) => ({ ...prev, [field]: e.target.value }))
                      }
                    />
                  </div>
                ))}
              </div>
            </fieldset>
          ))}

          {error && <p className="text-sm text-red-500">{error}</p>}

          <div className="flex gap-2">
            <Button type="submit" disabled={isSaving}>
              {isSaving ? "Saving…" : isEdit ? "Save changes" : "Create lead"}
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
