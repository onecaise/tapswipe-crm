-- merchant_rep_shares: two reps sharing one account's residual, and the three
-- admin-only RPCs that are its only write path. Phase 2 of
-- docs/design/residual-splits.md.
--
-- Matches docs/tapswipe_crm_schema.sql, updated first; the block below is
-- copied from it verbatim.
--
-- =====================================================================
-- MERCHANT REP SHARES — two reps sharing one account's residual
-- (20261014130000). Design: docs/design/residual-splits.md §3, §8.
--
-- The owner's rule: on every account the rep side is 50% of the residual and
-- the company keeps 50%. When two reps worked an account and one signed it,
-- an admin divides that 50 between them in any ratio (25+25, 40+10, ...). The
-- company's 50 never changes. A row here says: for this merchant, from month
-- X (until month Y), the rep side is divided signer:partner.
--
-- Nothing reads this table yet. Phase 3 snapshots it onto ledger lines and
-- phase 4 makes the commit apply it; this phase is the table and its guards.
--
-- WHAT IS STORED IS WHAT THE ADMIN TYPED, in rep-percent terms: 40 and 10,
-- not 80% and 20%. Nothing is rescaled, so nothing is rounded at entry; the
-- ratio is applied in whole cents by shared_part() at payout time.
--
-- STRUCTURE IS THE GUARD for the two rules that must never break:
--   * at most two reps   -- two columns, not a junction table;
--   * shares total 50    -- a CHECK on the pair.
-- Neither needs a trigger, and neither can be violated by any writer, the
-- owner included.
--
-- NO OVERLAP per merchant is an exclusion constraint over
-- daterange(effective_from, effective_to) -- '[)' bounds, NULL upper meaning
-- open-ended. It needs btree_gist for the `merchant_id with =` half. The RPCs
-- check overlap first so an admin reads a sentence; the constraint is the
-- backstop that holds for a writer that skips them.
--
-- NO agent_id COLUMN, a documented deviation like rep_payout_batches.
-- imported_by: a share has two reps, and the standard own-row policy would be
-- wrong for either of them. No created_by either -- audit_log records the
-- actor, and every extra profiles FK is one more entry in four teardown lists.
-- That leaves TWO new references to profiles(id), both NO ACTION, taking the
-- schema's count from 23 to 25.
--
-- merchant_id is ON DELETE RESTRICT: a merchant with a share cannot be
-- deleted. A share is a payroll record, and `cascade` would erase it while
-- `set null` would leave a share about nothing.
--
-- THE MONTH RULE, enforced by every RPC below: no boundary -- a start, an end,
-- a cancellation -- may fall at or before the latest month already in the
-- ledger for that merchant's MID. So a share edit can never change a committed
-- figure; a share agreed after a month was committed is corrected with an
-- adjustment pair (design §6), never by back-dating. "Committed for that MID"
-- is any rep_payout_rows row with this merchant_id OR this mid: merchant_id is
-- only the soft link resolved at parse time, and a row whose MID matched no
-- merchant then still counts.
--
-- ROWS ARE IMMUTABLE except effective_to. A different ratio or a different
-- rep is an end plus a new share, which set_merchant_rep_share does in one
-- call -- so the table itself is the history.
--
-- WRITES ONLY THROUGH THE THREE RPCs BELOW. authenticated holds SELECT alone,
-- backed by an admin-only policy; no INSERT, UPDATE or DELETE grant exists, so
-- a direct write fails as "permission denied" rather than being filtered.
--
-- NOT AUDITED BY log_cross_agent_change(): there is no agent_id for it to
-- read, and only admins write, so it would fire on every write. Each RPC
-- writes its own audit_log row instead, failing closed.
-- =====================================================================
create schema if not exists extensions;
create extension if not exists btree_gist with schema extensions;

create table merchant_rep_shares (
  id serial primary key,
  merchant_id int not null references merchants(id) on delete restrict,
  -- The signer: the rep the processor's file names under Agent # for this MID.
  primary_agent_id   uuid not null references profiles(id),
  -- The partner.
  secondary_agent_id uuid not null references profiles(id),
  -- Each rep's share of the 50-point rep side, exactly as typed.
  primary_rep_pct   numeric(5,2) not null,
  secondary_rep_pct numeric(5,2) not null,
  -- First payout month the share applies to (1st of the month).
  effective_from date not null,
  -- EXCLUSIVE: the first month it no longer applies. NULL = open-ended.
  effective_to   date,
  created_at timestamptz not null default now(),
  constraint merchant_rep_shares_two_reps
    check (primary_agent_id <> secondary_agent_id),
  constraint merchant_rep_shares_positive
    check (primary_rep_pct > 0 and secondary_rep_pct > 0),
  constraint merchant_rep_shares_total_rep_side
    check (primary_rep_pct + secondary_rep_pct = 50.00),
  constraint merchant_rep_shares_from_first_of_month
    check (extract(day from effective_from) = 1),
  constraint merchant_rep_shares_to_first_of_month
    check (effective_to is null
           or (extract(day from effective_to) = 1 and effective_to > effective_from)),
  constraint merchant_rep_shares_no_overlap
    exclude using gist (merchant_id with =,
                        daterange(effective_from, effective_to) with &&)
);

alter table merchant_rep_shares enable row level security;

-- Admins only. A rep learns about their own share from their own ledger line
-- (phase 3) and from a narrow read function (phase 6) -- never from this table,
-- which names the other rep and the other rep's share.
create policy "admin only select" on merchant_rep_shares
  for select using (is_admin());

grant select on merchant_rep_shares to authenticated;
grant all on merchant_rep_shares to service_role;
-- service_role only, like the rep_payout sequences: authenticated holds no
-- INSERT, and the RPCs run as the owner.
grant usage on merchant_rep_shares_id_seq to service_role;

-- ---------------------------------------------------------------------
-- The three write RPCs. All `security definer` (the table grants no write to
-- authenticated, and audit_log no insert to anyone), each with a hand-written
-- is_admin() guard at the top -- definer bypasses RLS, so a guard deleted here
-- fails open silently.
--
-- Every one takes pg_advisory_xact_lock(hashtext('tapswipe.merchant_rep_shares'))
-- before reading anything. The residual commit path takes the SAME lock from
-- phase 4 on, so a share edit and a commit for the same month cannot
-- interleave: without it, each could check the other's state before the other
-- committed, and a share could start at a month that was being committed
-- without it. Two connections are needed to see that race, so PGlite cannot;
-- it is checked by hand against real Postgres, as 20260821171000 was.
--
-- Error codes follow the house shape: PT403 not an admin, PT404 not found,
-- PT409 a conflict with existing state, 22023 a bad argument. Messages are
-- sentences an admin can act on; lib/db-errors.ts passes PT codes through.
-- ---------------------------------------------------------------------

-- set_merchant_rep_share: start a share from a month. If an open share
-- exists on the merchant and started earlier, it is ended at that month in the
-- same transaction -- so "change the ratio from November" is one call, and the
-- table reads as the history of the account.
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

  if primary_rep_pct_input <> round(primary_rep_pct_input, 2)
     or secondary_rep_pct_input <> round(secondary_rep_pct_input, 2)
     or primary_rep_pct_input <= 0 or secondary_rep_pct_input <= 0
     or primary_rep_pct_input + secondary_rep_pct_input <> 50 then
    raise exception 'The two shares must each be above 0, in hundredths at most, and add up to the rep side: 50.'
      using errcode = '22023';
  end if;

  if extract(day from effective_from_input) <> 1 then
    raise exception 'A share starts on the first day of a month.'
      using errcode = '22023';
  end if;

  select max(period) into latest
    from rep_payout_rows
   where merchant_id = m.id or mid = m.mid;

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

-- end_merchant_rep_share: the share stops applying FROM effective_to_input
-- (exclusive). Also moves an existing end, in either direction, provided both
-- the old and the new boundary are still in uncommitted months -- an end that a
-- committed month already sits on is settled.
create or replace function end_merchant_rep_share(
  share_id_input     int,
  effective_to_input date
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  s      merchant_rep_shares;
  m      merchants;
  latest date;
begin
  if not is_admin() then
    raise exception 'admin only' using errcode = 'PT403';
  end if;

  perform pg_advisory_xact_lock(hashtext('tapswipe.merchant_rep_shares'));

  if share_id_input is null or effective_to_input is null then
    raise exception 'A share and an end month are required.'
      using errcode = '22023';
  end if;

  select * into s from merchant_rep_shares where id = share_id_input;
  if not found then
    raise exception 'share not found' using errcode = 'PT404';
  end if;

  if extract(day from effective_to_input) <> 1 then
    raise exception 'A share ends on the first day of a month.'
      using errcode = '22023';
  end if;

  if effective_to_input <= s.effective_from then
    raise exception 'A share has to end after the month it starts. To remove it entirely, cancel it.'
      using errcode = '22023';
  end if;

  select * into m from merchants where id = s.merchant_id;
  select max(period) into latest
    from rep_payout_rows
   where merchant_id = m.id or mid = m.mid;

  if latest is not null and effective_to_input <= latest then
    raise exception '% is already committed for this MID. A share can only end after it.',
      to_char(latest, 'FMMonth YYYY')
      using errcode = 'PT409';
  end if;

  if latest is not null and s.effective_to is not null and s.effective_to <= latest then
    raise exception 'This share already ended before a committed month, so its end is settled.'
      using errcode = 'PT409';
  end if;

  if exists (
    select 1 from merchant_rep_shares
     where merchant_id = s.merchant_id
       and id <> s.id
       and daterange(effective_from, effective_to)
           && daterange(s.effective_from, effective_to_input)
  ) then
    raise exception 'That end month overlaps another share on this merchant.'
      using errcode = 'PT409';
  end if;

  update merchant_rep_shares
     set effective_to = effective_to_input
   where id = s.id;

  insert into audit_log (actor_id, action, table_name, row_id)
  values (auth.uid(), 'end_merchant_rep_share', 'merchant_rep_shares',
          s.id::text);
end;
$$;

revoke all on function end_merchant_rep_share(int, date) from public;
grant execute on function end_merchant_rep_share(int, date)
  to authenticated, service_role;

-- cancel_merchant_rep_share: deletes a share that was never used -- one with
-- no committed month inside it. Once any month in its range is committed, the
-- share is part of how that month was paid, and the answer is to end it.
-- (Phase 3 adds rep_payout_rows.rep_share_id ON DELETE RESTRICT as the
-- backstop; until then this check is the whole guard, and it is equivalent:
-- a line can only reference a share if its month falls inside it.)
create or replace function cancel_merchant_rep_share(share_id_input int)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  s      merchant_rep_shares;
  m      merchants;
  latest date;
begin
  if not is_admin() then
    raise exception 'admin only' using errcode = 'PT403';
  end if;

  perform pg_advisory_xact_lock(hashtext('tapswipe.merchant_rep_shares'));

  select * into s from merchant_rep_shares where id = share_id_input;
  if not found then
    raise exception 'share not found' using errcode = 'PT404';
  end if;

  select * into m from merchants where id = s.merchant_id;
  select max(period) into latest
    from rep_payout_rows
   where merchant_id = m.id or mid = m.mid;

  if latest is not null and s.effective_from <= latest then
    raise exception 'A month in this share is already committed, so it cannot be cancelled. End it instead.'
      using errcode = 'PT409';
  end if;

  delete from merchant_rep_shares where id = s.id;

  insert into audit_log (actor_id, action, table_name, row_id)
  values (auth.uid(), 'cancel_merchant_rep_share', 'merchant_rep_shares',
          s.id::text);
end;
$$;

revoke all on function cancel_merchant_rep_share(int) from public;
grant execute on function cancel_merchant_rep_share(int)
  to authenticated, service_role;
