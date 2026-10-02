"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { AlertTriangleIcon } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import {
  LEAD_STATUSES,
  LEAD_STATUS_LABELS,
  type Lead,
  isLeadStatus,
} from "@/lib/leads";
import {
  type DuplicateMatch,
  duplicateHref,
  ownMessage,
  redactedMessage,
  splitMatches,
} from "@/lib/duplicates";
import { Button } from "@/components/ui/button";
import { Callout } from "@/components/callout";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

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
  "website",
  "lead_source",
  "industry_vertical",
  "probability_to_close",
  "preferred_communication_method",
  "next_followup_date",
  "status",
  "lost_reason",
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
  website: "Website",
  lead_source: "Lead source",
  industry_vertical: "Industry / vertical",
  probability_to_close: "Probability to close",
  preferred_communication_method: "Preferred contact method",
  next_followup_date: "Next follow-up date",
  status: "Stage",
  lost_reason: "Why was it lost?",
};

/**
 * The plain text inputs, by section. `status` and `lost_reason` are deliberately
 * absent — they are a <select> and a conditional <textarea>, rendered after the
 * Pipeline section's grid rather than inside it.
 */
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
      "website",
      "address",
      "city",
      "state",
      "zip",
      "country",
    ],
  },
  {
    title: "Pipeline",
    fields: ["lead_source", "probability_to_close", "next_followup_date"],
  },
];

const INPUT_TYPES: Partial<Record<FieldName, string>> = {
  contact_email: "email",
  next_followup_date: "date",
  // `url`, not `text`. The browser's own validation is the whole point: a rep
  // typing "acme.com" gets told before the round trip, and there is no CHECK on
  // this column to catch it afterwards.
  website: "url",
};

// Matches merchant-form.tsx's native select. Styled inline rather than as a ui/
// primitive because there are two of them in the app and shadcn's Select pulls
// in a popover for a list of seven.
const SELECT_CLASS =
  "border-input bg-background ring-offset-background focus-visible:ring-ring flex h-10 w-full rounded-md border px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none";

/**
 * New leads start at 'new', matching the column default.
 *
 * An edit keeps whatever the row holds, INCLUDING a value outside the
 * vocabulary: `leads_status_vocabulary` ships NOT VALID, so rows written while
 * the column was free text still hold arbitrary rep-typed strings. Coercing
 * those to 'new' here would silently rewrite someone's note about a specific
 * deal the moment they opened the form to fix a phone number — see the review
 * path in 20261002120000.
 */
function toFormState(lead?: Lead): FormState {
  return Object.fromEntries(
    FIELDS.map((field) => [
      field,
      lead?.[field] ?? (field === "status" && lead === undefined ? "new" : ""),
    ]),
  ) as FormState;
}

/**
 * Empty strings become NULL rather than "", so absent data reads as absent.
 *
 * `status` is the exception and cannot be nulled — the column is `not null`, and
 * the <select> always holds a value anyway. `lost_reason` is cleared whenever
 * the stage is not 'lost', so a lead worked back out of lost does not keep an
 * explanation that no longer applies; `decline_reason` is cleared by the next
 * successful `submit_pre_app()` for the same reason.
 */
function toPayload(form: FormState) {
  const payload = Object.fromEntries(
    FIELDS.map((field) => {
      const value = form[field].trim();
      return [field, value === "" ? null : value];
    }),
  );
  payload.status = form.status;
  if (form.status !== "lost") payload.lost_reason = null;
  // updated_at is deliberately absent — the set_updated_at() trigger owns it.
  return payload;
}

/**
 * The reasons this lead cannot be saved, in plain language.
 *
 * A deliberate mirror of the two CHECK constraints, so the rep sees what is
 * wrong before spending a round trip on it. **Postgres is the authority** —
 * these only pre-empt it. The second one in particular is why the form can be
 * opened on a pre-vocabulary row at all: the constraint is NOT VALID, so the
 * row exists, but any UPDATE to it is checked on the way out and would fail
 * with a bare constraint-violation message naming nothing a rep can act on.
 */
function saveBlockers(form: FormState): string[] {
  const blockers: string[] = [];
  if (!isLeadStatus(form.status)) {
    blockers.push(
      `"${form.status}" isn't a pipeline stage. Pick one before saving.`,
    );
  }
  if (form.status === "lost" && form.lost_reason.trim() === "") {
    blockers.push("A lost lead needs a reason.");
  }
  return blockers;
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
  /**
   * Duplicate warnings from the last check, and whether the rep has seen them.
   *
   * `matches === null` means the check has not run for the form as it currently
   * stands. Any edit resets it to null (see `update`), so changing the phone
   * number after a warning re-checks rather than carrying a stale verdict.
   */
  const [matches, setMatches] = useState<DuplicateMatch[] | null>(null);
  const router = useRouter();

  const blockers = saveBlockers(form);
  const staleStatus = isLeadStatus(form.status) ? null : form.status;
  const shown = matches === null ? null : splitMatches(matches);

  /** Every field edit goes through here, so no change can skip the re-check. */
  const update = (field: FieldName, value: string) => {
    setForm((prev) => ({ ...prev, [field]: value }));
    setMatches(null);
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (blockers.length > 0) {
      setError(blockers.join(" "));
      return;
    }

    setIsSaving(true);
    setError(null);

    const supabase = createClient();
    const payload = toPayload(form);

    // Warn, then let them through. The check runs once per edit of the form;
    // a second click on "Create anyway" saves. Creation only — an edit is
    // mostly re-working a lead that already exists, where every field would
    // match itself and the warning would be noise.
    //
    // A FAILING CHECK MUST NOT BLOCK THE SAVE. This is advisory: if the RPC
    // errors we warn in the console and fall through to the insert, because
    // refusing to create a lead because an advisory warning could not be
    // computed is strictly worse than creating a possible duplicate.
    if (!isEdit && matches === null) {
      const { data, error: rpcError } = await supabase.rpc("check_duplicates", {
        contact_email_input: form.contact_email,
        contact_phone_input: form.contact_phone,
        business_phone_input: form.business_phone,
        mobile_phone_input: form.mobile_phone,
        website_input: form.website,
        dba_input: form.dba,
        legal_name_input: form.merchant_legal_name,
        address_input: form.address,
        city_input: form.city,
        state_input: form.state,
        zip_input: form.zip,
      });

      if (rpcError) {
        console.warn("Duplicate check did not run:", rpcError.message);
      } else {
        const found = (data ?? []) as DuplicateMatch[];
        if (found.length > 0) {
          setMatches(found);
          setIsSaving(false);
          return;
        }
        setMatches([]);
      }
    }

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
                      onChange={(e) => update(field, e.target.value)}
                    />
                  </div>
                ))}

                {section.title === "Pipeline" && (
                <div className="grid gap-2">
                  <Label htmlFor="status">{LABELS.status}</Label>
                  <select
                    id="status"
                    className={SELECT_CLASS}
                    value={form.status}
                    onChange={(e) => update("status", e.target.value)}
                  >
                    {/* A value this build doesn't recognise is shown rather than
                        hidden, and disabled so it cannot be chosen again. The
                        rep sees what they typed and what it has to become; the
                        alternative — silently preselecting 'new' — rewrites
                        their words on a form they opened for another reason. */}
                    {staleStatus !== null && (
                      <option value={staleStatus} disabled>
                        {staleStatus} — needs review
                      </option>
                    )}
                    {LEAD_STATUSES.map((status) => (
                      <option key={status} value={status}>
                        {LEAD_STATUS_LABELS[status]}
                      </option>
                    ))}
                  </select>
                </div>
                )}
              </div>

              {/* Rendered inside Pipeline, outside its two-column grid: a reason
                  is a sentence, not a field, and it only exists at one stage. */}
              {section.title === "Pipeline" && form.status === "lost" && (
                <div className="grid gap-2">
                  <Label htmlFor="lost_reason">{LABELS.lost_reason} *</Label>
                  <Textarea
                    id="lost_reason"
                    required
                    rows={3}
                    value={form.lost_reason}
                    onChange={(e) => update("lost_reason", e.target.value)}
                  />
                  <p className="text-xs text-muted-foreground">
                    Price, timing, went with a competitor — whatever the next
                    person reading this lead would want to know.
                  </p>
                </div>
              )}
            </fieldset>
          ))}

          {shown !== null && shown.own.length + shown.redacted.length > 0 && (
            /* A warning, never a gate. The button below stays enabled and says
               "Create anyway" — see lib/duplicates.ts for why a block on a
               cross-book duplicate is unworkable. Warning amber rather than
               destructive red: nothing here is irreversible. */
            <Callout tone="warning" className="flex flex-col gap-3">
              <p className="flex items-center gap-2 font-semibold text-warning">
                <AlertTriangleIcon size={16} aria-hidden />
                This may already be in the system
              </p>

              {shown.own.map((match) => {
                const href = duplicateHref(match);
                return (
                  <div
                    key={`own-${match.record_type}-${match.record_id}`}
                    className="text-sm"
                  >
                    <span className="text-muted-foreground">
                      {ownMessage(match)}
                    </span>{" "}
                    {href === null ? (
                      <span className="font-medium">{match.title}</span>
                    ) : (
                      <Link
                        href={href}
                        target="_blank"
                        className="font-medium underline underline-offset-4"
                      >
                        {match.title}
                      </Link>
                    )}
                    {match.subtitle && (
                      <span className="text-muted-foreground">
                        {" "}
                        ({match.subtitle})
                      </span>
                    )}
                  </div>
                );
              })}

              {/* No id, no name, no link — there is nothing to link to. These
                  rows arrive from the function already stripped; this renders
                  what it is given and must never try to recover more. */}
              {shown.redacted.map((match) => (
                <p
                  key={`redacted-${match.record_type}-${match.matched_field}-${match.strength}`}
                  className="text-sm text-muted-foreground"
                >
                  {redactedMessage(match)}
                </p>
              ))}
            </Callout>
          )}

          {error && <p className="text-sm text-destructive">{error}</p>}

          <div className="flex gap-2">
            <Button type="submit" disabled={isSaving || blockers.length > 0}>
              {isSaving
                ? "Saving…"
                : isEdit
                  ? "Save changes"
                  : shown !== null && shown.own.length + shown.redacted.length > 0
                    ? "Create anyway"
                    : "Create lead"}
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
