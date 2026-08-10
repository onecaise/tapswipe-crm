import type { Lead } from "@/lib/leads";
import { maskPhone, maskZip, matchState } from "@/lib/masks";

/**
 * Shared pre-app types, vocabulary and row shapes.
 *
 * PRE_APP_STATUSES mirrors the check constraint on `pre_apps.status` in
 * supabase/migrations/20260804201300_initial_schema.sql, and the column is now
 * `not null` as of 20260806140000. If that constraint changes, change this too
 * — the database is the authority, this is a copy for the UI's benefit.
 */
export const PRE_APP_STATUSES = [
  "draft",
  "submitted",
  "approved",
  "declined",
] as const;

export type PreAppStatus = (typeof PRE_APP_STATUSES)[number];

/** Filter values accepted by the list page: a real status, or "all". */
export const PRE_APP_FILTERS = ["all", ...PRE_APP_STATUSES] as const;

export type PreAppFilter = (typeof PRE_APP_FILTERS)[number];

/** Tab options for the list page, in display order. */
export const PRE_APP_FILTER_OPTIONS = PRE_APP_FILTERS.map((value) => ({
  value,
  label: value === "all" ? "All" : value,
}));

export type PreApp = {
  id: number;
  agent_id: string;
  lead_id: number | null;
  status: PreAppStatus;
  date_submitted: string | null;
  decline_reason: string | null;

  dba_name: string;
  legal_business_name: string;
  contact_name: string | null;
  contact_phone: string | null;
  physical_address: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  zip: string | null;
  phone_number: string | null;
  fax_number: string | null;
  email_address: string | null;
  website: string | null;

  state_incorporated: string | null;
  legal_entity_type: string | null;
  business_type: string | null;
  sub_business_type: string | null;
  business_start_date: string | null;
  ein_type: string | null;
  ein_number: string | null;
  goods_sold: string | null;

  billing_type: "gross" | "net" | null;
  bank_name: string | null;

  split_agent_pct: number;
  split_company_pct: number;

  created_at: string | null;
  updated_at: string | null;
};

export type PreAppOwner = {
  id: number;
  pre_app_id: number;
  owner_name: string | null;
  title: string | null;
  id_type: string | null;
  id_number: string | null;
  id_issue_date: string | null;
  id_expiration_date: string | null;
  id_state: string | null;
  dob: string | null;
  home_phone: string | null;
  percent_owned: number | null;
  length_of_ownership: string | null;
  home_address: string | null;
  home_city: string | null;
  home_state: string | null;
  home_country: string | null;
  home_zip: string | null;
};

export type PreAppTerminal = {
  id: number;
  pre_app_id: number;
  batch_out_time: string | null;
  terminal_type: string | null;
  auto_batch: boolean | null;
  communication_method: string | null;
  dial_9_outside: boolean | null;
  reprogram_terminal: boolean | null;
  equipment_purchase: boolean | null;
  equipment_rental: boolean | null;
  next_day_funding: boolean | null;
  tip_edit: boolean | null;
  ebt: boolean | null;
  fns_number: string | null;
  tax_calculation: boolean | null;
  tax_rate: number | null;
  refund_policy: string | null;
  print_refund_on_footer: boolean | null;
  software_pos_integration: boolean | null;
  software_name_version: string | null;
  pricing_provided: string | null;
  statement_analysis: string | null;
  receipt_header_message: string | null;
  receipt_footer_message: string | null;
  mp_ap_name: string | null;
  rp_name: string | null;
};

export type PreAppBusinessProfile = {
  id: number;
  pre_app_id: number;
  card_swiped_pct: number | null;
  card_keyed_pct: number | null;
  card_present_pct: number | null;
  card_not_present_pct: number | null;
  moto_pct: number | null;
  internet_pct: number | null;
  test_product_type: string | null;
  notes: string | null;
};

/** Columns the list page reads. Kept in one place so a test can assert the same set. */
export const PRE_APP_LIST_COLUMNS =
  "id, agent_id, lead_id, status, dba_name, legal_business_name, city, state, date_submitted, updated_at";

export type PreAppListRow = Pick<
  PreApp,
  | "id"
  | "agent_id"
  | "lead_id"
  | "status"
  | "dba_name"
  | "legal_business_name"
  | "city"
  | "state"
  | "date_submitted"
  | "updated_at"
>;

/**
 * Narrows an untrusted `?status=` value to a known filter.
 *
 * Falls back to "all" rather than passing the raw value into the query: an
 * unrecognised status returns zero rows, which reads as "you have no pre-apps"
 * instead of "that filter doesn't exist".
 */
export function parsePreAppFilter(value: string | undefined): PreAppFilter {
  return PRE_APP_FILTERS.includes(value as PreAppFilter)
    ? (value as PreAppFilter)
    : "all";
}

/**
 * The filter an admin should land on.
 *
 * Admins are the only ones who act on a submitted pre-app, so the review queue
 * is just this list with that filter pre-selected — no separate admin page to
 * keep in sync. A rep has nothing to review, so they get everything.
 */
export function defaultPreAppFilter(isAdmin: boolean): PreAppFilter {
  return isAdmin ? "submitted" : "all";
}

export function statusBadgeVariant(
  status: PreAppStatus,
): "default" | "secondary" | "destructive" | "outline" {
  if (status === "approved") return "default";
  if (status === "submitted") return "secondary";
  if (status === "declined") return "destructive";
  return "outline";
}

/**
 * Whether this viewer may still edit this pre-app.
 *
 * A rep edits drafts; an admin edits anything. This is the UI half of the rule
 * — the enforcing halves are the `pre_apps_guard_transitions` trigger and the
 * state-machine RPCs, which re-check it server-side. Hiding the Edit button is
 * a courtesy, not the boundary.
 */
export function canEditPreApp(
  status: PreAppStatus,
  isAdmin: boolean,
): boolean {
  return isAdmin || status === "draft";
}

/** The wizard's steps, in order. Each maps onto exactly one table. */
export const PRE_APP_STEPS = [
  "business",
  "owners",
  "terminal",
  "profile",
  "secrets",
] as const;

export type PreAppStep = (typeof PRE_APP_STEPS)[number];

export const PRE_APP_STEP_LABELS: Record<PreAppStep, string> = {
  business: "Business",
  owners: "Owners",
  terminal: "Terminal",
  profile: "Card mix",
  secrets: "Sensitive data",
};

/**
 * Narrows an untrusted `?step=` value.
 *
 * Same reasoning as parsePreAppFilter: an unknown step must render step one,
 * not an empty wizard.
 */
export function parsePreAppStep(value: string | undefined): PreAppStep {
  return PRE_APP_STEPS.includes(value as PreAppStep)
    ? (value as PreAppStep)
    : "business";
}

export function stepHref(preAppId: number, step: PreAppStep): string {
  return `/pre-apps/${preAppId}/edit?step=${step}`;
}

export function nextStep(step: PreAppStep): PreAppStep | null {
  const i = PRE_APP_STEPS.indexOf(step);
  return i < PRE_APP_STEPS.length - 1 ? PRE_APP_STEPS[i + 1] : null;
}

export function prevStep(step: PreAppStep): PreAppStep | null {
  const i = PRE_APP_STEPS.indexOf(step);
  return i > 0 ? PRE_APP_STEPS[i - 1] : null;
}

/**
 * The `pre_apps` columns a lead can supply, ready to write on insert.
 *
 * A pre-app started from a lead should not make the rep retype what they
 * already captured, so the overlapping columns are copied across. The two NOT
 * NULL columns come back as strings (possibly empty) because they populate the
 * create form's inputs; everything else is nullable and goes straight into the
 * insert.
 *
 * Three judgement calls, none of them obvious:
 *
 *   - **State goes through `matchState`, not `maskState`.** `leads.state` is
 *     free text, so it may hold "TN", "tn" or "Tennessee". `maskState` would
 *     truncate that last one to "TE" — two characters that look like a code and
 *     are not one, which `isState` then rejects on the business step for
 *     reasons the rep cannot see. `matchState` resolves the name properly and
 *     returns null rather than guessing.
 *   - **Phones are masked but not validated away.** A lead holding a partial
 *     number carries it across as-is. The wizard already treats a half-typed
 *     value as savable-but-not-valid, so the rep sees it and finishes it;
 *     silently dropping data they entered would be worse.
 *   - **`leads.mobile_phone` is not carried.** `pre_apps` has no column for it.
 */
export type PreAppLeadDefaults = {
  dba_name: string;
  legal_business_name: string;
} & Pick<
  PreApp,
  | "contact_name"
  | "contact_phone"
  | "physical_address"
  | "city"
  | "state"
  | "country"
  | "zip"
  | "phone_number"
  | "email_address"
>;

export function preAppDefaultsFromLead(
  lead: Pick<
    Lead,
    | "dba"
    | "merchant_legal_name"
    | "contact_name"
    | "contact_phone"
    | "business_phone"
    | "contact_email"
    | "address"
    | "city"
    | "state"
    | "country"
    | "zip"
  >,
): PreAppLeadDefaults {
  return {
    dba_name: lead.dba?.trim() ?? "",
    legal_business_name: lead.merchant_legal_name?.trim() ?? "",
    contact_name: clean(lead.contact_name),
    contact_phone: mapped(lead.contact_phone, maskPhone),
    phone_number: mapped(lead.business_phone, maskPhone),
    email_address: clean(lead.contact_email),
    physical_address: clean(lead.address),
    city: clean(lead.city),
    state: lead.state ? matchState(lead.state) : null,
    country: clean(lead.country),
    zip: mapped(lead.zip, maskZip),
  };
}

/** Trims, and treats a whitespace-only column as the empty it really is. */
function clean(value: string | null | undefined): string | null {
  const trimmed = value?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}

/** `clean`, then a mask — which must not be handed an empty string. */
function mapped(
  value: string | null | undefined,
  mask: (input: string) => string,
): string | null {
  const trimmed = clean(value);
  return trimmed === null ? null : (clean(mask(trimmed)) ?? null);
}

/**
 * The reasons this pre-app cannot be submitted yet, in plain language.
 *
 * A deliberate mirror of `submit_pre_app`'s rules, kept so the rep sees what is
 * missing before spending a round trip on it. **The RPC is the authority** —
 * this list only pre-empts it, and the submit action still shows whatever the
 * RPC says. Any rule here that the RPC does not enforce is a field the rep
 * cannot submit for no visible reason; any rule the RPC enforces that is missing
 * here is an error they cannot act on. Change the two together.
 *
 * Card mix is two independent pairs and nothing else: swiped+keyed and
 * present+not-present. moto and internet are informational — captured,
 * displayed, never constrained.
 */
export function preAppSubmitBlockers(input: {
  preApp: Pick<
    PreApp,
    "dba_name" | "legal_business_name" | "split_agent_pct" | "split_company_pct"
  >;
  owners: Pick<PreAppOwner, "percent_owned">[];
  profile: PreAppBusinessProfile | null;
  hasBankingSecrets: boolean;
  ownersMissingSsn: number;
}): string[] {
  const blockers: string[] = [];
  const { preApp, owners, profile } = input;

  if (preApp.dba_name.trim() === "") blockers.push("A DBA name is required.");
  if (preApp.legal_business_name.trim() === "") {
    blockers.push("A legal business name is required.");
  }

  if (owners.length === 0) {
    blockers.push("Add at least one owner.");
  } else if (!owners.some((o) => (o.percent_owned ?? 0) >= 51)) {
    blockers.push("One owner must hold at least 51% ownership.");
  }

  if (input.ownersMissingSsn > 0) {
    blockers.push(
      input.ownersMissingSsn === 1
        ? "One owner has no SSN on file."
        : `${input.ownersMissingSsn} owners have no SSN on file.`,
    );
  }

  if (!input.hasBankingSecrets) {
    blockers.push("Banking details have not been submitted.");
  }

  if (profile) {
    const { card_swiped_pct, card_keyed_pct } = profile;
    if (
      (card_swiped_pct !== null || card_keyed_pct !== null) &&
      (card_swiped_pct ?? 0) + (card_keyed_pct ?? 0) !== 100
    ) {
      blockers.push("Swiped and keyed percentages must total 100.");
    }
    const { card_present_pct, card_not_present_pct } = profile;
    if (
      (card_present_pct !== null || card_not_present_pct !== null) &&
      (card_present_pct ?? 0) + (card_not_present_pct ?? 0) !== 100
    ) {
      blockers.push(
        "Card-present and card-not-present percentages must total 100.",
      );
    }
  }

  if (preApp.split_agent_pct + preApp.split_company_pct !== 100) {
    blockers.push("Agent and company splits must total 100.");
  }

  return blockers;
}
