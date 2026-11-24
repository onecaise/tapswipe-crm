-- Before and after scripts/set-override-funding.sql — SUPABASE SQL EDITOR, read-only.
--
-- One grid, one row per finding: (section, item, n, amount). No email, name or
-- id: agent numbers, processor-months and counts. The SQL Editor shows only
-- the last statement's result, so every pre-check is in this one query.
-- docs/claude/deploy-override-funding.md says what each should read.
--
--   1 overrides       one row per recipient's agent number x funded_by, and
--                     'total'. Before: 103 owner 88, 105 owner 3, 108 owner 1,
--                     total 92. After: 103 company 88, 105 company 3,
--                     108 owner 1, total 92.
--   2 plumlee         overrides to 103 on Plumlee LLC merchants (88), and on
--                     Lamar County Justice Court's MID to 108 (1).
--   3 paid            each processor-month of the months below marked paid.
--   4 touched         each committed processor-month of the months below whose
--                     override lines include an override to change (all but
--                     Lamar's): the ones to reopen if paid, then replace.
--   5 pending         override_funding_pending()'s rows, read directly: the
--                     committed months whose lines still carry the old
--                     funding (n = overrides). Empty before the change; after
--                     it, the months to REPLACE; empty again once replaced.
--   6 adjustments     adjustment lines that adjust one of the months, by
--                     processor-month. Any here refuses that month's replace.
--   7 drift           import lines of the months whose merchant now has
--                     another owner, rate or MID than the line was paid at. A
--                     replace re-pays those from the merchant as it is now.
--   8 debits          override debit lines of the months, by owner's agent
--                     number and month, with their sum: what company funding
--                     gives back to each owner.
--   9 credits         override credit lines of the months, by recipient's
--                     agent number, month and funding, with their sum.
--
-- The months are the ones being replaced (August and September 2026); edit
-- the two dates in `months` to look at others.

with months(period) as (
  values (date '2026-08-01'), (date '2026-09-01')
),
lamar as (
  select o.id
    from merchant_overrides o
    join merchants m on m.id = o.merchant_id
    join profiles p on p.id = o.recipient_id
   where p.agent_number = '108' and mid_key(m.mid) = mid_key('30119964826')
),
committed_lines as (
  select l.*
    from rep_payout_rows l
    join rep_payout_batches b on b.id = l.batch_id and b.status = 'committed'
   where l.period in (select period from months)
)
select '1 overrides' as section, coalesce(p.agent_number, '(no code)') || ' ' || o.funded_by as item,
       count(*) as n, null::numeric as amount
  from merchant_overrides o join profiles p on p.id = o.recipient_id
 group by p.agent_number, o.funded_by
union all
select '1 overrides', 'total', count(*), null from merchant_overrides
union all
select '2 plumlee', '103 on Plumlee LLC merchants', count(*), null
  from merchant_overrides o
  join merchants m on m.id = o.merchant_id
  join profiles owner_p on owner_p.id = m.agent_id
  join profiles rec on rec.id = o.recipient_id
 where owner_p.llc_legal_name = 'Plumlee LLC' and rec.agent_number = '103'
union all
select '2 plumlee', '108 on Lamar County Justice Court', count(*), null from lamar
union all
select '3 paid', c.processor || ' ' || to_char(c.period, 'YYYY-MM'), 1, null
  from payout_period_closures c
 where c.period in (select period from months)
union all
select '4 touched', l.processor || ' ' || to_char(l.period, 'YYYY-MM'), count(distinct l.override_id), null
  from committed_lines l
 where l.line_kind = 'override' and l.override_id not in (select id from lamar)
 group by l.processor, l.period
union all
select '5 pending', l.processor || ' ' || to_char(l.period, 'YYYY-MM'), count(distinct l.override_id), null
  from rep_payout_rows l
  join rep_payout_batches b on b.id = l.batch_id and b.status = 'committed'
  join merchant_overrides o on o.id = l.override_id
 where l.line_kind = 'override' and l.override_funded_by is distinct from o.funded_by
 group by l.processor, l.period
union all
select '6 adjustments', coalesce(a.processor, '(none)') || ' ' || to_char(a.adjusts_period, 'YYYY-MM'),
       count(*), sum(a.adjustment_amount)
  from rep_payout_rows a
 where a.line_kind = 'adjustment' and a.adjusts_period in (select period from months)
 group by a.processor, a.adjusts_period
union all
select '7 drift', l.processor || ' ' || to_char(l.period, 'YYYY-MM'), count(*), null
  from committed_lines l
  left join merchants m on m.id = l.merchant_id
 where l.line_kind = 'import'
   and (m.id is null
        or mid_key(m.mid) is distinct from mid_key(l.mid)
        or l.rep_split_pct is distinct from m.split_agent_pct
        or (l.share_role is distinct from 'secondary' and l.agent_id is distinct from m.agent_id))
 group by l.processor, l.period
union all
select '8 debits', coalesce(p.agent_number, '(no code)') || ' ' || to_char(l.period, 'YYYY-MM'),
       count(*), sum(l.override_amount)
  from committed_lines l join profiles p on p.id = l.agent_id
 where l.line_kind = 'override' and l.override_role = 'debit'
 group by p.agent_number, l.period
union all
select '9 credits', coalesce(p.agent_number, '(no code)') || ' ' || to_char(l.period, 'YYYY-MM') || ' ' || l.override_funded_by,
       count(*), sum(l.override_amount)
  from committed_lines l join profiles p on p.id = l.agent_id
 where l.line_kind = 'override' and l.override_role = 'credit'
 group by p.agent_number, l.period, l.override_funded_by
order by 1, 2;
