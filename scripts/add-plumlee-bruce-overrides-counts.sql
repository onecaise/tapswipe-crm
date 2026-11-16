-- After scripts/add-plumlee-bruce-overrides.sql — SUPABASE SQL EDITOR, read-only.
--
-- One row of counts; no email, id or name. Expected after a committed run:
-- plumlee_profiles 1, agent_103_profiles 1, without_live_override 0, and
-- with_103_override_from_2026_01 + with_other_live_override = plumlee_merchants
-- (the second is the merchants that already had someone else's override and
-- were skipped). audit_rows_for_103_overrides counts a 'set_merchant_override'
-- row for each of Bruce's overrides on a Plumlee merchant.

with owner_p as (
  select id from profiles where llc_legal_name = 'Plumlee LLC'
), recipient_p as (
  select id from profiles where agent_number = '103'
), pm as (
  select m.id from merchants m where m.agent_id in (select id from owner_p)
), his as (
  select o.id, o.merchant_id
    from merchant_overrides o
   where o.merchant_id in (select id from pm)
     and o.recipient_id in (select id from recipient_p)
     and o.override_pct = 5
     and o.effective_from = date '2026-01-01'
     and o.effective_to is null
)
select
  (select count(*) from owner_p)                                          as plumlee_profiles,
  (select count(*) from recipient_p)                                      as agent_103_profiles,
  (select count(*) from pm)                                               as plumlee_merchants,
  (select count(distinct merchant_id) from his)                           as with_103_override_from_2026_01,
  (select count(*) from pm
    where merchant_has_live_override(pm.id)
      and pm.id not in (select merchant_id from his))                     as with_other_live_override,
  (select count(*) from pm where not merchant_has_live_override(pm.id))   as without_live_override,
  (select count(*) from audit_log a
    where a.action = 'set_merchant_override'
      and a.table_name = 'merchant_overrides'
      and a.row_id in (select id::text from his))                         as audit_rows_for_103_overrides;
