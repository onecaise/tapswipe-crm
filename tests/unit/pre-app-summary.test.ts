import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PreAppSummary } from "@/components/pre-app-summary";
import { formatDate, formatDateTime, formatMoney, formatPct } from "@/lib/format";
import type {
  PreApp,
  PreAppBusinessProfile,
  PreAppOwner,
  PreAppTerminal,
} from "@/lib/pre-apps";
import { TERMINAL_BOOLEANS } from "@/lib/pre-app-validation";

/**
 * Phase 5 (docs/design/intake-and-reports.md §1.E): "PreAppSummary shows every
 * stored field to both roles." The only things it never shows are the
 * encrypted secrets, which live in other tables and reach the detail page
 * masked, client-side (components/pre-app-sensitive-data.tsx).
 *
 * Each fixture is typed `satisfies <RowType>`, so adding a column to a row type
 * fails to compile here until the fixture names it, and then this test fails
 * until the summary renders it, unless it is listed in NOT_RENDERED with its
 * reason.
 */

/** Columns deliberately not printed as a field, each with the reason. */
const NOT_RENDERED: Record<string, string> = {
  id: "the record's own key",
  agent_id: "shown as the Agent name, to an admin",
  pre_app_id: "the parent key on a child row",
  status: "the page's badge, not a field",
  decline_reason: "the page's Declined callout, not a field",
};

const preApp = {
  id: 41,
  agent_id: "22222222-2222-2222-2222-222222222222",
  lead_id: 7,
  status: "submitted",
  date_submitted: "2026-10-20T15:04:00Z",
  decline_reason: null,
  dba_name: "dba-v1",
  legal_business_name: "legal-v2",
  contact_name: "contact-v3",
  contact_phone: "615-555-0103",
  physical_address: "addr-v4",
  city: "city-v5",
  state: "TN",
  country: "US",
  zip: "37201",
  phone_number: "615-555-0106",
  fax_number: "615-555-0107",
  email_address: "mail-v8@example.test",
  website: "site-v9.example.test",
  state_incorporated: "DE",
  legal_entity_type: "entity-v10",
  business_type: "btype-v11",
  sub_business_type: "subtype-v12",
  business_start_date: "2015-03-04",
  ein_type: "EIN",
  goods_sold: "goods-v13",
  billing_type: "net",
  bank_name: "bank-v14",
  processor: "Square",
  est_annual_volume: 1234567,
  est_monthly_volume: 98765,
  est_average_ticket: 43,
  est_high_ticket: 987,
  split_agent_pct: 46.5,
  split_company_pct: 53.5,
  rep_legal_name: "replegal-v15",
  rep_llc_legal_name: "repllc-v16",
  created_at: "2026-10-01T09:30:00Z",
  updated_at: "2026-10-21T18:45:00Z",
} satisfies PreApp;

const owner = {
  id: 5,
  pre_app_id: 41,
  owner_name: "owner-v20",
  title: "title-v21",
  id_type: "idtype-v22",
  id_number: "idnum-v23",
  id_issue_date: "2019-05-06",
  id_expiration_date: "2029-07-08",
  id_state: "KY",
  dob: "1980-01-02",
  home_phone: "615-555-0124",
  percent_owned: 75,
  length_of_ownership: "tenure-v25",
  home_address: "homeaddr-v26",
  home_city: "homecity-v27",
  home_state: "GA",
  home_country: "US",
  home_zip: "30301",
} satisfies PreAppOwner;

const terminal = {
  id: 9,
  pre_app_id: 41,
  batch_out_time: "23:15:00",
  terminal_type: "term-v30",
  auto_batch: true,
  communication_method: "comm-v31",
  dial_9_outside: true,
  reprogram_terminal: true,
  equipment_purchase: true,
  equipment_rental: true,
  next_day_funding: true,
  tip_edit: true,
  ebt: true,
  fns_number: "fns-v32",
  tax_calculation: true,
  tax_rate: 9.25,
  refund_policy: "refund-v33",
  print_refund_on_footer: true,
  software_pos_integration: true,
  software_name_version: "sw-v34",
  pricing_provided: "pricing-v35",
  statement_analysis: "analysis-v36",
  receipt_header_message: "header-v37",
  receipt_footer_message: "footer-v38",
  mp_ap_name: "mpap-v39",
  rp_name: "rp-v40",
} satisfies PreAppTerminal;

const cardMix = {
  id: 3,
  pre_app_id: 41,
  card_swiped_pct: 11,
  card_keyed_pct: 12,
  card_present_pct: 13,
  card_not_present_pct: 14,
  moto_pct: 15,
  internet_pct: 16,
  test_product_type: "testprod-v50",
  notes: "notes-v51",
} satisfies PreAppBusinessProfile;

const html = renderToStaticMarkup(
  createElement(PreAppSummary, {
    preApp,
    owners: [owner],
    terminal,
    cardMix,
    agentName: "agent-name-v60",
  }),
).replace(/&amp;/g, "&");

/** How the summary prints a value of this column. */
function expected(column: string, value: unknown): string[] {
  if (typeof value === "boolean") return [];
  if (column.endsWith("_pct") || column === "tax_rate" || column === "percent_owned") {
    return [formatPct(value as number)];
  }
  if (column.startsWith("est_")) return [formatMoney(value as number)];
  if (column === "created_at" || column === "updated_at" || column === "date_submitted") {
    return [formatDateTime(value as string)];
  }
  if (/_date$|^dob$/.test(column)) return [formatDate(value as string)];
  if (column === "batch_out_time") return ["11:15"];
  if (column === "lead_id") return [`#${value}`];
  return [String(value)];
}

describe("PreAppSummary shows every stored field", () => {
  const rowsByName = { pre_apps: preApp, pre_app_owners: owner, pre_app_terminal: terminal, pre_app_business_profile: cardMix };

  for (const [table, row] of Object.entries(rowsByName)) {
    for (const [column, value] of Object.entries(row)) {
      if (column in NOT_RENDERED || value === null) continue;
      it(`${table}.${column}`, () => {
        for (const text of expected(column, value)) expect(html).toContain(text);
      });
    }
  }

  it("lists every terminal option that is set, by its form label", () => {
    for (const [, label] of TERMINAL_BOOLEANS) expect(html).toContain(label);
  });

  it("names the agent when given one", () => {
    expect(html).toContain("agent-name-v60");
  });

  it("shows the EIN type and nothing that could be a secret", () => {
    expect(html).toContain(">EIN<");
    expect(html).not.toMatch(/\b\d{3}-\d{2}-\d{4}\b/);
    expect(html).not.toMatch(/\b\d{2}-\d{7}\b/);
    expect(html).not.toMatch(/routing|account number|password|ssn/i);
  });
});
