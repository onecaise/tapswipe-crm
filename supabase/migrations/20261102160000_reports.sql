-- The two admin reports behind /admin/reports: rep_payout_summary() and
-- merchant_processor_summary(), read-only, over the committed ledger. Phase 12
-- of docs/design/intake-and-reports.md.
--
-- Matches docs/tapswipe_crm_schema.sql, updated first; the block below is
-- copied from it verbatim.
--
-- =====================================================================
-- REPORTS (20261102160000) — phase 12 of docs/design/intake-and-reports.md
-- (§7.2, §4.5, §0b.7, §0c.1, A4d, A17, A18).
--
-- Two read functions behind /admin/reports. Both read ONLY the committed
-- ledger: rep_payout_rows lines whose batch is `committed` (an import or an
-- override line), plus adjustment lines (which carry no batch). A line whose
-- batch is in review, abandoned, replaced or deleted is never counted, and
-- neither is an import or override line with no batch at all. They sum the
-- ledger's own generated rep_payout; there is no second copy of the payout
-- arithmetic here, so a report cannot disagree with a statement.
--
-- SECURITY INVOKER (§7.2; tests assert prosecdef = false), so RLS scopes every
-- row they read, and is_admin() first: a rep is refused (PT403) rather than
-- shown their own rows. Every table read is admin-SELECT or own-or-admin, so
-- the refusal is a second boundary, not the only one. search_path pinned.
-- Each has its own revoke/grant lines; anon has no EXECUTE.
--
-- Months are first-of-month dates, from <= to (22023 otherwise). A processor
-- of NULL means every processor. Under a processor, an adjustment counts only
-- when it carries that processor: a share correction carries none, so it shows
-- under "all processors" only.
--
-- 1. rep_payout_summary(from, to, processor) — Report 1, Owen's columns
--    (§0b.7), one row per rep per month (row_kind 'rep'), a total per month
--    ('month') and a grand total ('total'), by GROUPING SETS:
--      sales_volume       sum(volume) on import lines; a shared account's
--                         volume is on the signer's line only (A18)
--      net_residual       sum(residual_income) on import lines (a shared line
--                         holds the rep's piece)
--      agent_split        sum(rep_payout) on import lines + the rep's override
--                         DEBITS (negative): what they keep of their own
--                         merchants (§4.5). Each line used its merchant's rate
--                         at commit (rep_split_pct); profiles.split_rate_pct is
--                         never read.
--      deductions         sum(rep_payout) on adjustment lines posted in the
--                         month. INFORMATION ONLY, NOT in the total (§0c.1).
--      overrides_received sum(override_amount) on the rep's CREDIT lines (A4d)
--      total_commission   agent_split + overrides_received (§0b.7). So
--                         total_commission + deductions = sum(rep_payout) over
--                         every line the rep has in the month: the statement.
--    agent_code is profiles.agent_number; legal_name is the LLC legal name,
--    or the rep's own legal name when there is none (A17); full_name as is.
--    The house profile (rate 0) appears with its volume and net and a zero
--    split.
--
-- 2. merchant_processor_summary(from, to, processor) — Report 2, one row per
--    MID per processor per month ('merchant'), a subtotal per processor-month
--    ('processor') and a grand total ('total'). Import lines only:
--      volume         sum(volume): the signer's line only on a shared account
--      residual       the ACCOUNT residual: residual_income on an unshared
--                     line, account_residual_income on the signer's line; the
--                     partner's piece is not added again
--      rep_side       sum(rep_payout) over the merchant's import lines (both
--                     halves of a share): the merchant's rate of the residual,
--                     before any override (an override moves money inside
--                     the rep side, never out of the company's share)
--      company_share  residual - rep_side (all of it for a house merchant)
--    The owner is the payee of the unshared or signer line (the owner at
--    commit, never re-read from merchants); merchant_name is the line's
--    snapshot, the name the statement prints.
--
-- So, for any month: sum of Report 1's (agent_split + overrides_received)
-- + Report 2's company_share = the file residuals of the committed batches.
-- Tested over many random cases through the real commit
-- (tests/rls/reports.test.ts).
--
-- REFUSES TO RUN if a ledger or batch column the bodies read is missing
-- (plpgsql is not checked until it is called). Reads and writes no row.
-- =====================================================================

-- 0. What the two bodies read, checked.
do $$
declare
  missing text;
begin
  select string_agg(format('%s.%s', t, c), ', ' order by t, c) into missing
    from (values
      ('rep_payout_rows', 'line_kind'), ('rep_payout_rows', 'processor'),
      ('rep_payout_rows', 'batch_id'), ('rep_payout_rows', 'rep_payout'),
      ('rep_payout_rows', 'share_role'), ('rep_payout_rows', 'account_residual_income'),
      ('rep_payout_rows', 'override_role'), ('rep_payout_rows', 'override_amount'),
      ('rep_payout_batches', 'status'), ('profiles', 'llc_legal_name'),
      ('profiles', 'legal_name'), ('profiles', 'agent_number')
    ) as needed(t, c)
   where not exists (select 1 from information_schema.columns
                      where table_schema = 'public' and table_name = needed.t
                        and column_name = needed.c);
  if missing is not null then
    raise exception 'The reports read columns that are not here: %. Inspect the schema before applying 20261102160000.', missing;
  end if;
end $$;

-- 1. Report 1.
create function rep_payout_summary(
  period_from_input date,
  period_to_input date,
  processor_input text default null
)
returns table (
  row_kind text,
  period date,
  agent_id uuid,
  agent_code text,
  legal_name text,
  full_name text,
  sales_volume numeric,
  net_residual numeric,
  agent_split numeric,
  deductions numeric,
  overrides_received numeric,
  total_commission numeric
)
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
#variable_conflict use_column
begin
  if not is_admin() then
    raise exception 'Reports are for admins.' using errcode = 'PT403';
  end if;
  if period_from_input is null or period_to_input is null
     or period_from_input <> date_trunc('month', period_from_input)::date
     or period_to_input <> date_trunc('month', period_to_input)::date
     or period_to_input < period_from_input then
    raise exception 'Choose a first and last month, the first no later than the last.'
      using errcode = '22023';
  end if;

  return query
  with lines as (
    select l.period, l.agent_id, l.line_kind, l.override_role,
           l.volume, l.residual_income, l.rep_payout, l.override_amount
      from rep_payout_rows l
      left join rep_payout_batches b on b.id = l.batch_id
     where l.period between period_from_input and period_to_input
       and (processor_input is null or l.processor = processor_input)
       and (l.line_kind = 'adjustment' or b.status = 'committed')
  ),
  agg as (
    select grouping(l.period, l.agent_id) as g, l.period, l.agent_id,
           coalesce(sum(l.volume) filter (where l.line_kind = 'import'), 0) as vol,
           coalesce(sum(l.residual_income) filter (where l.line_kind = 'import'), 0) as net,
           coalesce(sum(l.rep_payout) filter (where l.line_kind = 'import'), 0)
             + coalesce(sum(l.override_amount)
                          filter (where l.line_kind = 'override' and l.override_role = 'debit'), 0)
             as split,
           coalesce(sum(l.rep_payout) filter (where l.line_kind = 'adjustment'), 0) as deduct,
           coalesce(sum(l.override_amount)
                      filter (where l.line_kind = 'override' and l.override_role = 'credit'), 0)
             as received
      from lines l
     group by grouping sets ((l.period, l.agent_id), (l.period), ())
  )
  select case a.g when 0 then 'rep' when 1 then 'month' else 'total' end,
         a.period, a.agent_id, p.agent_number,
         coalesce(p.llc_legal_name, p.legal_name), p.full_name,
         round(a.vol, 2), round(a.net, 2), round(a.split, 2), round(a.deduct, 2),
         round(a.received, 2), round(a.split + a.received, 2)
    from agg a
    left join profiles p on p.id = a.agent_id
   -- An empty selection still answers with its grand total row (zeros), so
   -- skip it: no lines is no rows.
   where exists (select 1 from lines)
   order by a.period nulls last, a.g, p.agent_number nulls last, p.full_name, a.agent_id;
end;
$$;

revoke all on function rep_payout_summary(date, date, text) from public;
revoke all on function rep_payout_summary(date, date, text) from anon;
grant execute on function rep_payout_summary(date, date, text) to authenticated, service_role;

-- 2. Report 2.
create function merchant_processor_summary(
  period_from_input date,
  period_to_input date,
  processor_input text default null
)
returns table (
  row_kind text,
  period date,
  processor text,
  merchant_id int,
  mid text,
  merchant_name text,
  owner_id uuid,
  owner_code text,
  owner_name text,
  volume numeric,
  residual numeric,
  rep_side numeric,
  company_share numeric
)
language plpgsql
stable
security invoker
set search_path = public, pg_temp
as $$
#variable_conflict use_column
begin
  if not is_admin() then
    raise exception 'Reports are for admins.' using errcode = 'PT403';
  end if;
  if period_from_input is null or period_to_input is null
     or period_from_input <> date_trunc('month', period_from_input)::date
     or period_to_input <> date_trunc('month', period_to_input)::date
     or period_to_input < period_from_input then
    raise exception 'Choose a first and last month, the first no later than the last.'
      using errcode = '22023';
  end if;

  return query
  with lines as (
    select l.period, l.processor, l.mid, l.merchant_id, l.merchant_name, l.agent_id,
           l.share_role, l.volume, l.residual_income, l.account_residual_income,
           l.rep_payout
      from rep_payout_rows l
      join rep_payout_batches b on b.id = l.batch_id
     where l.period between period_from_input and period_to_input
       and (processor_input is null or l.processor = processor_input)
       and l.line_kind = 'import'
       and b.status = 'committed'
  ),
  agg as (
    select grouping(l.period, l.processor, l.mid) as g, l.period, l.processor, l.mid,
           max(l.merchant_id) as merchant_id,
           max(l.merchant_name) filter (where l.share_role is distinct from 'secondary')
             as merchant_name,
           (array_agg(l.agent_id) filter (where l.share_role is distinct from 'secondary'))[1]
             as owner_id,
           coalesce(sum(l.volume), 0) as vol,
           coalesce(sum(case when l.share_role is null then l.residual_income
                             when l.share_role = 'primary' then l.account_residual_income
                        end), 0) as res,
           coalesce(sum(l.rep_payout), 0) as rep
      from lines l
     group by grouping sets ((l.period, l.processor, l.mid), (l.period, l.processor), ())
  )
  select case a.g when 0 then 'merchant' when 1 then 'processor' else 'total' end,
         a.period, a.processor,
         case when a.g = 0 then a.merchant_id end, a.mid,
         case when a.g = 0 then a.merchant_name end,
         case when a.g = 0 then a.owner_id end,
         case when a.g = 0 then p.agent_number end,
         case when a.g = 0 then p.full_name end,
         round(a.vol, 2), round(a.res, 2), round(a.rep, 2), round(a.res - a.rep, 2)
    from agg a
    left join profiles p on p.id = a.owner_id and a.g = 0
   where exists (select 1 from lines)
   order by a.period nulls last, a.processor nulls last, a.g, a.merchant_name, a.mid;
end;
$$;

revoke all on function merchant_processor_summary(date, date, text) from public;
revoke all on function merchant_processor_summary(date, date, text) from anon;
grant execute on function merchant_processor_summary(date, date, text) to authenticated, service_role;
