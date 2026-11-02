-- Overrides: merchant_overrides, its three admin functions, the override
-- lines commit v3 writes, and the cross-book name read. Phase 10 of
-- docs/design/intake-and-reports.md.
--
-- Matches docs/tapswipe_crm_schema.sql, updated first; the block below is
-- copied from it verbatim.
--
-- =====================================================================
-- MERCHANT OVERRIDES (20261102120000) — phase 10 of
-- docs/design/intake-and-reports.md (§4, §0.1, §0b.5, A4a-A4f, A25, A29).
--
-- AN OVERRIDE is a percent o of the merchant's FULL residual R, taken out of
-- the rep side and paid to a named person (the owner's manager by default,
-- otherwise any named active person; never the rep, nor either party of a
-- shared account). 0 < o <= the merchant's rate s, in hundredths. The
-- company's share, R - T with T = round(R * s / 100, 2), never moves:
--   R = $100, s = 50, o = 10:  rep side T = 50.00, of which the rep keeps
--   40.00 and the recipient gets 10.00; the company keeps 50.00.
--
-- 1. merchant_overrides (id, merchant_id, recipient_id, override_pct,
--    effective_from, effective_to, created_at) -- the shape of
--    merchant_rep_shares:
--      * override_pct CHECK > 0 and <= 50, the OUTER bound only (no rate is
--        above 50). The real cap, <= the merchant's split_agent_pct, reads
--        merchants, so set_merchant_override() enforces it, set_merchant_split
--        refuses a rate below a live override (A29), and commit v3 re-checks
--        it per row. Move the three together.
--      * months: effective_from the 1st, effective_to EXCLUSIVE (the 1st,
--        after the start) or NULL for open-ended; AT MOST ONE OVERRIDE PER
--        MERCHANT PER MONTH (A4e) is an exclusion constraint.
--      * recipient_id references profiles: the TWENTY-SIXTH profiles FK, NO
--        ACTION. merchant_id is ON DELETE RESTRICT (a payroll record).
--      * no agent_id, no created_by: the actor is in audit_log.
--      * RLS on, one policy (select is_admin()). authenticated holds SELECT
--        only; service_role SELECT and DELETE (the teardowns); nobody holds
--        INSERT or UPDATE, so a client write is "permission denied". The
--        three functions below are the only write path, each audited.
--      * Set only once the merchant exists (A4b): an override lives on the
--        merchant, which exists from approval; a merchant whose pre-app is
--        neither submitted nor approved is refused.
--
-- 2. THE FUNCTIONS. security definer, search_path public, pg_temp,
--    is_admin() FIRST, the share lock (so overrides, shares, rates and
--    commits serialise), an audit row in the same transaction with no
--    exception handler, their own revoke/grant lines. PT403 not an admin,
--    PT404 not found, PT409 a conflict with existing state, 22023 a bad
--    argument.
--    set_merchant_override(merchant_id_input int, recipient_id_input uuid,
--                          override_pct_input numeric,
--                          effective_from_input date) returns int
--      Every argument required (the form prefills the owner's manager; the
--      function never guesses). Refuses: no merchant; a pre-app not
--      submitted or approved; no MID; a percent not in hundredths, <= 0 or
--      > 50; a merchant with no rate, or at 0 (nothing to come out of); a
--      percent above the merchant's rate; not the 1st; a recipient who does
--      not exist, is deactivated, is the owner, or is a party to a share on
--      the merchant overlapping the override; a start at or before the
--      latest month committed for the MID (an override for a committed month
--      is an adjustment). An open override that started earlier is ENDED at
--      the new start in the same call ("change it from November" is one
--      call; the table is the history). Audited 'set_merchant_override'
--      (and 'end_merchant_override' for the one it ends).
--    end_merchant_override(override_id_input int, effective_to_input date)
--      The override stops applying from that month (exclusive). Neither the
--      new end nor an existing one may be at or before the latest committed
--      month. Audited 'end_merchant_override'.
--    cancel_merchant_override(override_id_input int)
--      Deletes an override no ledger line references and no committed month
--      falls inside. Audited 'cancel_merchant_override'.
--    THE MONTH RULE, as for shares: no boundary at or before the latest month
--    committed for the MID. So an override in force for a committed month can
--    never change afterwards, and a REPLACE of that month (commit v3 on a
--    replacing batch) reads the same override the original commit read. The
--    lines themselves are snapshots: override_amount is stored, never
--    recomputed, so editing an override later changes no committed month.
--
-- 3. THE RULES THAT HOLD OVER TIME, kept where the change would happen:
--      * set_merchant_split refuses a rate below a LIVE override's percent
--        (A29), naming it;
--      * guard_merchant_split_and_owner refuses moving a merchant while it
--        has a live override, as for a live share (whose rep side would it
--        come out of?). That also stops the recipient becoming the owner;
--      * set_merchant_rep_share refuses naming as signer or partner the
--        recipient of an override overlapping the share.
--    LIVE, as for shares: open-ended, or ending after the latest month with
--    an import line for the merchant (any month, if none has) --
--    merchant_has_live_override(). No client may call it.
--
-- 4. THE LEDGER. rep_payout_rows gains override_id (references
--    merchant_overrides, ON DELETE RESTRICT), override_role ('debit' |
--    'credit') and override_amount (signed). line_kind gains 'override'.
--    rep_payout gains `when line_kind = 'override' then override_amount`,
--    rewritten by DROP AND RE-ADD under the 20261014140000 precautions: it
--    refuses to run if anything but its own expression depends on the column
--    or the column carries privileges, and every existing payout is compared
--    (count, total, per-row md5) before and after, or nothing commits.
--    CHECKs: the three override columns are set together, on override lines
--    only; an override line carries a batch and a processor, no share
--    columns, and (rep_payout_rows_adjustment_no_figures, rewritten) no
--    residual, rate, volume, average ticket or total cost; an adjustment
--    still carries no batch (rewritten rep_payout_rows_adjustment_columns
--    and _no_figures say "not an adjustment" where they said "import").
--    rep_payout_rows_override_line_key: one line per (batch, override, role,
--    rep). A CHECK cannot see the other line of a pair, so "the debits and
--    the credit net to zero" is the commit's, pinned by the tests.
--    No client writes any of it: authenticated holds UPDATE on
--    residual_income and rep_split_pct only, and the no-figures CHECK refuses
--    either on an override line.
--
-- 5. COMMIT V3 STEP 6, the override lines. For every file row whose merchant
--    has an override in force for the batch month:
--      X   = round(R * o / 100, 2)          the override, half away from zero
--                                            (Postgres round, rep_payout's own
--                                            rounding); X has R's sign, and
--                                            |X| <= |T| because o <= s.
--      unshared: the owner's debit  -X; the recipient's credit +X.
--      shared (signer a, partner b, a + b = s):
--        x_p = shared_part(X, b, s)          the partner's piece of the
--        x_s = X - x_p                       deduction, by the cent rule (the
--                                            signer absorbs the odd cent, as
--                                            in the payout itself)
--        the signer's debit -x_s, the partner's -x_p, the credit +X.
--    ORDER OF ROUNDING: X once, from R (never from T); then x_p from X; x_s by
--    subtraction. So debits + credit = 0 exactly, and signer net + partner net
--    + recipient = T exactly: the company's R - T never moves. o = s nets the
--    rep side to exactly zero (X = T, x_p = the partner's payout). A negative
--    R (a clawback, A25) imports with no warning and every figure reverses
--    in proportion: the recipient gives back their cut. X = 0 (R = 0, or a
--    residual too small to carry a cent) still writes the lines, at 0.00, so
--    every month an override was in force shows it.
--    The lines carry the batch's batch_id, period and processor, and the
--    merchant's mid, merchant_id and dba as merchant_name -- the snapshot a
--    recipient reads as plain text. A REPLACE deletes them with the old
--    batch's lines (batch_id) and step 6 writes them again from the override
--    in force at replace time, which the month rule makes the same one.
--    BACKSTOPS, refused before anything is written (PT409, naming the MIDs
--    and override ids): an override above the merchant's rate now; one paid
--    to the owner or to a party of a covering share; one whose recipient is
--    deactivated (the conservative choice: end it, or reactivate them).
--    The result's `overrides` is the number of file rows an override applied
--    to (one credit line each).
--
-- 6. VISIBILITY (A4c). A rep reads their own debit lines (RLS, agent_id) and
--    learns who receives the override from my_override_recipients():
--    security definer, search_path pinned, is_active_agent() FIRST (PT403),
--    built with jsonb_build_object so only override_id, recipient_name and
--    override_pct exist, and only for overrides the CALLER holds a debit line
--    for. The recipient reads their own credit line: merchant_name is plain
--    text on it, and nothing here reaches merchants -- no merchants policy is
--    widened, so the recipient's read of the merchant row is still nothing.
--    The recipient learns neither the percent nor the rep from this phase.
--
-- 7. delete_payout_period deletes the month's override lines with its import
--    lines (one processor-month, the same lock and refusals); otherwise the
--    body of 20261030190000.
--
-- REFUSES TO RUN, naming what it found, over definitions it rewrites that
-- are not the ones it expects (line_kind, the two adjustment CHECKs) and over
-- a rep_payout column it cannot safely drop. Not "the table must be empty":
-- every existing line is an import or an adjustment line with the new columns
-- NULL, which every new CHECK admits, and the rewrite proves no payout moved.
-- =====================================================================

-- 0. The definitions this migration rewrites, checked.
do $$
declare
  definition text;
  dependents int;
  column_acl aclitem[];
begin
  select pg_get_constraintdef(oid) into definition from pg_constraint
   where conrelid = 'public.rep_payout_rows'::regclass
     and conname = 'rep_payout_rows_line_kind';
  if definition is distinct from 'CHECK ((line_kind = ANY (ARRAY[''import''::text, ''adjustment''::text])))' then
    raise exception 'rep_payout_rows_line_kind is not (import, adjustment) here (found: %). Inspect it before applying 20261102120000.',
      coalesce(definition, 'no such constraint');
  end if;

  select pg_get_constraintdef(oid) into definition from pg_constraint
   where conrelid = 'public.rep_payout_rows'::regclass
     and conname = 'rep_payout_rows_adjustment_columns';
  if definition is distinct from 'CHECK ((((line_kind = ''import''::text) AND (adjustment_amount IS NULL) AND (adjusts_period IS NULL) AND (adjustment_note IS NULL)) OR ((line_kind = ''adjustment''::text) AND (adjustment_amount IS NOT NULL) AND (adjusts_period IS NOT NULL) AND (EXTRACT(day FROM adjusts_period) = (1)::numeric) AND (rep_share_id IS NULL))))' then
    raise exception 'rep_payout_rows_adjustment_columns is not the 20261014140000 CHECK here (found: %). Inspect it before applying 20261102120000.',
      coalesce(definition, 'no such constraint');
  end if;

  select pg_get_constraintdef(oid) into definition from pg_constraint
   where conrelid = 'public.rep_payout_rows'::regclass
     and conname = 'rep_payout_rows_adjustment_no_figures';
  if definition is distinct from 'CHECK (((line_kind = ''import''::text) OR ((residual_income IS NULL) AND (rep_split_pct IS NULL) AND (volume IS NULL) AND (average_ticket IS NULL) AND (total_cost IS NULL) AND (batch_id IS NULL))))' then
    raise exception 'rep_payout_rows_adjustment_no_figures is not the 20261016160000 CHECK here (found: %). Inspect it before applying 20261102120000.',
      coalesce(definition, 'no such constraint');
  end if;

  select count(*) into dependents
    from pg_depend d
    join pg_attribute a
      on a.attrelid = d.refobjid and a.attnum = d.refobjsubid
   where d.refobjid = 'public.rep_payout_rows'::regclass
     and a.attname = 'rep_payout'
     and d.classid <> 'pg_attrdef'::regclass;
  if dependents > 0 then
    raise exception 'rep_payout_rows.rep_payout has % dependent object(s) besides its own expression; dropping the column would drop or break them. Inspect pg_depend before applying 20261102120000.',
      dependents;
  end if;

  select attacl into column_acl
    from pg_attribute
   where attrelid = 'public.rep_payout_rows'::regclass
     and attname = 'rep_payout';
  if column_acl is not null then
    raise exception 'rep_payout_rows.rep_payout carries column-level privileges (%); dropping the column would lose them.',
      column_acl;
  end if;
end $$;

-- 1. The table.
create table merchant_overrides (
  id serial primary key,
  merchant_id  int  not null references merchants(id) on delete restrict,
  -- The 26th reference to profiles(id), NO ACTION.
  recipient_id uuid not null references profiles(id),
  -- % of the FULL residual, taken from the rep side. <= 50 because no split
  -- rate exceeds 50 (the profiles, pre_apps and merchants CHECKs). The real
  -- cap, <= the merchant's split_agent_pct, is set_merchant_override()'s,
  -- set_merchant_split()'s (A29) and commit v3's. Move together.
  override_pct numeric(5,2) not null,
  -- First payout month it applies to (1st of the month).
  effective_from date not null,
  -- EXCLUSIVE: the first month it no longer applies. NULL = open-ended.
  effective_to   date,
  created_at timestamptz not null default now(),
  constraint merchant_overrides_pct_range
    check (override_pct > 0 and override_pct <= 50),
  constraint merchant_overrides_from_first_of_month
    check (extract(day from effective_from) = 1),
  constraint merchant_overrides_to_first_of_month
    check (effective_to is null
           or (extract(day from effective_to) = 1 and effective_to > effective_from)),
  -- At most one override per merchant per month (A4e).
  constraint merchant_overrides_no_overlap
    exclude using gist (merchant_id with =,
                        daterange(effective_from, effective_to) with &&)
);

-- Step 2 of the four, written although ensure_rls would do it here: the
-- event trigger is skipped where the migration role lacks superuser.
alter table merchant_overrides enable row level security;

create policy "admin only select" on merchant_overrides
  for select using (is_admin());

-- Nothing is granted by default (20260805210000), and nothing more than
-- this is wanted: revoke first so the grants below are the whole of it.
revoke all on merchant_overrides from public, anon, authenticated, service_role;
revoke all on sequence merchant_overrides_id_seq from public, anon, authenticated, service_role;
grant select on merchant_overrides to authenticated;
-- The teardowns read and delete as the service role; nothing inserts or
-- updates outside the definer functions below.
grant select, delete on merchant_overrides to service_role;

create index idx_merchant_overrides_recipient on merchant_overrides (recipient_id);

-- 2. The ledger: the override columns.
create temp table rep_payout_override_before on commit drop as
  select id, rep_payout from rep_payout_rows;

alter table rep_payout_rows
  add column override_id int
    constraint rep_payout_rows_override_id_fkey
      references merchant_overrides(id) on delete restrict,
  add column override_role text
    constraint rep_payout_rows_override_role
      check (override_role in ('debit', 'credit')),
  add column override_amount numeric(14,2);

alter table rep_payout_rows drop constraint rep_payout_rows_line_kind;
alter table rep_payout_rows
  add constraint rep_payout_rows_line_kind
    check (line_kind in ('import', 'adjustment', 'override'));

alter table rep_payout_rows drop constraint rep_payout_rows_adjustment_columns;
alter table rep_payout_rows
  add constraint rep_payout_rows_adjustment_columns check (
    (line_kind <> 'adjustment' and adjustment_amount is null
     and adjusts_period is null and adjustment_note is null)
    or (line_kind = 'adjustment' and adjustment_amount is not null
        and adjusts_period is not null
        and extract(day from adjusts_period) = 1
        and rep_share_id is null)
  );

-- Neither an adjustment nor an override carries a figure; an adjustment has
-- no batch, an override line always has one.
alter table rep_payout_rows drop constraint rep_payout_rows_adjustment_no_figures;
alter table rep_payout_rows
  add constraint rep_payout_rows_adjustment_no_figures check (
    line_kind = 'import'
    or (residual_income is null and rep_split_pct is null
        and volume is null and average_ticket is null
        and total_cost is null
        and (batch_id is null) = (line_kind = 'adjustment'))
  );

alter table rep_payout_rows
  add constraint rep_payout_rows_override_columns check (
    (line_kind <> 'override' and override_id is null
     and override_role is null and override_amount is null)
    or (line_kind = 'override' and override_id is not null
        and override_role is not null and override_amount is not null
        and processor is not null and rep_share_id is null)
  );

create unique index rep_payout_rows_override_line_key
  on rep_payout_rows (batch_id, override_id, override_role, agent_id)
  where line_kind = 'override';

create index idx_rep_payout_rows_override
  on rep_payout_rows (override_id)
  where override_id is not null;

-- 3. rep_payout: the override branch. Every other branch unchanged.
alter table rep_payout_rows drop column rep_payout;

alter table rep_payout_rows
  add column rep_payout numeric(14,2) generated always as (
    case
      when line_kind = 'adjustment' then adjustment_amount
      when line_kind = 'override' then override_amount
      when share_role is null then
        round(residual_income * rep_split_pct / 100, 2)
      when share_role = 'secondary' then
        shared_part(round(account_residual_income * rep_split_pct / 100, 2),
                    secondary_rep_pct, primary_rep_pct + secondary_rep_pct)
      else
        round(account_residual_income * rep_split_pct / 100, 2)
        - shared_part(round(account_residual_income * rep_split_pct / 100, 2),
                      secondary_rep_pct, primary_rep_pct + secondary_rep_pct)
    end
  ) stored;

-- Nothing moved, to the cent, or nothing commits.
do $$
declare
  before_rows  bigint;
  after_rows   bigint;
  before_total numeric;
  after_total  numeric;
  before_md5   text;
  after_md5    text;
begin
  select count(*), sum(rep_payout),
         md5(coalesce(string_agg(id::text || ':' || coalesce(rep_payout::text, 'null'),
                                 ',' order by id), ''))
    into before_rows, before_total, before_md5
    from rep_payout_override_before;

  select count(*), sum(rep_payout),
         md5(coalesce(string_agg(id::text || ':' || coalesce(rep_payout::text, 'null'),
                                 ',' order by id), ''))
    into after_rows, after_total, after_md5
    from rep_payout_rows;

  -- Counts and which check failed, never figures: a migration log is not a
  -- place for payout data.
  if before_rows is distinct from after_rows
     or before_total is distinct from after_total
     or before_md5 is distinct from after_md5 then
    raise exception 'rep_payout rewrite changed existing payouts (rows % -> %, total %, per-row checksum %); rolled back',
      before_rows, after_rows,
      case when before_total is not distinct from after_total then 'matches' else 'DIFFERS' end,
      case when before_md5 = after_md5 then 'matches' else 'DIFFERS' end;
  end if;
end $$;

drop table rep_payout_override_before;

-- 4. A live override: one that could still pay a month. Invoker, and no
-- client may call it; its callers are definer functions and a definer trigger.
create or replace function merchant_has_live_override(merchant_id_input int)
returns boolean
language sql
stable
set search_path = public, pg_temp
as $$
  select exists (
    select 1
      from merchant_overrides o
      join merchants m on m.id = o.merchant_id
     where o.merchant_id = merchant_id_input
       and (o.effective_to is null
            or o.effective_to > coalesce(
                 (select max(l.period) from rep_payout_rows l
                   where (l.merchant_id = m.id or l.mid = m.mid)
                     and l.line_kind = 'import'),
                 '-infinity'::date))
  );
$$;

revoke all on function merchant_has_live_override(int) from public;
revoke all on function merchant_has_live_override(int) from anon, authenticated;

-- 5. Moving a merchant is refused while it has a live override, as while it
-- has a live share. Otherwise the body of 20261030160000.
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

  if new.agent_id is distinct from old.agent_id
     and merchant_has_live_override(old.id) then
    raise exception 'This merchant has an override, which comes out of its owner''s side. End it before moving the merchant.'
      using errcode = 'PT409';
  end if;

  return new;
end;
$$;

revoke all on function guard_merchant_split_and_owner() from public;
revoke all on function guard_merchant_split_and_owner() from anon, authenticated;

-- 6. set_merchant_split refuses a rate below a live override (A29).
-- Otherwise the body of 20261030160000.
create or replace function set_merchant_split(merchant_id_input int, rate_input numeric)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  m        merchants;
  above    merchant_overrides;
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

  -- A29: an override comes out of the rate, so the rate cannot go below a
  -- live one's percent.
  select o.* into above
    from merchant_overrides o
   where o.merchant_id = m.id
     and o.override_pct > rate_input
     and (o.effective_to is null
          or o.effective_to > coalesce(
               (select max(l.period) from rep_payout_rows l
                 where (l.merchant_id = m.id or l.mid = m.mid)
                   and l.line_kind = 'import'),
               '-infinity'::date))
   order by o.effective_from
   limit 1;
  if found then
    raise exception 'This merchant has an override of %, which comes out of its rate. End or change the override before setting the rate below it.',
      trim_scale(above.override_pct) || '%'
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

-- 7. set_merchant_rep_share refuses naming an override's recipient as a
-- party. Otherwise the body of 20261030160000 (search_path kept as it was).
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
  recipient  text;
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

  -- An override is paid out of the parties' side, so its recipient cannot
  -- be one of them (memo §4.1; 20261102120000).
  select p.full_name into recipient
    from merchant_overrides o
    join profiles p on p.id = o.recipient_id
   where o.merchant_id = m.id
     and o.recipient_id in (primary_agent_id_input, secondary_agent_id_input)
     and daterange(o.effective_from, o.effective_to)
         && daterange(effective_from_input, null)
   limit 1;
  if recipient is not null then
    raise exception '% receives this merchant''s override, so they cannot also be a party to its shared account. End the override first.',
      recipient
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
revoke all on function set_merchant_rep_share(int, uuid, uuid, numeric, numeric, date)
  from anon;
grant execute on function set_merchant_rep_share(int, uuid, uuid, numeric, numeric, date)
  to authenticated, service_role;

-- 8. set_merchant_override.
create or replace function set_merchant_override(
  merchant_id_input    int,
  recipient_id_input   uuid,
  override_pct_input   numeric,
  effective_from_input date
)
returns int
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  m          merchants;
  recipient  profiles;
  pre_status text;
  latest     date;
  open_one   merchant_overrides;
  new_id     int;
begin
  if not is_admin() then
    raise exception 'admin only' using errcode = 'PT403';
  end if;

  perform pg_advisory_xact_lock(hashtext('tapswipe.merchant_rep_shares'));

  if merchant_id_input is null or recipient_id_input is null
     or override_pct_input is null or effective_from_input is null then
    raise exception 'Every field is required to set an override: who receives it, the percent and the first month.'
      using errcode = '22023';
  end if;

  select * into m from merchants where id = merchant_id_input for update;
  if not found then
    raise exception 'merchant not found' using errcode = 'PT404';
  end if;

  -- A4b: set only once the pre-app is submitted. A merchant exists from
  -- approval; this refuses one whose pre-app says otherwise. A merchant an
  -- admin made by hand has no pre-app and is allowed.
  if m.pre_app_id is not null then
    select status into pre_status from pre_apps where id = m.pre_app_id;
    if pre_status is distinct from 'submitted' and pre_status is distinct from 'approved' then
      raise exception 'This merchant''s pre-app has not been submitted, so it cannot carry an override yet.'
        using errcode = 'PT409';
    end if;
  end if;

  if m.mid is null or btrim(m.mid) = '' then
    raise exception 'This merchant has no MID, so no residual could ever carry an override. Add the MID first.'
      using errcode = 'PT409';
  end if;

  if override_pct_input <> round(override_pct_input, 2)
     or override_pct_input <= 0 or override_pct_input > 50 then
    raise exception 'An override is a percent of the full residual, above 0 and in hundredths at most, like 10 or 2.5.'
      using errcode = '22023';
  end if;

  if m.split_agent_pct is null then
    raise exception 'This merchant has no split rate yet. Set its rate before giving it an override.'
      using errcode = 'PT409';
  end if;

  if m.split_agent_pct = 0 then
    raise exception 'This merchant''s rate is 0, so there is no rep side for an override to come out of.'
      using errcode = 'PT409';
  end if;

  -- The cap (memo §0b.5): the override comes out of the rep side, which is
  -- the merchant's rate -- not always 50.
  if override_pct_input > m.split_agent_pct then
    raise exception 'An override comes out of the rep side, so it cannot be more than this merchant''s rate: %.',
      trim_scale(m.split_agent_pct)
      using errcode = '22023';
  end if;

  if extract(day from effective_from_input) <> 1 then
    raise exception 'An override starts on the first day of a month.'
      using errcode = '22023';
  end if;

  select * into recipient from profiles where id = recipient_id_input;
  if not found then
    raise exception 'recipient not found' using errcode = 'PT404';
  end if;

  if not recipient.is_active then
    raise exception '% is deactivated, so a new override cannot name them.', recipient.full_name
      using errcode = 'PT409';
  end if;

  if recipient.id = m.agent_id then
    raise exception 'The override is paid out of the owner''s side, so the owner cannot also receive it. Name their manager or another person.'
      using errcode = '22023';
  end if;

  if exists (
    select 1 from merchant_rep_shares s
     where s.merchant_id = m.id
       and recipient.id in (s.primary_agent_id, s.secondary_agent_id)
       and daterange(s.effective_from, s.effective_to)
           && daterange(effective_from_input, null)
  ) then
    raise exception '% is a party to this merchant''s shared account, so they cannot also receive its override.',
      recipient.full_name
      using errcode = 'PT409';
  end if;

  select max(period) into latest
    from rep_payout_rows
   where (merchant_id = m.id or mid = m.mid)
     and line_kind = 'import';

  if latest is not null and effective_from_input <= latest then
    raise exception '% is already committed for this MID. An override can only start after it; a committed month is corrected with an adjustment.',
      to_char(latest, 'FMMonth YYYY')
      using errcode = 'PT409';
  end if;

  select * into open_one
    from merchant_overrides
   where merchant_id = m.id and effective_to is null;

  if found then
    if open_one.effective_from >= effective_from_input then
      raise exception 'This merchant already has an override starting %. Cancel or end that one first.',
        to_char(open_one.effective_from, 'FMMonth YYYY')
        using errcode = 'PT409';
    end if;

    update merchant_overrides
       set effective_to = effective_from_input
     where id = open_one.id;

    insert into audit_log (actor_id, action, table_name, row_id)
    values (auth.uid(), 'end_merchant_override', 'merchant_overrides',
            open_one.id::text);
  end if;

  if exists (
    select 1 from merchant_overrides
     where merchant_id = m.id
       and daterange(effective_from, effective_to)
           && daterange(effective_from_input, null)
  ) then
    raise exception 'That month overlaps another override on this merchant.'
      using errcode = 'PT409';
  end if;

  insert into merchant_overrides (
    merchant_id, recipient_id, override_pct, effective_from
  )
  values (
    m.id, recipient.id, override_pct_input, effective_from_input
  )
  returning id into new_id;

  insert into audit_log (actor_id, action, table_name, row_id)
  values (auth.uid(), 'set_merchant_override', 'merchant_overrides',
          new_id::text);

  return new_id;
end;
$$;

revoke all on function set_merchant_override(int, uuid, numeric, date) from public;
revoke all on function set_merchant_override(int, uuid, numeric, date) from anon;
grant execute on function set_merchant_override(int, uuid, numeric, date)
  to authenticated, service_role;

-- 9. end_merchant_override.
create or replace function end_merchant_override(
  override_id_input  int,
  effective_to_input date
)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  o      merchant_overrides;
  m      merchants;
  latest date;
begin
  if not is_admin() then
    raise exception 'admin only' using errcode = 'PT403';
  end if;

  perform pg_advisory_xact_lock(hashtext('tapswipe.merchant_rep_shares'));

  if override_id_input is null or effective_to_input is null then
    raise exception 'An override and an end month are required.'
      using errcode = '22023';
  end if;

  select * into o from merchant_overrides where id = override_id_input;
  if not found then
    raise exception 'override not found' using errcode = 'PT404';
  end if;

  if extract(day from effective_to_input) <> 1 then
    raise exception 'An override ends on the first day of a month.'
      using errcode = '22023';
  end if;

  if effective_to_input <= o.effective_from then
    raise exception 'An override has to end after the month it starts. To remove it entirely, cancel it.'
      using errcode = '22023';
  end if;

  select * into m from merchants where id = o.merchant_id;
  select max(period) into latest
    from rep_payout_rows
   where (merchant_id = m.id or mid = m.mid)
     and line_kind = 'import';

  if latest is not null and effective_to_input <= latest then
    raise exception '% is already committed for this MID. An override can only end after it.',
      to_char(latest, 'FMMonth YYYY')
      using errcode = 'PT409';
  end if;

  if latest is not null and o.effective_to is not null and o.effective_to <= latest then
    raise exception 'This override already ended before a committed month, so its end is settled.'
      using errcode = 'PT409';
  end if;

  if exists (
    select 1 from merchant_overrides
     where merchant_id = o.merchant_id
       and id <> o.id
       and daterange(effective_from, effective_to)
           && daterange(o.effective_from, effective_to_input)
  ) then
    raise exception 'That end month overlaps another override on this merchant.'
      using errcode = 'PT409';
  end if;

  update merchant_overrides
     set effective_to = effective_to_input
   where id = o.id;

  insert into audit_log (actor_id, action, table_name, row_id)
  values (auth.uid(), 'end_merchant_override', 'merchant_overrides',
          o.id::text);
end;
$$;

revoke all on function end_merchant_override(int, date) from public;
revoke all on function end_merchant_override(int, date) from anon;
grant execute on function end_merchant_override(int, date)
  to authenticated, service_role;

-- 10. cancel_merchant_override: one that never paid a month.
create or replace function cancel_merchant_override(override_id_input int)
returns void
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  o      merchant_overrides;
  m      merchants;
  latest date;
begin
  if not is_admin() then
    raise exception 'admin only' using errcode = 'PT403';
  end if;

  perform pg_advisory_xact_lock(hashtext('tapswipe.merchant_rep_shares'));

  select * into o from merchant_overrides where id = override_id_input;
  if not found then
    raise exception 'override not found' using errcode = 'PT404';
  end if;

  select * into m from merchants where id = o.merchant_id;
  select max(period) into latest
    from rep_payout_rows
   where (merchant_id = m.id or mid = m.mid)
     and line_kind = 'import';

  if exists (select 1 from rep_payout_rows where override_id = o.id)
     or (latest is not null and o.effective_from <= latest) then
    raise exception 'This override has applied to a committed month, so it cannot be cancelled. End it instead.'
      using errcode = 'PT409';
  end if;

  delete from merchant_overrides where id = o.id;

  insert into audit_log (actor_id, action, table_name, row_id)
  values (auth.uid(), 'cancel_merchant_override', 'merchant_overrides',
          o.id::text);
end;
$$;

revoke all on function cancel_merchant_override(int) from public;
revoke all on function cancel_merchant_override(int) from anon;
grant execute on function cancel_merchant_override(int)
  to authenticated, service_role;

-- 11. my_override_recipients: who receives the overrides on the caller's
-- own lines. Party-only, admins included (an admin reads the table).
create or replace function my_override_recipients()
returns jsonb
language plpgsql
stable
security definer
set search_path = public, pg_temp
as $$
declare
  caller uuid := auth.uid();
  result jsonb;
begin
  if caller is null or not is_active_agent() then
    raise exception 'not authorised' using errcode = 'PT403';
  end if;

  select coalesce(jsonb_agg(
           jsonb_build_object(
             'override_id', o.id,
             'recipient_name', p.full_name,
             'override_pct', o.override_pct)
           order by o.id),
         '[]'::jsonb)
    into result
    from merchant_overrides o
    join profiles p on p.id = o.recipient_id
   where exists (select 1 from rep_payout_rows l
                  where l.override_id = o.id
                    and l.agent_id = caller
                    and l.override_role = 'debit');

  return result;
end;
$$;

revoke all on function my_override_recipients() from public;
revoke all on function my_override_recipients() from anon;
grant execute on function my_override_recipients() to authenticated, service_role;

-- 12. The period delete takes the month's override lines with its import
-- lines. Otherwise the body of 20261030190000.
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
          or a.mid in (select l.mid from rep_payout_rows l
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

-- 13. v3 with step 6. Otherwise the body of 20261030190000.
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
