-- MIDs with letters, compared case-insensitively wherever a residual line is
-- matched to a merchant. After phase 14 of docs/design/intake-and-reports.md.
--
-- Matches docs/tapswipe_crm_schema.sql, updated first; the block below is
-- copied from it verbatim.
--
-- =====================================================================
-- ALPHANUMERIC MIDS (20261106140000) — after phase 14 of
-- docs/design/intake-and-reports.md.
--
-- Phase 14 loads merchants whose MID has letters (a Square MID is 13
-- letters and digits). The residual parser read a Merchant Number as digits
-- only, and every residual match was case-sensitive equality, so a Square
-- file could not pay them. The parser now reads 6-20 letters and digits
-- (_shared/residuals.ts); here, the database side:
--
-- 1. mid_key(text) = upper(btrim(text)), the one key two MIDs are compared
--    by (the parser's twin is midKey()). Immutable SQL, the norm_city()
--    shape; EXECUTE for authenticated and service_role only.
--
-- 2. merchants_mid_key_ci, a unique index on mid_key(mid). merchants.mid
--    stays unique as written (merchants_mid_key) and keeps its spelling;
--    this makes "abc123" and "ABC123" one MID, so a key names at most one
--    merchant and a case-insensitive match is never ambiguous. The merchant
--    import already refused a MID on a merchant in another case
--    (mid_exists); the merchant form's 23505 message ("That MID is already
--    in use") covers this index too.
--
-- 3. commit_residual_import_v3, delete_payout_period and
--    post_payout_adjustment re-created with every MID comparison on
--    mid_key(): a staged line to its merchant (the row lock, unknown MID,
--    owner or MID changed, no rate, shares, overrides, the warnings and the
--    three inserts), a MID repeated in the file (two spellings of one MID
--    are a repeat, listed with both), a MID that already has a line this
--    month (no merge), and the adjustments a replace or a delete may not
--    pull a month out from under. An adjustment's MID is found the same way.
--    Lines are still written with the MERCHANT's spelling (m.mid), so the
--    statements, both reports (which group the ledger's own mid within a
--    processor-month) and both exports show it unchanged. Otherwise each is
--    the body it was copied from: 20261104140000's v3, 20261102120000's
--    delete_payout_period and 20261030190000's post_payout_adjustment.
--
-- REFUSES TO RUN, naming them, while two merchants' MIDs differ only in
-- case or surrounding spaces (change one MID, then apply), and unless each
-- of the three deployed functions carries the comparison it replaces. No
-- row is written. Read-only check:
--   select mid_key, string_agg(id || ' ' || mid, ', ') from
--     (select id, mid, upper(btrim(mid)) as mid_key from merchants
--       where mid is not null) m
--    group by mid_key having count(*) > 1;
-- =====================================================================

-- 0. The merchants this cannot carry, and the functions it was copied from.
do $$
declare
  clash text;
  v3    text := pg_get_functiondef('public.commit_residual_import_v3(int, text[])'::regprocedure);
  dpp   text := pg_get_functiondef('public.delete_payout_period(date, text)'::regprocedure);
  ppa   text := pg_get_functiondef('public.post_payout_adjustment(uuid, text, date, text, numeric, text)'::regprocedure);
  j     text := 'join merchants m on m.mid = r.mid_raw';
  a     text := 'or a.mid in (select l.mid from rep_payout_rows l';
  p     text := 'select * into m from merchants where mid = btrim(mid_input);';
begin
  select string_agg(g.ids, '; ' order by g.k) into clash
    from (select upper(btrim(mid)) as k,
                 string_agg('merchant ' || id || ' (' || mid || ')', ', ' order by id) as ids
            from merchants
           where mid is not null
           group by upper(btrim(mid))
          having count(*) > 1) g;
  if clash is not null then
    raise exception 'alphanumeric_mids refuses to run: these merchants'' MIDs differ only in case or surrounding spaces, so a residual line could not tell them apart: %. Change one MID of each pair (or remove the duplicate merchant), then apply 20261106140000.', clash;
  end if;

  if (length(v3) - length(replace(v3, j, ''))) / length(j) <> 11
     or (length(v3) - length(replace(v3, a, ''))) / length(a) <> 1
     or (length(dpp) - length(replace(dpp, a, ''))) / length(a) <> 1
     or (length(ppa) - length(replace(ppa, p, ''))) / length(p) <> 1 then
    raise exception 'commit_residual_import_v3, delete_payout_period or post_payout_adjustment is not the body 20261106140000 copied (v3 from 20261104140000, the other two from 20261102120000 and 20261030190000). Inspect pg_get_functiondef before applying 20261106140000.';
  end if;
end $$;

-- 1. The key.
create or replace function mid_key(value text)
returns text language sql immutable strict parallel safe as $$
  select upper(btrim(value))
$$;

revoke all on function mid_key(text) from public;
grant execute on function mid_key(text) to authenticated, service_role;

-- 2. One merchant per key.
create unique index merchants_mid_key_ci on merchants (mid_key(mid));

-- 3. The three functions, matching on the key.
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
            or mid_key(a.mid) in (select mid_key(l.mid) from rep_payout_rows l
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
   where mid_key(m.mid) in (select mid_key(r.mid_raw) from rep_payout_import_rows r
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

  select string_agg(d.spellings || ' (rows ' || d.row_list || ')', '; ' order by d.k)
    into problem
    from (select mid_key(r.mid_raw) as k,
                 string_agg(distinct r.mid_raw, ' / ') as spellings,
                 string_agg(r.row_number::text, ', ' order by r.row_number) as row_list
            from rep_payout_import_rows r
           where r.batch_id = batch_id_input
           group by mid_key(r.mid_raw)
          having count(*) > 1) d;
  if problem is not null then
    raise exception 'A MID appears on more than one row: %. Fix the file and upload it again.', problem
      using errcode = 'PT409';
  end if;

  select string_agg(r.mid_raw, ', ' order by r.row_number) into problem
    from rep_payout_import_rows r
   where r.batch_id = batch_id_input
     and not exists (select 1 from merchants m where mid_key(m.mid) = mid_key(r.mid_raw));
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
    join merchants m on mid_key(m.mid) = mid_key(r.mid_raw)
   where r.batch_id = batch_id_input
     and (r.merchant_id is distinct from m.id
          or r.agent_id is distinct from m.agent_id);
  if problem is not null then
    raise exception 'A merchant''s MID or owner changed after this file was read (MIDs %). Read it again.', problem
      using errcode = 'PT409';
  end if;

  select string_agg(r.mid_raw, ', ' order by r.row_number) into problem
    from rep_payout_import_rows r
    join merchants m on mid_key(m.mid) = mid_key(r.mid_raw)
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
      on mid_key(l.mid) = mid_key(r.mid_raw) and l.period = batch.period and l.line_kind = 'import'
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
    join merchants m on mid_key(m.mid) = mid_key(r.mid_raw)
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
    join merchants m on mid_key(m.mid) = mid_key(r.mid_raw)
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
    join merchants m on mid_key(m.mid) = mid_key(r.mid_raw)
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
    join merchants m on mid_key(m.mid) = mid_key(r.mid_raw)
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
      join merchants m on mid_key(m.mid) = mid_key(r.mid_raw)
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
    join merchants m on mid_key(m.mid) = mid_key(r.mid_raw)
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
    join merchants m on mid_key(m.mid) = mid_key(r.mid_raw)
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
    join merchants m on mid_key(m.mid) = mid_key(r.mid_raw)
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
      join merchants m on mid_key(m.mid) = mid_key(r.mid_raw)
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

create or replace function delete_payout_period(
  period_input    date,
  processor_input text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  label   text;
  problem text;
  batch   rep_payout_batches;
  deleted int;
begin
  if not is_admin() then
    raise exception 'admin only' using errcode = 'PT403';
  end if;

  if period_input is null then
    raise exception 'Choose the month to delete.' using errcode = '22023';
  end if;
  if extract(day from period_input) <> 1 then
    raise exception 'A month is given as its first day.' using errcode = '22023';
  end if;

  label := coalesce(processor_input, 'Lines with no processor') || ' for '
           || to_char(period_input, 'FMMonth YYYY');

  perform pg_advisory_xact_lock(hashtext(
    'tapswipe.residual_month:' || coalesce(processor_input, '') || '/' || period_input::text));
  perform pg_advisory_xact_lock(hashtext('tapswipe.merchant_rep_shares'));

  if processor_input is not null and exists (
    select 1 from payout_period_closures
     where period = period_input and processor = processor_input
  ) then
    raise exception '% is marked paid and cannot be deleted. Reopen it (with a reason) first, or post an adjustment instead.', label
      using errcode = 'PT409';
  end if;

  select string_agg(distinct a.mid, ', ') into problem
    from rep_payout_rows a
   where a.line_kind = 'adjustment' and a.adjusts_period = period_input
     and ((processor_input is not null and a.processor = processor_input)
          or mid_key(a.mid) in (select mid_key(l.mid) from rep_payout_rows l
                        where l.period = period_input and l.line_kind = 'import'
                          and l.processor is not distinct from processor_input));
  if problem is not null then
    raise exception 'Adjustments already correct % (MIDs %). They were worked out from these lines, so the month cannot be deleted under them.', label, problem
      using errcode = 'PT409';
  end if;

  -- The import lines and the override lines worked out from them.
  delete from rep_payout_rows
   where period = period_input and line_kind in ('import', 'override')
     and processor is not distinct from processor_input;
  get diagnostics deleted = row_count;

  if deleted = 0 then
    raise exception '% has no lines to delete.', label using errcode = 'PT404';
  end if;

  if processor_input is not null then
    select * into batch from rep_payout_batches
     where processor = processor_input and period = period_input and status = 'committed'
     for update;
    if found then
      update rep_payout_batches set status = 'deleted' where id = batch.id;
    end if;
  end if;

  insert into audit_log (actor_id, action, table_name, row_id, detail)
  values (auth.uid(), 'delete_payout_period', 'rep_payout_rows',
          to_char(period_input, 'YYYY-MM-DD') || '/' || coalesce(processor_input, 'none'),
          deleted || ' lines' || coalesce('; import #' || batch.id, ''));

  return jsonb_build_object('deleted', deleted, 'batch_id', batch.id);
end;
$$;

revoke all on function delete_payout_period(date, text) from public;
revoke all on function delete_payout_period(date, text) from anon;
grant execute on function delete_payout_period(date, text) to authenticated, service_role;

create or replace function post_payout_adjustment(
  agent_id_input       uuid,
  mid_input            text,
  adjusts_period_input date,
  processor_input      text,
  amount_input         numeric,
  note_input           text
)
returns jsonb
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  note    text := btrim(coalesce(note_input, ''));
  label   text;
  payee   profiles;
  m       merchants;
  posting date;
  line_id int;
begin
  if not is_admin() then
    raise exception 'admin only' using errcode = 'PT403';
  end if;

  if agent_id_input is null or mid_input is null or btrim(mid_input) = ''
     or adjusts_period_input is null or processor_input is null
     or amount_input is null then
    raise exception 'Every field is required to post an adjustment.' using errcode = '22023';
  end if;
  if note = '' then
    raise exception 'An adjustment needs a reason. The rep reads it on their statement.'
      using errcode = '22023';
  end if;
  if length(note) > 500 then
    raise exception 'The reason can be at most 500 characters.' using errcode = '22023';
  end if;
  if extract(day from adjusts_period_input) <> 1 then
    raise exception 'The month being adjusted is given as its first day.' using errcode = '22023';
  end if;
  if amount_input = 0 or amount_input <> round(amount_input, 2) then
    raise exception 'The amount is in whole cents and not zero: positive pays the rep, negative takes back.'
      using errcode = '22023';
  end if;
  if abs(amount_input) >= 1000000000000 then
    raise exception 'The amount is too large.' using errcode = '22023';
  end if;

  label := processor_input || ' ' || to_char(adjusts_period_input, 'FMMonth YYYY');

  perform pg_advisory_xact_lock(hashtext(
    'tapswipe.residual_month:' || processor_input || '/' || adjusts_period_input::text));
  perform pg_advisory_xact_lock(hashtext('tapswipe.merchant_rep_shares'));

  if not exists (select 1 from payout_period_closures
                  where period = adjusts_period_input and processor = processor_input) then
    raise exception '% is not marked paid. Until it is, a correction is a replace: upload the corrected file for that month.', label
      using errcode = 'PT409';
  end if;

  select * into payee from profiles where id = agent_id_input;
  if not found then
    raise exception 'rep not found' using errcode = 'PT404';
  end if;
  if not payee.is_active then
    raise exception '% is deactivated, so an adjustment cannot name them.', payee.full_name
      using errcode = 'PT409';
  end if;

  select * into m from merchants where mid_key(mid) = mid_key(mid_input);
  if not found then
    raise exception 'MID % is not a merchant in the CRM.', btrim(mid_input) using errcode = 'PT404';
  end if;

  select (max(period) + interval '1 month')::date into posting
    from rep_payout_rows where line_kind = 'import';

  insert into rep_payout_rows (
    agent_id, period, processor, mid, merchant_name, merchant_id,
    line_kind, adjustment_amount, adjusts_period, adjustment_note
  )
  values (
    agent_id_input, posting, processor_input, m.mid, m.dba, m.id,
    'adjustment', amount_input, adjusts_period_input, note
  )
  returning id into line_id;

  insert into audit_log (actor_id, action, table_name, row_id)
  values (auth.uid(), 'post_payout_adjustment', 'rep_payout_rows', line_id::text);

  return jsonb_build_object(
    'line_id', line_id,
    'posting_period', to_char(posting, 'YYYY-MM-DD'),
    'amount', amount_input
  );
end;
$$;

revoke all on function post_payout_adjustment(uuid, text, date, text, numeric, text) from public;
revoke all on function post_payout_adjustment(uuid, text, date, text, numeric, text) from anon;
grant execute on function post_payout_adjustment(uuid, text, date, text, numeric, text)
  to authenticated, service_role;
