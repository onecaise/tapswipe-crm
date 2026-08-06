import { z } from "zod";

import {
  isEin,
  isPercent,
  isPhone,
  isState,
  isZip,
} from "@/lib/masks";

/**
 * Per-step form schemas for the pre-app wizard.
 *
 * Two rules shape all of these:
 *
 * 1. **Form state is strings.** Every field is a string until it is coerced on
 *    the way to the database, matching what the existing forms in this repo do.
 *    So these are schemas over strings, and the numeric/date columns are
 *    validated by shape rather than by type.
 *
 * 2. **Almost nothing is required.** Only the two NOT NULL columns are, and
 *    those are already satisfied before the wizard opens. A schema that refused
 *    an incomplete section would defeat autosave, whose whole job is to persist
 *    a half-finished form. Completeness is `submit_pre_app`'s business, checked
 *    server-side at submission; these schemas only decide whether a *format* is
 *    finished enough to leave the step.
 *
 * The predicates come from lib/masks.ts so the validator and the formatter for a
 * field can never disagree — and each accepts "", which is what lets a
 * half-typed value be saved while still blocking Next.
 */

/** A masked text field: valid when empty or fully formed. */
const masked = (predicate: (value: string) => boolean, message: string) =>
  z.string().refine(predicate, { message });

/** Free text, trimmed on the way out, with a sane ceiling. */
const text = z.string().trim().max(500, "Too long");

/**
 * Email and URL are checked with regexes rather than Zod's built-ins purely to
 * avoid coupling to a specific Zod major — the built-ins moved between v3 and
 * v4. These are deliberately permissive: rejecting an address a rep knows is
 * right is worse than accepting one the processor will bounce.
 */
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const looksLikeUrl = (value: string) =>
  value === "" || /^https?:\/\/\S+$/i.test(value);

/** A native <input type="date"> emits "" or a complete YYYY-MM-DD. */
const isoDate = z
  .string()
  .refine((v) => v === "" || /^\d{4}-\d{2}-\d{2}$/.test(v), {
    message: "Use the date picker",
  });

/**
 * The sentinel a nullable enum uses for "not set".
 *
 * A `<select>` cannot hold null, and an empty-string option is indistinguishable
 * from "no option chosen" in some browsers, so the absent case gets an explicit
 * value that the coercion layer maps back to null.
 */
export const UNSET = "__unset__";

export const businessStepSchema = z.object({
  // The two NOT NULL columns. Required here as well so clearing one is caught
  // in the field rather than as a 23502 from PostgREST.
  dba_name: z.string().trim().min(1, "A DBA name is required"),
  legal_business_name: z
    .string()
    .trim()
    .min(1, "A legal business name is required"),

  contact_name: text,
  contact_phone: masked(isPhone, "Use 615-555-1234"),
  phone_number: masked(isPhone, "Use 615-555-1234"),
  fax_number: masked(isPhone, "Use 615-555-1234"),
  email_address: z
    .string()
    .trim()
    .refine((v) => v === "" || EMAIL.test(v), { message: "Not a valid email" }),
  website: z
    .string()
    .trim()
    .refine(looksLikeUrl, { message: "Include http:// or https://" }),

  physical_address: text,
  city: text,
  state: masked(isState, "Pick a state from the list"),
  country: text,
  zip: masked(isZip, "12345 or 12345-6789"),

  state_incorporated: masked(isState, "Pick a state from the list"),
  legal_entity_type: text,
  business_type: text,
  sub_business_type: text,
  business_start_date: isoDate,
  ein_type: text,
  ein_number: masked(isEin, "Use 12-3456789"),
  goods_sold: text,

  billing_type: z.union([z.literal(UNSET), z.enum(["gross", "net"])]),
  bank_name: text,

  /**
   * Only the agent's share is entered; the company's is derived as 100 minus
   * it and the two are written together.
   *
   * That is not cosmetic. `pre_apps_split_sums_to_100` is a table check, so
   * saving one column on its own — which is exactly what a dirty-field autosave
   * would do — raises 23514 the moment the pair stops totalling 100. Deriving
   * the other half makes an invalid intermediate state unreachable rather than
   * merely unlikely.
   */
  split_agent_pct: masked(isPercent, "0 to 100"),
});

export type BusinessStepValues = z.infer<typeof businessStepSchema>;

export const BUSINESS_STEP_FIELDS = Object.keys(
  businessStepSchema.shape,
) as (keyof BusinessStepValues)[];

/** Options for the billing_type select, including the absent case. */
export const BILLING_TYPE_OPTIONS = [
  { value: UNSET, label: "—" },
  { value: "gross", label: "Gross" },
  { value: "net", label: "Net" },
] as const;

/**
 * Common legal entity types. Free text in the schema, so this is a convenience
 * list rather than a constraint — the input accepts anything.
 */
export const LEGAL_ENTITY_TYPES = [
  "Sole proprietorship",
  "LLC",
  "Corporation",
  "Partnership",
  "Non-profit",
] as const;

/* ---------------------------------------------------------------------------
 * Owners
 * ------------------------------------------------------------------------- */

/**
 * One owner row.
 *
 * The primary key is called `rowId`, not `id`, deliberately. `useFieldArray`
 * appends its own `id` to every entry of `fields` for use as a React key, so a
 * field literally named `id` would be shadowed — and `.eq("id", field.id)` would
 * then target RHF's generated string instead of the `pre_app_owners` row.
 */
export const ownerRowSchema = z.object({
  rowId: z.number(),
  owner_name: text,
  title: text,
  id_type: text,
  id_number: text,
  id_issue_date: isoDate,
  id_expiration_date: isoDate,
  id_state: masked(isState, "Pick a state from the list"),
  dob: isoDate,
  home_phone: masked(isPhone, "Use 615-555-1234"),
  percent_owned: masked(isPercent, "0 to 100"),
  length_of_ownership: text,
  home_address: text,
  home_city: text,
  home_state: masked(isState, "Pick a state from the list"),
  home_country: text,
  home_zip: masked(isZip, "12345 or 12345-6789"),
});

export const ownersStepSchema = z.object({
  owners: z.array(ownerRowSchema),
});

export type OwnerRowValues = z.infer<typeof ownerRowSchema>;
export type OwnersStepValues = z.infer<typeof ownersStepSchema>;

/* ---------------------------------------------------------------------------
 * Terminal
 * ------------------------------------------------------------------------- */

/** numeric(5,3), so three decimals rather than the usual two. */
const taxRate = z
  .string()
  .refine(
    (v) =>
      v === "" ||
      (/^\d{1,3}(\.\d{1,3})?$/.test(v) && Number(v) >= 0 && Number(v) <= 100),
    { message: "0 to 100" },
  );

/** A native <input type="time"> emits "" or HH:MM. */
const clockTime = z
  .string()
  .refine((v) => v === "" || /^\d{2}:\d{2}(:\d{2})?$/.test(v), {
    message: "Use the time picker",
  });

/**
 * The eleven boolean columns.
 *
 * Modelled as plain booleans, so an unchecked box writes `false` rather than
 * leaving NULL. The columns are nullable and have no default, so the database
 * can still distinguish "never answered" — a row loaded with NULL shows as
 * unchecked and stays NULL until the rep actually touches it, because autosave
 * only ever sends dirty fields.
 */
export const TERMINAL_BOOLEANS = [
  ["auto_batch", "Auto batch"],
  ["dial_9_outside", "Dial 9 for outside line"],
  ["reprogram_terminal", "Reprogram existing terminal"],
  ["equipment_purchase", "Equipment purchase"],
  ["equipment_rental", "Equipment rental"],
  ["next_day_funding", "Next-day funding"],
  ["tip_edit", "Tip edit"],
  ["ebt", "EBT"],
  ["tax_calculation", "Tax calculation"],
  ["print_refund_on_footer", "Print refund policy on receipt"],
  ["software_pos_integration", "Software / POS integration"],
] as const;

export const terminalStepSchema = z.object({
  batch_out_time: clockTime,
  terminal_type: text,
  communication_method: text,
  fns_number: text,
  tax_rate: taxRate,
  refund_policy: text,
  software_name_version: text,
  pricing_provided: text,
  statement_analysis: text,
  receipt_header_message: text,
  receipt_footer_message: text,
  mp_ap_name: text,
  rp_name: text,
  auto_batch: z.boolean(),
  dial_9_outside: z.boolean(),
  reprogram_terminal: z.boolean(),
  equipment_purchase: z.boolean(),
  equipment_rental: z.boolean(),
  next_day_funding: z.boolean(),
  tip_edit: z.boolean(),
  ebt: z.boolean(),
  tax_calculation: z.boolean(),
  print_refund_on_footer: z.boolean(),
  software_pos_integration: z.boolean(),
});

export type TerminalStepValues = z.infer<typeof terminalStepSchema>;

/* ---------------------------------------------------------------------------
 * Card mix
 * ------------------------------------------------------------------------- */

/**
 * Per-field format only. The two pair totals are NOT enforced here: they are a
 * submission rule, not a formatting one, so a draft with 60/30 has to remain
 * saveable while still being flagged. `preAppSubmitBlockers` and
 * `submit_pre_app` are where the pairs are checked.
 */
export const profileStepSchema = z.object({
  card_swiped_pct: masked(isPercent, "0 to 100"),
  card_keyed_pct: masked(isPercent, "0 to 100"),
  card_present_pct: masked(isPercent, "0 to 100"),
  card_not_present_pct: masked(isPercent, "0 to 100"),
  moto_pct: masked(isPercent, "0 to 100"),
  internet_pct: masked(isPercent, "0 to 100"),
  test_product_type: text,
  notes: z.string().max(4000, "Too long"),
});

export type ProfileStepValues = z.infer<typeof profileStepSchema>;
