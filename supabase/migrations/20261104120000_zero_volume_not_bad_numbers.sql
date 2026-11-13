-- Zero volume is not a bad number: commit_residual_import_v3 re-created with
-- bad_numbers = volume < 0 or (volume > 0 and residual > volume), so a
-- zero-volume line commits with no confirmation. The parser's rowWarnings()
-- changes in the same commit.
--
-- Matches docs/tapswipe_crm_schema.sql, updated first; the block below is
-- copied from it verbatim.
--
-- =====================================================================
-- ZERO VOLUME IS NOT A BAD NUMBER (20261104120000) — a correction to the
-- bad_numbers warning of docs/design/intake-and-reports.md (§0.4, §0b.3,
-- §2.4).
--
-- bad_numbers was `volume <= 0 or residual > volume`. It is now
--
--     volume < 0  or  (volume > 0 and residual > volume)
--
-- so a ZERO-VOLUME line imports with no warning, whatever its residual:
-- negative (a chargeback or closing fee on a closed merchant), zero, or
-- positive (a monthly fee on a merchant with no sales). Those lines are on
-- most real files, and the confirmation is one yes per warning TYPE per
-- import (§0b.3): with them in it, the admin answered yes every month, and
-- that one yes also passed the rows the warning exists for -- a negative
-- volume, or a residual above a positive volume (the columns swapped).
-- `residual > volume` says nothing at volume 0, where any fee exceeds it.
--
-- Unchanged: a negative volume is still confirmable only through
-- bad_numbers, and v3 still marks exactly those lines volume_confirmed_
-- negative (rep_payout_rows_volume_check, 20261030120000). Volume > 0 with a
-- negative residual is still silent (A25), and so is volume > 0 with zero.
--
-- The rule lives twice and the two move together: rowWarnings() in
-- supabase/functions/_shared/residuals.ts (the preview) and step 4 below
-- (the commit), pinned by the live parse-then-commit test.
--
-- commit_residual_import_v3 is re-created whole: the body of 20261102120000
-- with ONLY the bad_numbers line of step 4 changed. REFUSES TO RUN, naming
-- what it found, if the deployed function does not carry the old rule
-- exactly once (so it is not the body this was copied from).
-- =====================================================================

-- 0. The function this replaces is the one it was copied from.
do $$
declare
  body text := pg_get_functiondef('public.commit_residual_import_v3(int, text[])'::regprocedure);
  old  text := '(''bad_numbers'', r.volume <= 0 or r.residual_income > r.volume)';
begin
  if (length(body) - length(replace(body, old, ''))) / length(old) <> 1 then
    raise exception 'commit_residual_import_v3 does not carry the 20261102120000 bad_numbers rule exactly once here. Inspect pg_get_functiondef before applying 20261104120000.';
  end if;
end $$;

-- 1. v3, step 4's bad_numbers line changed. Otherwise the body of 20261102120000.
create or replace function commit_residual_import_v3(
  batch_id_input  int,
  confirmed_input text[]
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  batch       rep_payout_batches;
  confirmed   text[] := coalesce(confirmed_input, '{}');
  other       rep_payout_batches;
  replaced    rep_payout_batches;
  staged      int;
  blocked     int;
  problem     text;
  unconfirmed text[];
  covered     jsonb;
  unshared    int;
  signers     int;
  partners    int;
  overrides   int := 0;
  removed     int := 0;
begin
  if not is_admin() then
    raise exception 'admin only' using errcode = 'PT403';
  end if;

  if exists (select 1 from unnest(confirmed) as c(code)
              where c.code is null
                 or c.code not in ('processor_mismatch', 'inactive_merchant',
                                   'bad_numbers')) then
    raise exception 'Only processor_mismatch, inactive_merchant and bad_numbers can be confirmed.'
      using errcode = '22023';
  end if;

  -- 1-2. Locks and guards.
  select * into batch from rep_payout_batches where id = batch_id_input for update;
  if not found then
    raise exception 'import not found' using errcode = 'PT404';
  end if;

  if batch.status <> 'review' then
    raise exception 'this import is already %', batch.status
      using errcode = 'PT409';
  end if;

  if batch.processor is null or batch.period is null then
    raise exception 'This import was started before the processor and month were chosen at upload, so it cannot be committed. Abandon it and upload the file again.'
      using errcode = 'PT409';
  end if;

  -- One committed batch per processor-month, without a race between two
  -- different batches for the same pair.
  perform pg_advisory_xact_lock(hashtext(
    'tapswipe.residual_month:' || batch.processor || '/' || batch.period::text));

  -- A replacement: the batch it replaces must still be the committed one for
  -- this processor-month, and the month must not be marked paid.
  if batch.replaces_batch_id is not null then
    select * into replaced
      from rep_payout_batches where id = batch.replaces_batch_id for update;
    if not found or replaced.status <> 'committed'
       or replaced.processor is distinct from batch.processor
       or replaced.period is distinct from batch.period then
      raise exception 'This file was uploaded to replace import #%, which is no longer the committed import for % for %. Abandon it and upload the file again.',
        batch.replaces_batch_id, batch.processor, to_char(batch.period, 'FMMonth YYYY')
        using errcode = 'PT409';
    end if;

    if exists (select 1 from payout_period_closures
                where period = batch.period and processor = batch.processor) then
      raise exception '% for % is marked paid and cannot be replaced. Reopen it (with a reason), or post an adjustment instead.',
        batch.processor, to_char(batch.period, 'FMMonth YYYY')
        using errcode = 'PT409';
    end if;
  end if;

  select * into other
    from rep_payout_batches
   where processor = batch.processor and period = batch.period
     and status = 'committed' and id <> batch.id
     and id is distinct from batch.replaces_batch_id;
  if found then
    raise exception '% for % is already committed (import #%). A second file for that month replaces it: upload it again and answer Yes to replace.',
      batch.processor, to_char(batch.period, 'FMMonth YYYY'), other.id
      using errcode = 'PT409';
  end if;

  perform pg_advisory_xact_lock(hashtext('tapswipe.merchant_rep_shares'));

  -- A replacement may not pull the month out from under an adjustment that
  -- was worked out from the figures it replaces.
  if batch.replaces_batch_id is not null then
    select string_agg(distinct a.mid, ', ') into problem
      from rep_payout_rows a
     where a.line_kind = 'adjustment' and a.adjusts_period = batch.period
       and (a.processor = batch.processor
            or a.mid in (select l.mid from rep_payout_rows l
                          where l.batch_id = replaced.id));
    if problem is not null then
      raise exception 'Adjustments already correct % for % (MIDs %). They were worked out from the committed figures, so the month cannot be replaced under them.',
        batch.processor, to_char(batch.period, 'FMMonth YYYY'), problem
        using errcode = 'PT409';
    end if;
  end if;

  select count(*) into staged
    from rep_payout_import_rows where batch_id = batch_id_input;

  if staged = 0 then
    raise exception 'this import has no rows' using errcode = 'PT409';
  end if;

  select count(*) into blocked
    from rep_payout_import_rows
   where batch_id = batch_id_input and blocker is not null;

  if blocked > 0 then
    raise exception '% of % rows are still blocked', blocked, staged
      using errcode = 'PT409';
  end if;

  -- No owner, MID or rate of a merchant in this file changes until commit.
  perform 1 from merchants m
   where m.mid in (select r.mid_raw from rep_payout_import_rows r
                    where r.batch_id = batch_id_input)
   for share;

  -- 3. Re-derived from the database.
  select string_agg(r.row_number::text, ', ' order by r.row_number) into problem
    from rep_payout_import_rows r
   where r.batch_id = batch_id_input and r.period is distinct from batch.period;
  if problem is not null then
    raise exception 'Rows % were read for a different month than this import''s (%). Read the file again.',
      problem, to_char(batch.period, 'FMMonth YYYY')
      using errcode = 'PT409';
  end if;

  select string_agg(r.row_number::text, ', ' order by r.row_number) into problem
    from rep_payout_import_rows r
   where r.batch_id = batch_id_input
     and (r.mid_raw is null or btrim(r.mid_raw) = '');
  if problem is not null then
    raise exception 'Rows % have no MID. Fix the file and upload it again.', problem
      using errcode = 'PT409';
  end if;

  select string_agg(d.mid_raw || ' (rows ' || d.row_list || ')', '; ' order by d.mid_raw)
    into problem
    from (select r.mid_raw,
                 string_agg(r.row_number::text, ', ' order by r.row_number) as row_list
            from rep_payout_import_rows r
           where r.batch_id = batch_id_input
           group by r.mid_raw
          having count(*) > 1) d;
  if problem is not null then
    raise exception 'A MID appears on more than one row: %. Fix the file and upload it again.', problem
      using errcode = 'PT409';
  end if;

  select string_agg(r.mid_raw, ', ' order by r.row_number) into problem
    from rep_payout_import_rows r
   where r.batch_id = batch_id_input
     and not exists (select 1 from merchants m where m.mid = r.mid_raw);
  if problem is not null then
    raise exception 'MIDs % are not merchants in the CRM. Add them (or correct their MID), then read the file again.', problem
      using errcode = 'PT409';
  end if;

  select string_agg(r.row_number::text, ', ' order by r.row_number) into problem
    from rep_payout_import_rows r
   where r.batch_id = batch_id_input
     and lower(regexp_replace(coalesce(r.income_type_raw, ''),
                              '^[\s﻿]+|[\s﻿]+$', '', 'g')) <> 'residuals';
  if problem is not null then
    raise exception 'Rows % have an Income Type other than Residuals. Fix the file and upload it again.', problem
      using errcode = 'PT409';
  end if;

  select string_agg(r.row_number::text, ', ' order by r.row_number) into problem
    from rep_payout_import_rows r
   where r.batch_id = batch_id_input
     and (r.volume is null or r.residual_income is null);
  if problem is not null then
    raise exception 'Rows % have no Volume or no Residual. Fix the file and upload it again.', problem
      using errcode = 'PT409';
  end if;

  select string_agg(r.mid_raw, ', ' order by r.row_number) into problem
    from rep_payout_import_rows r
    join merchants m on m.mid = r.mid_raw
   where r.batch_id = batch_id_input
     and (r.merchant_id is distinct from m.id
          or r.agent_id is distinct from m.agent_id);
  if problem is not null then
    raise exception 'A merchant''s MID or owner changed after this file was read (MIDs %). Read it again.', problem
      using errcode = 'PT409';
  end if;

  select string_agg(r.mid_raw, ', ' order by r.row_number) into problem
    from rep_payout_import_rows r
    join merchants m on m.mid = r.mid_raw
   where r.batch_id = batch_id_input and m.split_agent_pct is null;
  if problem is not null then
    raise exception 'MIDs % belong to merchants with no split rate. Set each merchant''s rate, then commit.', problem
      using errcode = 'PT409';
  end if;

  -- No merge. On a replacement, the lines of the batch being replaced are
  -- about to go, so they are not "already there".
  select string_agg(distinct r.mid_raw, ', ') into problem
    from rep_payout_import_rows r
    join rep_payout_rows l
      on l.mid = r.mid_raw and l.period = batch.period and l.line_kind = 'import'
   where r.batch_id = batch_id_input
     and (batch.replaces_batch_id is null
          or l.batch_id is distinct from batch.replaces_batch_id);
  if problem is not null then
    raise exception 'MIDs % already have a line for %. A committed month is never merged into: read the file again.',
      problem, to_char(batch.period, 'FMMonth YYYY')
      using errcode = 'PT409';
  end if;

  select string_agg(r.mid_raw, ', ' order by r.row_number) into problem
    from rep_payout_import_rows r
    join merchants m on m.mid = r.mid_raw
    join merchant_rep_shares s
      on s.merchant_id = m.id
     and batch.period >= s.effective_from
     and (s.effective_to is null or batch.period < s.effective_to)
   where r.batch_id = batch_id_input
     and (s.primary_agent_id <> m.agent_id
          or s.primary_rep_pct + s.secondary_rep_pct <> m.split_agent_pct);
  if problem is not null then
    raise exception 'MIDs % have a shared-account split whose signer is not the merchant''s owner, or whose shares do not total the merchant''s rate. End the share and set it again, then commit.', problem
      using errcode = 'PT409';
  end if;

  -- Overrides in force for the month (phase 10). The functions that set
  -- them hold these rules; a rate, an owner, a share or a person can change
  -- after that, so the commit checks them again.
  select string_agg(r.mid_raw || ' (override #' || o.id || ')', ', ' order by r.row_number)
    into problem
    from rep_payout_import_rows r
    join merchants m on m.mid = r.mid_raw
    join merchant_overrides o
      on o.merchant_id = m.id
     and batch.period >= o.effective_from
     and (o.effective_to is null or batch.period < o.effective_to)
   where r.batch_id = batch_id_input
     and o.override_pct > m.split_agent_pct;
  if problem is not null then
    raise exception 'MIDs % have an override above the merchant''s rate. An override comes out of the rep side: end or change it, then commit.', problem
      using errcode = 'PT409';
  end if;

  select string_agg(r.mid_raw || ' (override #' || o.id || ')', ', ' order by r.row_number)
    into problem
    from rep_payout_import_rows r
    join merchants m on m.mid = r.mid_raw
    join merchant_overrides o
      on o.merchant_id = m.id
     and batch.period >= o.effective_from
     and (o.effective_to is null or batch.period < o.effective_to)
   where r.batch_id = batch_id_input
     and (o.recipient_id = m.agent_id
          or exists (select 1 from merchant_rep_shares s
                      where s.merchant_id = m.id
                        and batch.period >= s.effective_from
                        and (s.effective_to is null or batch.period < s.effective_to)
                        and o.recipient_id in (s.primary_agent_id, s.secondary_agent_id)));
  if problem is not null then
    raise exception 'MIDs % have an override paid to the merchant''s owner or to a party of its shared account. End the override and set it again, then commit.', problem
      using errcode = 'PT409';
  end if;

  select string_agg(r.mid_raw || ' (override #' || o.id || ' to ' || p.full_name || ')', ', '
                    order by r.row_number)
    into problem
    from rep_payout_import_rows r
    join merchants m on m.mid = r.mid_raw
    join merchant_overrides o
      on o.merchant_id = m.id
     and batch.period >= o.effective_from
     and (o.effective_to is null or batch.period < o.effective_to)
    join profiles p on p.id = o.recipient_id
   where r.batch_id = batch_id_input
     and not p.is_active;
  if problem is not null then
    raise exception 'Overrides on MIDs % pay someone who is deactivated. End each override (or reactivate the person), then commit.', problem
      using errcode = 'PT409';
  end if;

  -- 4. The warnings, recomputed: the parser's rowWarnings().
  with flagged as (
    select r.row_number, w.code
      from rep_payout_import_rows r
      join merchants m on m.mid = r.mid_raw
      cross join lateral (values
        ('processor_mismatch',
         r.processor_raw is null
         or lower(btrim(regexp_replace(r.processor_raw, '[\s﻿]+', ' ', 'g')))
            <> lower(btrim(regexp_replace(batch.processor, '[\s﻿]+', ' ', 'g')))
         or (m.processor is not null and m.processor <> batch.processor)),
        ('inactive_merchant', m.status = 'inactive'),
        ('bad_numbers', r.volume < 0 or (r.volume > 0 and r.residual_income > r.volume))
      ) as w(code, hit)
     where r.batch_id = batch_id_input and w.hit
  )
  select jsonb_object_agg(f.code, f.row_list),
         array_agg(f.code order by f.code)
           filter (where not (f.code = any(confirmed)))
    into covered, unconfirmed
    from (select code, jsonb_agg(row_number order by row_number) as row_list
            from flagged group by code) f;

  if cardinality(unconfirmed) > 0 then
    select string_agg(replace(u.code, '_', ' ') || ' (rows '
                      || (select string_agg(x.value, ', ')
                            from jsonb_array_elements_text(covered -> u.code) as x(value))
                      || ')', '; ' order by u.code)
      into problem
      from unnest(unconfirmed) as u(code);
    raise exception 'These warnings were not confirmed: %. Confirm them on the review screen, or fix the data and read the file again.', problem
      using errcode = 'PT409',
            detail = array_to_string(unconfirmed, ',');
  end if;

  -- 5. The replace, then the lines. Every refusal is behind us: from here
  -- on, the commit writes.
  if batch.replaces_batch_id is not null then
    -- The old batch's lines: its import lines, the shared lines derived from
    -- them, and its override lines, which step 6 writes again. Adjustments
    -- carry no batch and stay.
    delete from rep_payout_rows where batch_id = replaced.id;
    get diagnostics removed = row_count;

    update rep_payout_batches
       set status = 'replaced', replaced_by_batch_id = batch_id_input
     where id = replaced.id;
  end if;

  -- Plain inserts, never a merge.
  -- Unshared: the owner's one line at the merchant's rate.
  insert into rep_payout_rows (
    agent_id, period, processor, mid, merchant_name, merchant_id,
    volume, average_ticket, total_cost, volume_confirmed_negative,
    residual_income, rep_split_pct, batch_id
  )
  select
    m.agent_id, batch.period, batch.processor, m.mid,
    coalesce(m.dba, r.merchant_name_raw), m.id,
    r.volume, r.average_ticket, r.total_cost, r.volume < 0,
    r.residual_income, m.split_agent_pct, batch_id_input
    from rep_payout_import_rows r
    join merchants m on m.mid = r.mid_raw
   where r.batch_id = batch_id_input
     and not exists (
       select 1 from merchant_rep_shares s
        where s.merchant_id = m.id
          and batch.period >= s.effective_from
          and (s.effective_to is null or batch.period < s.effective_to));

  get diagnostics unshared = row_count;

  -- Shared, the signer's line: the volume, and the account residual less the
  -- partner's piece.
  insert into rep_payout_rows (
    agent_id, period, processor, mid, merchant_name, merchant_id,
    volume, average_ticket, total_cost, volume_confirmed_negative,
    residual_income, rep_split_pct, batch_id,
    rep_share_id, share_role, primary_rep_pct, secondary_rep_pct,
    account_residual_income
  )
  select
    m.agent_id, batch.period, batch.processor, m.mid,
    coalesce(m.dba, r.merchant_name_raw), m.id,
    r.volume, r.average_ticket, r.total_cost, r.volume < 0,
    r.residual_income
      - shared_part(r.residual_income, s.secondary_rep_pct,
                    s.primary_rep_pct + s.secondary_rep_pct),
    m.split_agent_pct, batch_id_input,
    s.id, 'primary', s.primary_rep_pct, s.secondary_rep_pct,
    r.residual_income
    from rep_payout_import_rows r
    join merchants m on m.mid = r.mid_raw
    join merchant_rep_shares s
      on s.merchant_id = m.id
     and batch.period >= s.effective_from
     and (s.effective_to is null or batch.period < s.effective_to)
   where r.batch_id = batch_id_input;

  get diagnostics signers = row_count;

  -- Shared, the partner's line: no volume (it is counted once, on the
  -- signer's line), the partner's piece of the residual.
  insert into rep_payout_rows (
    agent_id, period, processor, mid, merchant_name, merchant_id,
    volume, average_ticket, total_cost,
    residual_income, rep_split_pct, batch_id,
    rep_share_id, share_role, primary_rep_pct, secondary_rep_pct,
    account_residual_income
  )
  select
    s.secondary_agent_id, batch.period, batch.processor, m.mid,
    coalesce(m.dba, r.merchant_name_raw), m.id,
    null, null, null,
    shared_part(r.residual_income, s.secondary_rep_pct,
                s.primary_rep_pct + s.secondary_rep_pct),
    m.split_agent_pct, batch_id_input,
    s.id, 'secondary', s.primary_rep_pct, s.secondary_rep_pct,
    r.residual_income
    from rep_payout_import_rows r
    join merchants m on m.mid = r.mid_raw
    join merchant_rep_shares s
      on s.merchant_id = m.id
     and batch.period >= s.effective_from
     and (s.effective_to is null or batch.period < s.effective_to)
   where r.batch_id = batch_id_input;

  get diagnostics partners = row_count;

  -- 6. The override lines (phase 10). X = round(R * o / 100, 2), once, from
  -- the account residual; on a shared account the partner's piece of the
  -- deduction is shared_part(X, b, a + b) and the signer's the rest (the
  -- payout's own cent rule). Debits -piece, the credit +X: they net to zero,
  -- and the reps' nets plus the credit are exactly T. On a replacement this
  -- is what rebuilds them.
  with applied as (
    select m.id as merchant_id, m.agent_id as owner_id, m.mid,
           coalesce(m.dba, r.merchant_name_raw) as merchant_name,
           o.id as override_id, o.recipient_id,
           round(r.residual_income * o.override_pct / 100, 2) as x,
           s.secondary_agent_id, s.primary_rep_pct, s.secondary_rep_pct
      from rep_payout_import_rows r
      join merchants m on m.mid = r.mid_raw
      join merchant_overrides o
        on o.merchant_id = m.id
       and batch.period >= o.effective_from
       and (o.effective_to is null or batch.period < o.effective_to)
      left join merchant_rep_shares s
        on s.merchant_id = m.id
       and batch.period >= s.effective_from
       and (s.effective_to is null or batch.period < s.effective_to)
     where r.batch_id = batch_id_input
  ),
  pieces as (
    select a.*,
           case when a.secondary_agent_id is null then 0
                else shared_part(a.x, a.secondary_rep_pct,
                                 a.primary_rep_pct + a.secondary_rep_pct)
           end as partner_piece
      from applied a
  ),
  lines as (
    select owner_id as agent_id, merchant_id, mid, merchant_name, override_id,
           'debit' as role, -(x - partner_piece) as amount
      from pieces
    union all
    select secondary_agent_id, merchant_id, mid, merchant_name, override_id,
           'debit', -partner_piece
      from pieces
     where secondary_agent_id is not null
    union all
    select recipient_id, merchant_id, mid, merchant_name, override_id,
           'credit', x
      from pieces
  )
  insert into rep_payout_rows (
    agent_id, period, processor, mid, merchant_name, merchant_id,
    batch_id, line_kind, override_id, override_role, override_amount
  )
  select
    l.agent_id, batch.period, batch.processor, l.mid, l.merchant_name, l.merchant_id,
    batch_id_input, 'override', l.override_id, l.role, l.amount
    from lines l;

  select count(*) into overrides
    from rep_payout_rows
   where batch_id = batch_id_input and line_kind = 'override'
     and override_role = 'credit';

  -- 7. Close the batch, and the audit rows.
  delete from rep_payout_import_rows where batch_id = batch_id_input;

  update rep_payout_batches
     set status = 'committed', committed_at = now(), row_count = staged,
         skipped_rows = '[]'::jsonb,
         confirmed_warnings = coalesce(covered, '{}'::jsonb)
   where id = batch_id_input;

  insert into audit_log (actor_id, action, table_name, row_id)
  values (auth.uid(), 'commit_residual_import', 'rep_payout_batches',
          batch_id_input::text);

  if batch.replaces_batch_id is not null then
    insert into audit_log (actor_id, action, table_name, row_id)
    values (auth.uid(), 'replace_residual_import', 'rep_payout_batches',
            replaced.id::text);
  end if;

  return jsonb_build_object(
    'written', unshared + signers + partners,
    'rows', staged,
    'shared', signers,
    'overrides', overrides,
    'replaced_lines', removed
  );
end;
$$;

-- PUBLIC (which includes anon) gets EXECUTE on every new function and nothing
-- declarative revokes it. Re-stated: create or replace keeps the existing ACL,
-- but these lines are what the grants test reads.
revoke all on function commit_residual_import_v3(int, text[]) from public;
revoke all on function commit_residual_import_v3(int, text[]) from anon;
grant execute on function commit_residual_import_v3(int, text[]) to authenticated, service_role;
