-- pre_apps sales volume, so an application says how much the merchant expects
-- to process and not only how they process it.
--
-- The wizard has always captured the card MIX -- swiped vs keyed, present vs
-- not-present -- on pre_app_business_profile, and never once asked for an
-- amount. A repo-wide grep for est_annual_volume / monthly volume / annual
-- volume / high ticket / sales volume before this migration returned nothing
-- at all, and neither did visa / mastercard / amex. Underwriting and pricing
-- both need these figures, so reps have been collecting them out-of-band and
-- the application has been silent about them.
--
-- Seven columns, all optional and all independent. No cross-field rule is
-- enforced -- not high >= average, not the four brand figures summing to
-- anything. They are estimates given in conversation, and a constraint that
-- rejected an inconsistent set would block honestly-filled applications.
--
-- `est_` prefixed on purpose. rep_payout_rows.average_ticket already exists
-- and means the opposite kind of thing: an ACTUAL figure for one merchant in
-- one period, read off the processor's residual report. A bare average_ticket
-- on pre_apps would read as the same fact as that one, and it is not.
--
-- numeric(14,2) matches rep_payout_rows so an estimate and an actual compare
-- without a cast. Non-negative because a negative here is a typo and nothing
-- else -- unlike total_cost / residual_income there, which are signed
-- deliberately because clawbacks make a negative month real.
--
-- Nullable with no default and no backfill, and staying that way. NULL means
-- "not asked", which is the honest state of every pre-app that predates this,
-- and there is nothing anywhere to backfill it from. Zero would be a claim
-- the merchant never made.
--
-- Matches docs/tapswipe_crm_schema.sql, updated first.

alter table pre_apps
  add column if not exists est_annual_volume      numeric(14,2),
  add column if not exists est_monthly_visa       numeric(14,2),
  add column if not exists est_monthly_mastercard numeric(14,2),
  add column if not exists est_monthly_discover   numeric(14,2),
  add column if not exists est_monthly_amex       numeric(14,2),
  add column if not exists est_average_ticket     numeric(14,2),
  add column if not exists est_high_ticket        numeric(14,2);

-- Added VALID rather than NOT VALID, which is the opposite of what
-- merchants_split_totals_100 had to do. That one could not check existing rows
-- because nobody could say whether a 60/45 split was a typo or a real deal.
-- Here every existing row holds NULL, NULL passes a CHECK, and so there is no
-- legacy data to exempt and nothing to decide later. A `validate constraint`
-- follow-up would have nothing to do.
--
-- Named rather than inline so a test can match on the name and say which
-- column it caught, rather than matching a generic /check|violates/.
alter table pre_apps
  add constraint pre_apps_est_annual_volume_non_negative
    check (est_annual_volume >= 0),
  add constraint pre_apps_est_monthly_visa_non_negative
    check (est_monthly_visa >= 0),
  add constraint pre_apps_est_monthly_mastercard_non_negative
    check (est_monthly_mastercard >= 0),
  add constraint pre_apps_est_monthly_discover_non_negative
    check (est_monthly_discover >= 0),
  add constraint pre_apps_est_monthly_amex_non_negative
    check (est_monthly_amex >= 0),
  add constraint pre_apps_est_average_ticket_non_negative
    check (est_average_ticket >= 0),
  add constraint pre_apps_est_high_ticket_non_negative
    check (est_high_ticket >= 0);

-- No grant change, and no policy change. pre_apps already grants select,
-- insert, update and delete to authenticated, and the four policies are
-- untouched, so a rep still sees only their own applications and an admin sees
-- the company's -- the same boundary that already governed dba_name and
-- split_agent_pct. These columns carry no new privilege, only values that were
-- previously unrecordable. Same reasoning as
-- 20260813171344_profiles_email.sql and 20260817101500_agent_number.sql.
--
-- The CHECKs are the load-bearing validation layer here, not a formality.
-- These are plain columns written straight from the browser by supabase-js --
-- no Edge Function sits in that path -- and hooks/use-autosave.ts is
-- deliberately validity-blind, so it PATCHes whatever is in the field
-- regardless of what the client-side zod schema thinks. The zod rule in
-- lib/pre-app-validation.ts only decides whether the rep may leave the step.
-- Postgres is the only layer that cannot be skipped.
