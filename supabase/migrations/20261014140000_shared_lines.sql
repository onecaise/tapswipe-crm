-- Shared lines: rep_payout_rows learns about shared accounts and adjustment
-- lines, and rep_payout is rewritten (drop and re-add) to pay them. Phase 3 of
-- docs/design/residual-splits.md.
--
-- Matches docs/tapswipe_crm_schema.sql, updated first; the block below is
-- copied from it verbatim.
--
-- =====================================================================
-- SHARED LINES (20261014140000) — rep_payout_rows learns about shared
-- accounts and adjustment lines, and rep_payout is rewritten to pay them.
-- Design: docs/design/residual-splits.md §3.2, §3.3, §4, §5.2.
--
-- A shared account is TWO ledger lines in a month, the signer's and the
-- partner's, so that "a rep's money is the sum of rep_payout over their own
-- rows" stays true for every existing reader and every existing policy. What
-- is divided is the rep side's PAYOUT: the payout one rep alone would receive,
-- T = round(account_residual_income * rep_split_pct / 100, 2), is worked out
-- on each line from the account figure, and shared_part() takes the partner's
-- piece; the signer gets T minus it. The two always sum to T exactly. Each
-- line's residual_income is the matching piece of the account residual, kept
-- so the period's Residual income total stays exact; a CHECK makes every line
-- prove its own piece.
--
-- The share is SNAPSHOTTED onto both lines (primary_rep_pct,
-- secondary_rep_pct) because a generated column cannot read another table --
-- and because a later edit to a share must never re-price a month already
-- paid.
--
-- line_kind and the adjustment columns arrive now, with their branch in the
-- expression, so rep_payout is rewritten ONCE. Nothing writes an adjustment
-- line yet: the merge key stays the ordinary unique (period, agent_id, mid)
-- until phase 5 swaps it for a partial index, because today's
-- commit_residual_import says `on conflict (period, agent_id, mid)` with no
-- WHERE and Postgres would not infer a partial index from that.
--
-- HOW THE COLUMN IS REWRITTEN: drop and re-add, in one transaction, which is
-- the method that works on every Postgres version (ALTER COLUMN ... SET
-- EXPRESSION is 17+). Three things make that safe, all in the migration:
--
--   1. PRECONDITIONS. Dropping a column silently drops any index on it and
--      fails on a view or policy; dropping it also loses a column-level grant.
--      On every database this repo can see, the only dependent of rep_payout
--      is its own generation expression and its ACL is null (all privileges
--      come from table-level grants, which cover a re-added column too). The
--      migration REFUSES to run if that is not true on the database in front
--      of it -- a hosted project with something hand-made on the column must
--      not lose it quietly.
--   2. A COPY of (id, rep_payout) is taken first, and after the rewrite the
--      row count, the total and an md5 over every (id, value) pair must match
--      it exactly, or the migration raises and everything above rolls back --
--      the Supabase CLI applies a migration file as one transaction (verified
--      14 Oct 2026: a failing file leaves neither its objects nor its ledger
--      row). The copy is a temp table, dropped before the end, so no payout
--      data outlives the migration.
--   3. Every new column must be empty (line_kind 'import', the rest NULL) on
--      every existing row, checked in the same block.
--
-- The column moves to the end of the table. Nothing reads it positionally;
-- every reader names it.
--
-- EDITING A SHARED PAIR. Both lines carry the account figure, so the pair is
-- changed together or not at all:
--   * set_shared_residual(share, month, amount) is the one write path for the
--     residual: it sets the account figure on both lines and both pieces, in
--     one statement;
--   * the partner's rep_split_pct always copies the signer's -- an AFTER
--     UPDATE trigger copies it across when the signer's changes;
--   * guard_shared_line() refuses everything else: a hand edit of either
--     residual piece, of the partner's rate, or of any share or adjustment
--     column. It is not a security boundary (UPDATE is already admin-only);
--     it stops an admin typing two pieces that no longer describe one
--     account.
-- The sanctioned paths set the transaction-local flag tapswipe.shared_write,
-- which the guard lets through. set_config is in pg_catalog, which PostgREST
-- does not expose, and no RPC passes caller input to it.
-- =====================================================================

-- 0. Preconditions: refuse rather than silently drop something hand-made.
do $$
declare
  dependents int;
  column_acl aclitem[];
begin
  select count(*) into dependents
    from pg_depend d
    join pg_attribute a
      on a.attrelid = d.refobjid and a.attnum = d.refobjsubid
   where d.refobjid = 'public.rep_payout_rows'::regclass
     and a.attname = 'rep_payout'
     and d.classid <> 'pg_attrdef'::regclass;

  if dependents > 0 then
    raise exception 'rep_payout_rows.rep_payout has % dependent object(s) besides its own expression; dropping the column would drop or break them. Inspect pg_depend before applying 20261014140000.',
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

-- 1. The copy every existing payout is checked against.
create temp table rep_payout_rewrite_before on commit drop as
  select id, rep_payout from rep_payout_rows;

-- 2. The new columns. All empty on every existing row: line_kind's default is
-- a constant, so Postgres records it in the catalog rather than rewriting.
alter table rep_payout_rows
  add column line_kind text not null default 'import',
  add column rep_share_id int references merchant_rep_shares(id) on delete restrict,
  add column share_role text,
  add column account_residual_income numeric(14,2),
  add column primary_rep_pct numeric(5,2),
  add column secondary_rep_pct numeric(5,2),
  add column adjustment_amount numeric(14,2),
  add column adjusts_period date,
  add column adjustment_note text;

alter table rep_payout_rows
  add constraint rep_payout_rows_line_kind
    check (line_kind in ('import', 'adjustment')),
  add constraint rep_payout_rows_share_role
    check (share_role in ('primary', 'secondary')),
  -- The share columns come as a set. account_residual_income is the one that
  -- may be NULL on a shared line: "not worked out yet" is as ordinary there as
  -- on any other line.
  add constraint rep_payout_rows_share_columns_together check (
    (rep_share_id is null and share_role is null and primary_rep_pct is null
     and secondary_rep_pct is null and account_residual_income is null)
    or (rep_share_id is not null and share_role is not null
        and primary_rep_pct is not null and secondary_rep_pct is not null)
  ),
  -- The snapshot obeys the share table's own rule.
  add constraint rep_payout_rows_share_snapshot check (
    primary_rep_pct is null
    or (primary_rep_pct > 0 and secondary_rep_pct > 0
        and primary_rep_pct + secondary_rep_pct = 50.00)
  ),
  -- Every shared line proves its own residual piece from the account figure
  -- on the same row. Both NULL is "not worked out yet"; one without the other
  -- is refused.
  add constraint rep_payout_rows_shared_piece check (
    share_role is null
    or (account_residual_income is null and residual_income is null)
    or (account_residual_income is not null and residual_income is not null
        and residual_income = case share_role
          when 'secondary' then
            shared_part(account_residual_income, secondary_rep_pct,
                        primary_rep_pct + secondary_rep_pct)
          else
            account_residual_income
            - shared_part(account_residual_income, secondary_rep_pct,
                          primary_rep_pct + secondary_rep_pct)
        end)
  ),
  -- Adjustment columns only on adjustment lines, and an adjustment is never
  -- also a shared line.
  add constraint rep_payout_rows_adjustment_columns check (
    (line_kind = 'import' and adjustment_amount is null
     and adjusts_period is null and adjustment_note is null)
    or (line_kind = 'adjustment' and adjustment_amount is not null
        and adjusts_period is not null
        and extract(day from adjusts_period) = 1
        and rep_share_id is null)
  );

-- Finds a share's pair in a month (set_shared_residual, the rate copy), and
-- serves the restrict check when a share is deleted. Partial: almost every
-- line is unshared.
create index idx_rep_payout_rows_rep_share
  on rep_payout_rows (rep_share_id, period)
  where rep_share_id is not null;

-- 3. The rewrite. The unshared branch is today's expression, unchanged.
alter table rep_payout_rows drop column rep_payout;

alter table rep_payout_rows
  add column rep_payout numeric(14,2) generated always as (
    case
      when line_kind = 'adjustment' then adjustment_amount
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

-- 4. Nothing moved, to the cent, or nothing commits.
do $$
declare
  before_rows  bigint;
  after_rows   bigint;
  before_total numeric;
  after_total  numeric;
  before_md5   text;
  after_md5    text;
  not_empty    bigint;
begin
  select count(*), sum(rep_payout),
         md5(coalesce(string_agg(id::text || ':' || coalesce(rep_payout::text, 'null'),
                                 ',' order by id), ''))
    into before_rows, before_total, before_md5
    from rep_payout_rewrite_before;

  select count(*), sum(rep_payout),
         md5(coalesce(string_agg(id::text || ':' || coalesce(rep_payout::text, 'null'),
                                 ',' order by id), ''))
    into after_rows, after_total, after_md5
    from rep_payout_rows;

  -- The message names counts and which check failed, never figures: a
  -- migration log is not a place for payout data.
  if before_rows is distinct from after_rows
     or before_total is distinct from after_total
     or before_md5 is distinct from after_md5 then
    raise exception 'rep_payout rewrite changed existing payouts (rows % -> %, total %, per-row checksum %); rolled back',
      before_rows, after_rows,
      case when before_total is not distinct from after_total then 'matches' else 'DIFFERS' end,
      case when before_md5 = after_md5 then 'matches' else 'DIFFERS' end;
  end if;

  select count(*) into not_empty
    from rep_payout_rows
   where line_kind <> 'import'
      or rep_share_id is not null or share_role is not null
      or account_residual_income is not null
      or primary_rep_pct is not null or secondary_rep_pct is not null
      or adjustment_amount is not null or adjusts_period is not null
      or adjustment_note is not null;

  if not_empty > 0 then
    raise exception 'rep_payout rewrite: % existing row(s) came out with a shared or adjustment column set; rolled back',
      not_empty;
  end if;
end $$;

drop table rep_payout_rewrite_before;

-- 5. guard_shared_line(): the pair is changed together or not at all.
create or replace function guard_shared_line()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if coalesce(current_setting('tapswipe.shared_write', true), '') = 'on' then
    return new;
  end if;

  if new.line_kind is distinct from old.line_kind
     or new.rep_share_id is distinct from old.rep_share_id
     or new.share_role is distinct from old.share_role
     or new.account_residual_income is distinct from old.account_residual_income
     or new.primary_rep_pct is distinct from old.primary_rep_pct
     or new.secondary_rep_pct is distinct from old.secondary_rep_pct
     or new.adjustment_amount is distinct from old.adjustment_amount
     or new.adjusts_period is distinct from old.adjusts_period
     or new.adjustment_note is distinct from old.adjustment_note then
    raise exception 'Shared-account and adjustment details are set by their own functions, not edited directly.'
      using errcode = 'PT409';
  end if;

  if old.share_role is not null
     and new.residual_income is distinct from old.residual_income then
    raise exception 'This account is shared. Set its total residual on the signer''s line and it will be divided.'
      using errcode = 'PT409';
  end if;

  if old.share_role = 'secondary'
     and new.rep_split_pct is distinct from old.rep_split_pct then
    raise exception 'The partner''s rate always copies the signer''s. Change it on the signer''s line.'
      using errcode = 'PT409';
  end if;

  return new;
end;
$$;

revoke all on function guard_shared_line() from public;

create trigger rep_payout_rows_guard_shared
  before update on rep_payout_rows
  for each row execute function guard_shared_line();

-- 6. copy_signer_rate_to_partner(): the partner's rate is the signer's.
-- Security invoker -- it runs inside an admin's own UPDATE, which the admin
-- update policy already admits for the partner's row too. The flag is put
-- back to what it was, so a caller that set it keeps it.
create or replace function copy_signer_rate_to_partner()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  previous text;
begin
  previous := current_setting('tapswipe.shared_write', true);
  perform set_config('tapswipe.shared_write', 'on', true);

  update rep_payout_rows
     set rep_split_pct = new.rep_split_pct
   where rep_share_id = new.rep_share_id
     and period = new.period
     and share_role = 'secondary'
     and rep_split_pct is distinct from new.rep_split_pct;

  perform set_config('tapswipe.shared_write', coalesce(previous, ''), true);
  return null;
end;
$$;

revoke all on function copy_signer_rate_to_partner() from public;

create trigger rep_payout_rows_copy_signer_rate
  after update of rep_split_pct on rep_payout_rows
  for each row
  when (new.share_role = 'primary'
        and new.rep_split_pct is distinct from old.rep_split_pct)
  execute function copy_signer_rate_to_partner();

-- 7. set_shared_residual(): the one write path for a shared pair's residual.
-- Security definer with a hand-written is_admin() guard; the same advisory
-- lock as the share RPCs. NULL clears both pieces ("not worked out yet").
-- No audit_log row: log_payout_row_change() records each line's old and new
-- residual, attributed to the admin, which is the granularity the residual
-- module already chose.
create or replace function set_shared_residual(
  rep_share_id_input int,
  period_input       date,
  amount_input       numeric
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  primaries   int;
  secondaries int;
begin
  if not is_admin() then
    raise exception 'admin only' using errcode = 'PT403';
  end if;

  perform pg_advisory_xact_lock(hashtext('tapswipe.merchant_rep_shares'));

  if rep_share_id_input is null or period_input is null then
    raise exception 'A share and a month are required.' using errcode = '22023';
  end if;

  if amount_input is not null and amount_input <> round(amount_input, 2) then
    raise exception 'The account residual must be in whole cents.'
      using errcode = '22023';
  end if;

  perform 1 from rep_payout_rows
   where rep_share_id = rep_share_id_input and period = period_input
   for update;

  select count(*) filter (where share_role = 'primary'),
         count(*) filter (where share_role = 'secondary')
    into primaries, secondaries
    from rep_payout_rows
   where rep_share_id = rep_share_id_input and period = period_input;

  if primaries <> 1 or secondaries <> 1 then
    raise exception 'There is no shared pair for that share in that month.'
      using errcode = 'PT404';
  end if;

  perform set_config('tapswipe.shared_write', 'on', true);

  update rep_payout_rows
     set account_residual_income = amount_input,
         residual_income = case share_role
           when 'secondary' then
             shared_part(amount_input, secondary_rep_pct,
                         primary_rep_pct + secondary_rep_pct)
           else
             amount_input
             - shared_part(amount_input, secondary_rep_pct,
                           primary_rep_pct + secondary_rep_pct)
         end
   where rep_share_id = rep_share_id_input and period = period_input;

  perform set_config('tapswipe.shared_write', '', true);
end;
$$;

revoke all on function set_shared_residual(int, date, numeric) from public;
grant execute on function set_shared_residual(int, date, numeric)
  to authenticated, service_role;
