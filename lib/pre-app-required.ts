import type { PreAppStep } from "@/lib/pre-apps";

/**
 * What blocks a pre-app from being submitted: the codes of
 * `pre_app_missing_fields()` (20261028120000; memo §6).
 *
 * **The database function is the rule.** `submit_pre_app()` refuses with its
 * whole list, and the wizard's review step shows the list that same function
 * returns, so the two cannot drift. This file holds no rule of its own: it is
 * the code vocabulary (pinned to the function body by
 * tests/unit/pre-app-required.test.ts) and the paper form's wording of each
 * item, which is printed on a blank form where no function can be called.
 *
 * An owner item is reported once per owner, with `owner_id`.
 */
export const PRE_APP_REQUIRED_ITEMS = [
  { code: "dba_name", step: "business", paper: "A DBA name." },
  { code: "legal_business_name", step: "business", paper: "A legal business name." },
  { code: "contact_phone", step: "business", paper: "A contact phone." },
  { code: "physical_address", step: "business", paper: "The business street address." },
  { code: "city", step: "business", paper: "The business city." },
  { code: "state", step: "business", paper: "The business state (two letters)." },
  { code: "zip", step: "business", paper: "The business ZIP code." },
  { code: "country", step: "business", paper: "Country: United States only." },
  { code: "legal_entity_type", step: "business", paper: "The entity type." },
  { code: "state_incorporated", step: "business", paper: "The state of incorporation." },
  { code: "business_type", step: "business", paper: "The business type." },
  { code: "bank_name", step: "business", paper: "The bank name." },
  { code: "est_annual_volume", step: "business", paper: "Estimated annual volume, more than zero." },
  { code: "est_monthly_volume", step: "business", paper: "Estimated monthly volume, more than zero." },
  { code: "est_average_ticket", step: "business", paper: "Estimated average ticket, more than zero." },
  { code: "est_high_ticket", step: "business", paper: "Estimated high ticket, more than zero." },
  { code: "tax_id", step: "secrets", paper: "The tax ID, of the kind ticked under EIN type (EIN or SSN)." },
  { code: "owner_required", step: "owners", paper: "At least one owner." },
  { code: "owner_control", step: "owners", paper: "One owner holding at least 51%." },
  { code: "owner_name", step: "owners", paper: "For every owner: name," },
  { code: "owner_title", step: "owners", paper: "title," },
  { code: "owner_percent_owned", step: "owners", paper: "percent owned," },
  { code: "owner_dob", step: "owners", paper: "date of birth," },
  { code: "owner_home_phone", step: "owners", paper: "home phone," },
  { code: "owner_id_type", step: "owners", paper: "ID type," },
  { code: "owner_id_number", step: "owners", paper: "ID number," },
  { code: "owner_id_state", step: "owners", paper: "ID state," },
  { code: "owner_id_issue_date", step: "owners", paper: "ID issue date," },
  { code: "owner_id_expiration_date", step: "owners", paper: "ID expiration date," },
  { code: "owner_home_address", step: "owners", paper: "home street address," },
  { code: "owner_home_city", step: "owners", paper: "home city," },
  { code: "owner_home_state", step: "owners", paper: "home state," },
  { code: "owner_home_zip", step: "owners", paper: "home ZIP code," },
  { code: "owner_home_country", step: "owners", paper: "home country (United States only)," },
  { code: "owner_length_of_ownership", step: "owners", paper: "length of ownership," },
  { code: "owner_ssn", step: "secrets", paper: "and a social security number." },
  { code: "card_swiped_keyed_total", step: "profile", paper: "Swiped % and keyed % totalling 100, if either is filled in." },
  { code: "card_present_total", step: "profile", paper: "Card present % and card not present % totalling 100, if either is filled in." },
  { code: "banking", step: "secrets", paper: "Bank routing number and account number — both, they are stored as a pair." },
  { code: "rep_identity", step: "review", paper: "The rep's legal name and LLC legal name on their profile (an admin sets them)." },
] as const satisfies readonly { code: string; step: PreAppStep; paper: string }[];

export type PreAppMissingCode = (typeof PRE_APP_REQUIRED_ITEMS)[number]["code"];

/** One row of `pre_app_missing_fields()`. */
export type PreAppMissingItem = {
  code: PreAppMissingCode;
  step: PreAppStep;
  label: string;
  owner_id?: number;
};

/**
 * The paper form's checklist. The owner items are one sentence across several
 * entries ("For every owner: name, title, …"), so they are joined back into
 * one line here and the checklist reads as a list of things to fill in.
 */
export const PAPER_COMPLETENESS_CHECKLIST: readonly string[] = (() => {
  const lines: string[] = [];
  let ownerLine: string[] = [];
  for (const item of PRE_APP_REQUIRED_ITEMS) {
    const perOwner = item.code.startsWith("owner_") && item.code !== "owner_required" && item.code !== "owner_control";
    if (perOwner) {
      ownerLine.push(item.paper);
      continue;
    }
    if (ownerLine.length > 0) {
      lines.push(ownerLine.join(" "));
      ownerLine = [];
    }
    lines.push(item.paper);
  }
  if (ownerLine.length > 0) lines.push(ownerLine.join(" "));
  return lines;
})();

/** How many items each step has, for the wizard's step badges. */
export function missingCountByStep(
  items: readonly PreAppMissingItem[],
): Partial<Record<PreAppStep, number>> {
  const counts: Partial<Record<PreAppStep, number>> = {};
  for (const item of items) counts[item.step] = (counts[item.step] ?? 0) + 1;
  return counts;
}
