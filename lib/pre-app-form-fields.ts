import {
  type PreApp,
  type PreAppBusinessProfile,
  type PreAppOwner,
  type PreAppTerminal,
} from "@/lib/pre-apps";

/**
 * The pre-app application as a list of fields, for the printable blank form.
 *
 * This exists because a paper form that asks for less than the wizard does
 * loses data at the transcription step, silently — the rep types in what the
 * merchant wrote, and nobody notices the three questions the paper never asked.
 *
 * So the completeness of this file is the whole point, and it is enforced by
 * the COMPILER rather than by care: each section below is
 * `satisfies Record<…Key, PaperField>` over the real row type, where the Key
 * excludes only the columns a person never fills in (ids, timestamps, workflow
 * status, and the derived company split). Add a column to `pre_apps` and give
 * the wizard an input for it, and this file stops compiling until the paper
 * form has it too. That is the same mechanism that caught two real omissions in
 * e2e/fixtures/seed.ts, where `satisfies Record<PersonaKey, …>` refused to
 * build until both were filled in.
 *
 * What it deliberately does NOT do is drive the wizard. The five step
 * components have bespoke layouts, masks, autosave and validation; rewriting
 * them to render from here would be a large change to working code for the
 * benefit of a printout. The labels are therefore copied, and the copy is what
 * the type-level check above pins.
 *
 * Secrets are listed too (SSN, routing, account, RP password) because the paper
 * form is where a merchant writes them down — but they are kept in their own
 * section, as they are in their own tables, and nothing here reads, decrypts or
 * transmits anything.
 */

export type PaperFieldKind =
  /** One short line. */
  | "text"
  /** Several lines — free prose rather than a value. */
  | "long"
  | "date"
  | "time"
  | "percent"
  /** A tick box rather than a writing space. */
  | "checkbox"
  /** Two-letter state code; the form prints a hint rather than 51 options. */
  | "state"
  /** A fixed set, printed as tick boxes so there is nothing to mis-transcribe. */
  | "select";

export type PaperField = {
  /** Verbatim from the wizard step, so paper and screen ask the same question. */
  label: string;
  kind: PaperFieldKind;
  /** The fieldset this field prints under, matching the wizard's legends. */
  group: string;
  /** Only two fields in the whole application are required at entry. */
  required?: boolean;
  /** Format guidance the wizard enforces with a mask and paper cannot. */
  hint?: string;
  /** For `select`, the options a reader may tick. */
  options?: readonly string[];
};

/** A field with the column name it was declared under. */
export type PaperFieldEntry = PaperField & { key: string };

/* ---------------------------------------------------------------------------
 * Business — writes to `pre_apps`
 * ------------------------------------------------------------------------- */

/**
 * `split_company_pct` is excluded on purpose: the wizard derives it as
 * 100 minus the agent split and shows it read-only, so it is not a question to
 * ask on paper.
 */
type PaperBusinessKey = Exclude<
  keyof PreApp,
  | "id"
  | "agent_id"
  | "lead_id"
  | "status"
  | "date_submitted"
  | "decline_reason"
  | "created_at"
  | "updated_at"
  | "split_company_pct"
>;

const BUSINESS_FIELDS = {
  dba_name: { label: "DBA name", kind: "text", group: "Business", required: true },
  legal_business_name: {
    label: "Legal business name",
    kind: "text",
    group: "Business",
    required: true,
  },
  contact_name: { label: "Contact name", kind: "text", group: "Business" },
  contact_phone: {
    label: "Contact phone",
    kind: "text",
    group: "Business",
    hint: "615-555-1234",
  },
  phone_number: {
    label: "Business phone",
    kind: "text",
    group: "Business",
    hint: "615-555-1234",
  },
  fax_number: {
    label: "Fax",
    kind: "text",
    group: "Business",
    hint: "615-555-1234",
  },
  email_address: { label: "Email", kind: "text", group: "Business" },
  website: {
    label: "Website",
    kind: "text",
    group: "Business",
    hint: "include http:// or https://",
  },

  physical_address: { label: "Street address", kind: "text", group: "Address" },
  city: { label: "City", kind: "text", group: "Address" },
  state: { label: "State", kind: "state", group: "Address" },
  zip: {
    label: "ZIP",
    kind: "text",
    group: "Address",
    hint: "12345 or 12345-6789",
  },
  country: { label: "Country", kind: "text", group: "Address" },

  legal_entity_type: {
    label: "Entity type",
    kind: "select",
    group: "Business type",
    // Free text in the schema, so the paper form prints the common answers as
    // ticks but leaves room to write something else.
    options: [
      "Sole proprietorship",
      "LLC",
      "Corporation",
      "Partnership",
      "Non-profit",
    ],
  },
  state_incorporated: {
    label: "State incorporated",
    kind: "state",
    group: "Business type",
  },
  business_type: { label: "Business type", kind: "text", group: "Business type" },
  sub_business_type: { label: "Sub type", kind: "text", group: "Business type" },
  business_start_date: {
    label: "Business start date",
    kind: "date",
    group: "Business type",
  },
  ein_type: { label: "EIN type", kind: "text", group: "Business type" },
  ein_number: {
    label: "EIN",
    kind: "text",
    group: "Business type",
    hint: "12-3456789",
  },
  goods_sold: {
    label: "Goods or services sold",
    kind: "long",
    group: "Business type",
  },

  bank_name: { label: "Bank name", kind: "text", group: "Banking and split" },
  billing_type: {
    label: "Billing type",
    kind: "select",
    group: "Banking and split",
    options: ["Gross", "Net"],
  },
  split_agent_pct: {
    label: "Agent split %",
    kind: "percent",
    group: "Banking and split",
    hint: "the company split is 100 minus this",
  },
} satisfies Record<PaperBusinessKey, PaperField>;

/* ---------------------------------------------------------------------------
 * Owners — writes to `pre_app_owners`, one row per owner
 * ------------------------------------------------------------------------- */

type PaperOwnerKey = Exclude<keyof PreAppOwner, "id" | "pre_app_id">;

const OWNER_FIELDS = {
  owner_name: { label: "Name", kind: "text", group: "Owner" },
  title: { label: "Title", kind: "text", group: "Owner" },
  percent_owned: { label: "Ownership %", kind: "percent", group: "Owner" },
  home_phone: {
    label: "Home phone",
    kind: "text",
    group: "Owner",
    hint: "615-555-1234",
  },
  dob: { label: "Date of birth", kind: "date", group: "Owner" },
  length_of_ownership: {
    label: "Ownership length",
    kind: "text",
    group: "Owner",
  },

  id_type: { label: "ID type", kind: "text", group: "Identification" },
  id_number: { label: "ID number", kind: "text", group: "Identification" },
  id_state: { label: "ID state", kind: "state", group: "Identification" },
  id_issue_date: { label: "ID issued", kind: "date", group: "Identification" },
  id_expiration_date: {
    label: "ID expires",
    kind: "date",
    group: "Identification",
  },

  home_address: { label: "Home address", kind: "text", group: "Home address" },
  home_city: { label: "Home city", kind: "text", group: "Home address" },
  home_state: { label: "Home state", kind: "state", group: "Home address" },
  home_zip: {
    label: "Home ZIP",
    kind: "text",
    group: "Home address",
    hint: "12345 or 12345-6789",
  },
  home_country: { label: "Home country", kind: "text", group: "Home address" },
} satisfies Record<PaperOwnerKey, PaperField>;

/* ---------------------------------------------------------------------------
 * Terminal — writes to `pre_app_terminal`
 * ------------------------------------------------------------------------- */

type PaperTerminalKey = Exclude<keyof PreAppTerminal, "id" | "pre_app_id">;

const TERMINAL_FIELDS = {
  terminal_type: { label: "Terminal type", kind: "text", group: "Terminal" },
  communication_method: {
    label: "Communication method",
    kind: "text",
    group: "Terminal",
  },
  batch_out_time: { label: "Batch-out time", kind: "time", group: "Terminal" },
  fns_number: { label: "FNS number", kind: "text", group: "Terminal" },
  tax_rate: { label: "Tax rate %", kind: "percent", group: "Terminal" },
  software_name_version: {
    label: "Software name / version",
    kind: "text",
    group: "Terminal",
  },

  auto_batch: { label: "Auto batch", kind: "checkbox", group: "Options" },
  dial_9_outside: {
    label: "Dial 9 for outside line",
    kind: "checkbox",
    group: "Options",
  },
  reprogram_terminal: {
    label: "Reprogram existing terminal",
    kind: "checkbox",
    group: "Options",
  },
  equipment_purchase: {
    label: "Equipment purchase",
    kind: "checkbox",
    group: "Options",
  },
  equipment_rental: {
    label: "Equipment rental",
    kind: "checkbox",
    group: "Options",
  },
  next_day_funding: {
    label: "Next-day funding",
    kind: "checkbox",
    group: "Options",
  },
  tip_edit: { label: "Tip edit", kind: "checkbox", group: "Options" },
  ebt: { label: "EBT", kind: "checkbox", group: "Options" },
  tax_calculation: {
    label: "Tax calculation",
    kind: "checkbox",
    group: "Options",
  },
  print_refund_on_footer: {
    label: "Print refund policy on receipt",
    kind: "checkbox",
    group: "Options",
  },
  software_pos_integration: {
    label: "Software / POS integration",
    kind: "checkbox",
    group: "Options",
  },

  refund_policy: {
    label: "Refund policy",
    kind: "long",
    group: "Receipts and paperwork",
  },
  receipt_header_message: {
    label: "Receipt header",
    kind: "text",
    group: "Receipts and paperwork",
  },
  receipt_footer_message: {
    label: "Receipt footer",
    kind: "text",
    group: "Receipts and paperwork",
  },
  pricing_provided: {
    label: "Pricing provided",
    kind: "text",
    group: "Receipts and paperwork",
  },
  statement_analysis: {
    label: "Statement analysis",
    kind: "text",
    group: "Receipts and paperwork",
  },
  mp_ap_name: {
    label: "MP/AP name",
    kind: "text",
    group: "Receipts and paperwork",
  },
  rp_name: { label: "RP name", kind: "text", group: "Receipts and paperwork" },
} satisfies Record<PaperTerminalKey, PaperField>;

/* ---------------------------------------------------------------------------
 * Card mix — writes to `pre_app_business_profile`
 * ------------------------------------------------------------------------- */

type PaperProfileKey = Exclude<keyof PreAppBusinessProfile, "id" | "pre_app_id">;

const READ_GROUP = "How the card is read — must total 100";
const PRESENT_GROUP = "Whether the card is present — must total 100";
const BREAKDOWN_GROUP = "Breakdown — informational";

const PROFILE_FIELDS = {
  card_swiped_pct: { label: "Swiped %", kind: "percent", group: READ_GROUP },
  card_keyed_pct: { label: "Keyed %", kind: "percent", group: READ_GROUP },

  card_present_pct: {
    label: "Card present %",
    kind: "percent",
    group: PRESENT_GROUP,
  },
  card_not_present_pct: {
    label: "Card not present %",
    kind: "percent",
    group: PRESENT_GROUP,
  },

  moto_pct: { label: "MOTO %", kind: "percent", group: BREAKDOWN_GROUP },
  internet_pct: { label: "Internet %", kind: "percent", group: BREAKDOWN_GROUP },
  test_product_type: {
    label: "Test product type",
    kind: "text",
    group: BREAKDOWN_GROUP,
  },

  notes: { label: "Notes", kind: "long", group: "Notes" },
} satisfies Record<PaperProfileKey, PaperField>;

/* ---------------------------------------------------------------------------
 * Sensitive data — the three *_secrets tables
 * ------------------------------------------------------------------------- */

/**
 * Not checked against a row type: these columns are `bytea` ciphertext, so
 * there is no plaintext shape to satisfy. The SSN is per owner and prints
 * inside each owner block instead of here.
 */
export const SECRET_FIELDS: readonly PaperFieldEntry[] = [
  {
    key: "aba_routing",
    label: "ABA routing number",
    kind: "text",
    group: "Banking",
    hint: "nine digits",
  },
  {
    key: "account_number",
    label: "Account number",
    kind: "text",
    group: "Banking",
    hint: "4 to 17 digits",
  },
  { key: "rp_password", label: "RP password", kind: "text", group: "Terminal" },
] as const;

/** Printed inside each owner block, because an SSN belongs to an owner. */
export const OWNER_SSN_FIELD: PaperFieldEntry = {
  key: "ssn",
  label: "Social security number",
  kind: "text",
  group: "Owner",
  hint: "123-45-6789",
};

/* ---------------------------------------------------------------------------
 * Grouping
 * ------------------------------------------------------------------------- */

export type PaperGroup = {
  title: string;
  fields: PaperFieldEntry[];
};

/**
 * Splits a section's fields into its printed groups, preserving declaration
 * order — which is the order the wizard asks them in, and therefore the order
 * whoever transcribes the paper will be typing them.
 */
function groupsOf(fields: Record<string, PaperField>): PaperGroup[] {
  const groups: PaperGroup[] = [];

  for (const [key, field] of Object.entries(fields)) {
    const entry: PaperFieldEntry = { ...field, key };
    const existing = groups.find((group) => group.title === field.group);

    if (existing === undefined) {
      groups.push({ title: field.group, fields: [entry] });
    } else {
      existing.fields.push(entry);
    }
  }

  return groups;
}

export type PaperSection = {
  /** Matches the wizard's step label, so "where does this go" is obvious. */
  title: string;
  groups: PaperGroup[];
};

export const BUSINESS_SECTION: PaperSection = {
  title: "Business",
  groups: groupsOf(BUSINESS_FIELDS),
};

export const OWNER_SECTION: PaperSection = {
  title: "Owner",
  groups: groupsOf(OWNER_FIELDS),
};

export const TERMINAL_SECTION: PaperSection = {
  title: "Terminal",
  groups: groupsOf(TERMINAL_FIELDS),
};

export const PROFILE_SECTION: PaperSection = {
  title: "Card mix",
  groups: groupsOf(PROFILE_FIELDS),
};

/**
 * How many blank owner blocks the paper form prints.
 *
 * The schema has no upper bound and the wizard lets a rep add rows freely, but
 * paper has to commit to a number. Two covers the ordinary case without adding
 * two mostly-empty pages to every print; the form carries a line telling the
 * reader to attach another sheet beyond that.
 */
export const PAPER_OWNER_BLOCKS = 2;

/**
 * The submission blockers, copied from `preAppBlockers()` in lib/pre-apps.ts.
 *
 * Only `dba_name` and `legal_business_name` are required to *save* a draft, so
 * "which boxes must be filled in" is not answerable from the field list alone —
 * this is the real completeness test, and the paper form prints it as a
 * checklist so a rep can tell before leaving whether the form is finished.
 */
export const PAPER_COMPLETENESS_CHECKLIST: readonly string[] = [
  "A DBA name.",
  "A legal business name.",
  "At least one owner.",
  "One owner holding at least 51%.",
  "A social security number for every owner listed.",
  "Bank routing number and account number — both, they are stored as a pair.",
  "Swiped % and keyed % totalling 100, if either is filled in.",
  "Card present % and card not present % totalling 100, if either is filled in.",
  "An agent split; the company split is whatever is left of 100.",
] as const;
