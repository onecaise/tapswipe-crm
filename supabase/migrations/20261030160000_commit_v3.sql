-- The residual commit under the owner rule: commit_residual_import_v3 with
-- the merchant's rate, commit_residual_import_v2 dropped, the merchant rate
-- CHECK and set_merchant_split, and the share signer held to the owner.
-- Phase 8 of docs/design/intake-and-reports.md.
--
-- Matches docs/tapswipe_crm_schema.sql, updated first; the block below is
-- copied from it verbatim.
--
-- =====================================================================
-- COMMIT V3 (20261030160000) — the residual commit under the owner rule,
-- with the merchant's rate. Phase 8 of docs/design/intake-and-reports.md
-- (§1.C, §2.3-2.5, §0b.4, A21, A22, A25, A26, A28).
--
-- commit_residual_import_v3(batch_id_input int, confirmed_input text[])
--   returns jsonb {written, rows, shared, overrides, replaced_lines}
--   `security definer`, search_path public, pg_temp, is_admin() FIRST. The
--   only commit the app calls. commit_residual_import_v2 is DROPPED here (no
--   hosted project ever had it); commit_residual_import(int) stays, untouched,
--   until phase 13 drops it with the app that called it.
--
--   ONE TRANSACTION, in this order:
--   1. Locks. The batch row FOR UPDATE (two commits of one batch: the second
--      waits, then sees 'committed' and refuses); an advisory lock on the
--      batch's processor-month, so two DIFFERENT batches for one
--      processor-month cannot both pass the "nothing committed yet" check
--      (the unique index rep_payout_batches_one_committed_per_month is the
--      backstop); the share lock every share RPC takes; and FOR SHARE on
--      every merchant the file names, so no owner, MID or rate can change
--      under the commit.
--   2. Guards. Status 'review'; a processor and month; no other committed
--      batch for that processor-month (PT409, naming it: a second file is a
--      replace, phase 9); at least one staged row; no blocked row.
--   3. RE-DERIVED FROM THE DATABASE, never trusted from staging. Each refuses
--      PT409 and lists what it found:
--        a staged row read for another month than the batch's;
--        a blank MID; a MID on two rows; a MID that is no merchant;
--        an Income Type other than Residuals (case and surrounding space
--          ignored, the parser's rule);
--        a missing Volume or Residual;
--        THE OWNER CHANGED: a staged merchant_id or agent_id that is not the
--          merchant's current one. REFUSED, never re-paid: "A merchant's MID
--          or owner changed after this file was read. Read it again." (memo
--          §2.3 step 2; closes the security follow-up "Block a staged
--          residual row whose merchant's MID changed");
--        a merchant with no split rate (set it with set_merchant_split);
--        an import line already in the ledger for that MID and month,
--          whatever its processor -- NO MERGE (below);
--        a share covering the month whose signer is not the merchant's
--          owner, or whose two shares do not total the merchant's rate
--          (backstops for rows that predate the guards below).
--   4. THE WARNINGS ARE RECOMPUTED (the parser's rule, _shared/residuals.ts
--      rowWarnings, which this mirrors and the live suite pins):
--        processor_mismatch  the file's Processor cell is not the batch's
--                            (case and runs of whitespace ignored; a blank
--                            cell differs), or the merchant HAS a processor
--                            and it is not the batch's. No processor on the
--                            merchant is not a mismatch (A6).
--        inactive_merchant   merchants.status = 'inactive' (not 'other', A26).
--        bad_numbers         volume <= 0, or residual > volume. A negative
--                            residual on a positive volume is a clawback,
--                            not a warning (A25).
--      Any type present that is not in confirmed_input refuses PT409, naming
--      it with its rows; DETAIL carries the codes. One yes covers every row
--      of its type (memo §0b.3). confirmed_input must hold only those three
--      codes (22023 otherwise); NULL means none. What was confirmed is kept
--      on the batch: confirmed_warnings = {"bad_numbers": [4, 7], ...}, the
--      types present and the sheet rows each covered.
--   5. THE LINES, PLAIN INSERTS, NEVER A MERGE. No ON CONFLICT anywhere in
--      v3: the coalesce(excluded, existing) merge rule is retired on this
--      path, because a processor-month is committed once and changes only
--      by replace (phase 9, until paid) or by an adjustment line (after).
--      Every line takes period and processor from the BATCH, merchant_id,
--      mid and merchant_name (dba) from the MERCHANT, residual_income and
--      volume from the file, and rep_split_pct = merchants.split_agent_pct,
--      the merchant's own snapshot rate (memo §0b.4). The money is then
--      rep_payout's existing expression: rep amount T =
--      round(R * rate / 100, 2), company R - T. A rate of 0 (the house)
--      still writes its line, rep_payout 0.00, so volume and net show.
--        * unshared: one line, the owner's.
--        * shared (a share covers the batch month): the signer's line
--          (volume, account_residual_income = R, residual piece R - p) and
--          the partner's (no volume, piece p = shared_part(R, b, a + b)),
--          both carrying the share snapshot. The two shares total the
--          merchant's rate, so the partner's payout is shared_part(T, b, s)
--          and the signer's T minus it: the existing cent rule, the signer
--          absorbing the odd cent. Nothing is left blank for an admin.
--      volume_confirmed_negative is set exactly where volume < 0. Such a
--      line can only get here through a confirmed bad_numbers (step 4), so
--      the marker means "an admin confirmed this negative volume", and the
--      ledger CHECK (volume_confirmed_negative = coalesce(volume < 0,
--      false)) holds.
--   6. OVERRIDES PLUG IN HERE (phase 10): override lines for the month are
--      written after the import lines, from the same merchant rows, and
--      counted in `overrides`. Nothing else in v3 has to move: an override
--      is its own pair of lines, never a change to T.
--   7. Staging deleted; the batch set committed with committed_at (when),
--      row_count = staged rows, skipped_rows = '[]' (v3 skips nothing: a row
--      is committed or the import is refused) and confirmed_warnings. ONE
--      audit_log row, 'commit_residual_import' on rep_payout_batches,
--      actor auth.uid() (who). Fails closed.
--
-- MERCHANT RATE. merchants_split_zero_to_fifty: the agent rate is NULL with
--   the company half NULL, or between 0 and 50 with the company half exactly
--   100 minus it (memo §0b.4, §0c.2; deferred from phase 4). Validated: the
--   migration first refuses, by id, any merchant outside it.
--   set_merchant_split(merchant_id_input int, rate_input numeric) is the
--   ONLY write path to the two split columns, the set_rep_split shape:
--   security definer, search_path public, pg_temp, is_admin() first,
--   0-50 in hundredths, the share lock, REFUSED while the merchant has a
--   live share (below), audited 'set_merchant_split' (merchants, id), no
--   exception handler. A same-value call is a no-op with no audit row.
--   guard_merchant_split_and_owner() (BEFORE UPDATE OF agent_id,
--   split_agent_pct, split_company_pct) refuses any other change to the two
--   columns, an admin's included (transaction-local flag
--   tapswipe.merchant_split_write, set only by set_merchant_split). INSERT
--   is not guarded: approve_pre_app() snapshots the pre-app's rate, and a
--   merchant an admin creates by hand starts with none, which v3 refuses
--   until set_merchant_split gives it one.
--
-- SHARES UNDER THE OWNER RULE (memo §2.5, A22, A28).
--   * merchant_rep_shares_total_rep_side becomes `<= 50.00` (it was
--     `= 50.00`); the real rule, the two shares total the MERCHANT'S rate,
--     reads merchants and so lives in set_merchant_rep_share(), and holds
--     over time because set_merchant_split refuses while a share is live.
--     rep_payout_rows_share_snapshot is relaxed the same way.
--   * set_merchant_rep_share() also refuses a signer who is not the
--     merchant's current owner, a merchant with no rate, and a merchant at
--     rate 0 (A28: nothing to divide).
--   * guard_merchant_split_and_owner() refuses moving a merchant
--     (agent_id) while it has a live share: PT409 "This merchant has a
--     shared-account split. End it before moving the merchant."
--   A share is LIVE when it could still pay a month: open-ended, or ending
--   after the latest month that has an import line for the merchant (any
--   month, if none has) -- merchant_has_live_share(). Corrections
--   (post_share_correction) and adjustment lines are untouched.
--
-- REFUSES TO RUN, naming them, over: merchants whose rate is outside
-- 0-50 or whose company half does not match; and definitions it replaces
-- that are not the ones it expects (the two share CHECKs). Not "the tables
-- must be empty".
-- =====================================================================

-- 0. What this migration cannot carry, named; then the definitions it
-- replaces, checked.
do $$
declare
  bad text;
  definition text;
begin
  select string_agg(id::text, ', ' order by id) into bad
    from merchants
   where not ((split_agent_pct is null and split_company_pct is null)
              or (split_agent_pct between 0 and 50
                  and split_company_pct = 100 - split_agent_pct));
  if bad is not null then
    raise exception 'commit v3 migration refuses to run: merchants % have a split rate outside 0-50, or a company half that is not 100 minus it. Set each one deliberately (the rate is money owed), then re-run.', bad;
  end if;

  select pg_get_constraintdef(oid) into definition from pg_constraint
   where conrelid = 'public.merchant_rep_shares'::regclass
     and conname = 'merchant_rep_shares_total_rep_side';
  if definition is distinct from 'CHECK (((primary_rep_pct + secondary_rep_pct) = 50.00))' then
    raise exception 'merchant_rep_shares_total_rep_side is not the "= 50.00" CHECK here (found: %). Inspect it before applying 20261030160000.',
      coalesce(definition, 'no such constraint');
  end if;

  select pg_get_constraintdef(oid) into definition from pg_constraint
   where conrelid = 'public.rep_payout_rows'::regclass
     and conname = 'rep_payout_rows_share_snapshot';
  if definition is distinct from 'CHECK (((primary_rep_pct IS NULL) OR ((primary_rep_pct > (0)::numeric) AND (secondary_rep_pct > (0)::numeric) AND ((primary_rep_pct + secondary_rep_pct) = 50.00))))' then
    raise exception 'rep_payout_rows_share_snapshot is not the "= 50.00" CHECK here (found: %). Inspect it before applying 20261030160000.',
      coalesce(definition, 'no such constraint');
  end if;
end $$;

-- 1. The merchant's rate: 0 to 50, the company half matching.
alter table merchants
  add constraint merchants_split_zero_to_fifty check (
    (split_agent_pct is null and split_company_pct is null)
    or (split_agent_pct between 0 and 50
        and split_company_pct = 100 - split_agent_pct)
  );

-- 2. The two shares total at most 50; set_merchant_rep_share() holds them
-- to the merchant's rate.
alter table merchant_rep_shares drop constraint merchant_rep_shares_total_rep_side;
alter table merchant_rep_shares
  add constraint merchant_rep_shares_total_rep_side
    check (primary_rep_pct + secondary_rep_pct <= 50.00);

alter table rep_payout_rows drop constraint rep_payout_rows_share_snapshot;
alter table rep_payout_rows
  add constraint rep_payout_rows_share_snapshot check (
    primary_rep_pct is null
    or (primary_rep_pct > 0 and secondary_rep_pct > 0
        and primary_rep_pct + secondary_rep_pct <= 50.00)
  );

-- 3. What a commit confirmed, kept on its batch.
alter table rep_payout_batches
  add column confirmed_warnings jsonb
    constraint rep_payout_batches_confirmed_warnings_shape
      check (confirmed_warnings is null
             or (jsonb_typeof(confirmed_warnings) = 'object'
                 and status in ('committed', 'replaced')));

-- 4. A live share: one that could still pay a month. Invoker, and no client
-- may call it; its callers are definer functions and a definer trigger.
create or replace function merchant_has_live_share(merchant_id_input int)
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select exists (
    select 1
      from merchant_rep_shares s
      join merchants m on m.id = s.merchant_id
     where s.merchant_id = merchant_id_input
       and (s.effective_to is null
            or s.effective_to > coalesce(
                 (select max(l.period) from rep_payout_rows l
                   where (l.merchant_id = m.id or l.mid = m.mid)
                     and l.line_kind = 'import'),
                 '-infinity'::date))
  );
$$;

revoke all on function merchant_has_live_share(int) from public;
revoke all on function merchant_has_live_share(int) from anon, authenticated;

-- 5. The merchant's rate and owner are not edited directly. Definer, so it
-- reads merchant_rep_shares whoever is writing; it writes nothing.
create or replace function guard_merchant_split_and_owner()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
begin
  if (new.split_agent_pct is distinct from old.split_agent_pct
      or new.split_company_pct is distinct from old.split_company_pct)
     and coalesce(current_setting('tapswipe.merchant_split_write', true), '') <> 'on' then
    raise exception 'A merchant''s split rate is changed only with its Split control (set_merchant_split), which records who changed it.'
      using errcode = 'PT409';
  end if;

  if new.agent_id is distinct from old.agent_id
     and merchant_has_live_share(old.id) then
    raise exception 'This merchant has a shared-account split. End it before moving the merchant.'
      using errcode = 'PT409';
  end if;

  return new;
end;
$$;

revoke all on function guard_merchant_split_and_owner() from public;
revoke all on function guard_merchant_split_and_owner() from anon, authenticated;

create trigger merchants_guard_split_and_owner
  before update of agent_id, split_agent_pct, split_company_pct on merchants
  for each row execute function guard_merchant_split_and_owner();

-- 6. set_merchant_split: the one write path to the merchant's rate.
create or replace function set_merchant_split(merchant_id_input int, rate_input numeric)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  m merchants;
begin
  if not is_admin() then
    raise exception 'admin only' using errcode = 'PT403';
  end if;

  if rate_input is null then
    raise exception 'a split rate is required' using errcode = 'PT400';
  end if;
  if rate_input < 0 or rate_input > 50 then
    raise exception 'the split rate must be between 0 and 50' using errcode = 'PT400';
  end if;
  if rate_input <> round(rate_input, 2) then
    raise exception 'the split rate has at most two decimal places' using errcode = 'PT400';
  end if;

  -- The share lock: a share set and a rate change cannot interleave, so the
  -- two shares keep totalling the rate.
  perform pg_advisory_xact_lock(hashtext('tapswipe.merchant_rep_shares'));

  select * into m from merchants where id = merchant_id_input for update;
  if not found then
    raise exception 'merchant not found' using errcode = 'PT404';
  end if;

  if m.split_agent_pct = rate_input then
    return;
  end if;

  if merchant_has_live_share(m.id) then
    raise exception 'This merchant has a shared-account split, which divides its current rate. End the share before changing the rate.'
      using errcode = 'PT409';
  end if;

  perform set_config('tapswipe.merchant_split_write', 'on', true);
  update merchants
     set split_agent_pct = rate_input,
         split_company_pct = 100 - rate_input
   where id = m.id;
  perform set_config('tapswipe.merchant_split_write', '', true);

  insert into audit_log (actor_id, action, table_name, row_id)
  values (auth.uid(), 'set_merchant_split', 'merchants', m.id::text);
end;
$$;

revoke all on function set_merchant_split(int, numeric) from public;
revoke all on function set_merchant_split(int, numeric) from anon;
grant execute on function set_merchant_split(int, numeric) to authenticated, service_role;

-- 7. set_merchant_rep_share: the signer is the owner, and the two shares
-- total the merchant's rate. Otherwise the body of 20261016160000.
create or replace function set_merchant_rep_share(
  merchant_id_input        int,
  primary_agent_id_input   uuid,
  secondary_agent_id_input uuid,
  primary_rep_pct_input    numeric,
  secondary_rep_pct_input  numeric,
  effective_from_input     date
)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  m          merchants;
  rep        profiles;
  owner_name text;
  latest     date;
  open_share merchant_rep_shares;
  new_id     int;
begin
  if not is_admin() then
    raise exception 'admin only' using errcode = 'PT403';
  end if;

  perform pg_advisory_xact_lock(hashtext('tapswipe.merchant_rep_shares'));

  if merchant_id_input is null or primary_agent_id_input is null
     or secondary_agent_id_input is null or primary_rep_pct_input is null
     or secondary_rep_pct_input is null or effective_from_input is null then
    raise exception 'Every field is required to set a shared account.'
      using errcode = '22023';
  end if;

  select * into m from merchants where id = merchant_id_input;
  if not found then
    raise exception 'merchant not found' using errcode = 'PT404';
  end if;

  if m.mid is null or btrim(m.mid) = '' then
    raise exception 'This merchant has no MID, so no residual could ever match a share on it. Add the MID first.'
      using errcode = 'PT409';
  end if;

  if primary_agent_id_input = secondary_agent_id_input then
    raise exception 'The signer and the partner must be two different reps.'
      using errcode = '22023';
  end if;

  -- Both reps must exist and be active. A NEW share naming someone who has
  -- left is almost certainly a mistake (design §9, Q10); an existing share
  -- keeps paying a rep deactivated later, which is a different question.
  for rep in
    select * from profiles
     where id in (primary_agent_id_input, secondary_agent_id_input)
  loop
    if not rep.is_active then
      raise exception '% is deactivated, so a new share cannot name them.', rep.full_name
        using errcode = 'PT409';
    end if;
  end loop;
  if (select count(*) from profiles
       where id in (primary_agent_id_input, secondary_agent_id_input)) <> 2 then
    raise exception 'rep not found' using errcode = 'PT404';
  end if;

  -- The owner rule (memo §2.5, A22): residuals are paid to the merchant's
  -- owner, so the owner is the only possible signer.
  if primary_agent_id_input <> m.agent_id then
    select full_name into owner_name from profiles where id = m.agent_id;
    raise exception 'The signer of a shared account is the merchant''s owner, %. Name them as the signer, or move the merchant first.',
      coalesce(owner_name, 'its owner')
      using errcode = 'PT409';
  end if;

  if m.split_agent_pct is null then
    raise exception 'This merchant has no split rate yet. Set its rate before sharing it.'
      using errcode = 'PT409';
  end if;

  if m.split_agent_pct = 0 then
    raise exception 'This merchant''s rate is 0, so there is no rep side to share.'
      using errcode = 'PT409';
  end if;

  if primary_rep_pct_input <> round(primary_rep_pct_input, 2)
     or secondary_rep_pct_input <> round(secondary_rep_pct_input, 2)
     or primary_rep_pct_input <= 0 or secondary_rep_pct_input <= 0
     or primary_rep_pct_input + secondary_rep_pct_input <> m.split_agent_pct then
    raise exception 'The two shares must each be above 0, in hundredths at most, and add up to this merchant''s rate: %.',
      trim_scale(m.split_agent_pct)
      using errcode = '22023';
  end if;

  if extract(day from effective_from_input) <> 1 then
    raise exception 'A share starts on the first day of a month.'
      using errcode = '22023';
  end if;

  select max(period) into latest
    from rep_payout_rows
   where (merchant_id = m.id or mid = m.mid)
     and line_kind = 'import';

  if latest is not null and effective_from_input <= latest then
    raise exception '% is already committed for this MID. A share can only start after it; earlier months are corrected with an adjustment.',
      to_char(latest, 'FMMonth YYYY')
      using errcode = 'PT409';
  end if;

  select * into open_share
    from merchant_rep_shares
   where merchant_id = m.id and effective_to is null;

  if found then
    if open_share.effective_from >= effective_from_input then
      raise exception 'This merchant already has a share starting %. Cancel or end that one first.',
        to_char(open_share.effective_from, 'FMMonth YYYY')
        using errcode = 'PT409';
    end if;

    update merchant_rep_shares
       set effective_to = effective_from_input
     where id = open_share.id;

    insert into audit_log (actor_id, action, table_name, row_id)
    values (auth.uid(), 'end_merchant_rep_share', 'merchant_rep_shares',
            open_share.id::text);
  end if;

  -- Overlap with a share that is already closed but runs past the new start
  -- (one ended in the future). The new share is open-ended, so anything
  -- reaching past effective_from_input collides.
  if exists (
    select 1 from merchant_rep_shares
     where merchant_id = m.id
       and daterange(effective_from, effective_to)
           && daterange(effective_from_input, null)
  ) then
    raise exception 'That month overlaps another share on this merchant.'
      using errcode = 'PT409';
  end if;

  insert into merchant_rep_shares (
    merchant_id, primary_agent_id, secondary_agent_id,
    primary_rep_pct, secondary_rep_pct, effective_from
  )
  values (
    m.id, primary_agent_id_input, secondary_agent_id_input,
    primary_rep_pct_input, secondary_rep_pct_input, effective_from_input
  )
  returning id into new_id;

  insert into audit_log (actor_id, action, table_name, row_id)
  values (auth.uid(), 'set_merchant_rep_share', 'merchant_rep_shares',
          new_id::text);

  return new_id;
end;
$$;

revoke all on function set_merchant_rep_share(int, uuid, uuid, numeric, numeric, date)
  from public;
grant execute on function set_merchant_rep_share(int, uuid, uuid, numeric, numeric, date)
  to authenticated, service_role;

-- 8. v2 goes; v3 is the commit.
drop function commit_residual_import_v2(int);

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
  staged      int;
  blocked     int;
  problem     text;
  unconfirmed text[];
  covered     jsonb;
  unshared    int;
  signers     int;
  partners    int;
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

  select * into other
    from rep_payout_batches
   where processor = batch.processor and period = batch.period
     and status = 'committed' and id <> batch.id;
  if found then
    raise exception '% for % is already committed (import #%). A second file for that month replaces it, which is not available yet.',
      batch.processor, to_char(batch.period, 'FMMonth YYYY'), other.id
      using errcode = 'PT409';
  end if;

  perform pg_advisory_xact_lock(hashtext('tapswipe.merchant_rep_shares'));

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

  select string_agg(distinct r.mid_raw, ', ') into problem
    from rep_payout_import_rows r
    join rep_payout_rows l
      on l.mid = r.mid_raw and l.period = batch.period and l.line_kind = 'import'
   where r.batch_id = batch_id_input;
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
        ('bad_numbers', r.volume <= 0 or r.residual_income > r.volume)
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

  -- 5. The lines. Plain inserts, never a merge.
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

  -- 6. PHASE 10: override lines go here, from the same rows, counted in
  -- `overrides` below.

  -- 7. Close the batch, and the audit row.
  delete from rep_payout_import_rows where batch_id = batch_id_input;

  update rep_payout_batches
     set status = 'committed', committed_at = now(), row_count = staged,
         skipped_rows = '[]'::jsonb,
         confirmed_warnings = coalesce(covered, '{}'::jsonb)
   where id = batch_id_input;

  insert into audit_log (actor_id, action, table_name, row_id)
  values (auth.uid(), 'commit_residual_import', 'rep_payout_batches',
          batch_id_input::text);

  return jsonb_build_object(
    'written', unshared + signers + partners,
    'rows', staged,
    'shared', signers,
    'overrides', 0,
    'replaced_lines', 0
  );
end;
$$;

-- PUBLIC (which includes anon) gets EXECUTE on every new function and nothing
-- declarative revokes it. A rep holds EXECUTE through authenticated and is
-- refused by the is_admin() guard.
revoke all on function commit_residual_import_v3(int, text[]) from public;
revoke all on function commit_residual_import_v3(int, text[]) from anon;
grant execute on function commit_residual_import_v3(int, text[]) to authenticated, service_role;
