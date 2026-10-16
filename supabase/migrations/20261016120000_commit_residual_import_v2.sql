-- commit_residual_import_v2: the shared-account-aware commit, beside the old
-- one, plus the old one's share guard and the batch skip record. Phase 4 of
-- docs/design/residual-splits.md (database half; the app switch is phase 4b).
--
-- Matches docs/tapswipe_crm_schema.sql, updated first; the block below is
-- copied from it verbatim.
--
-- =====================================================================
-- COMMIT V2 (20261016120000) — the shared-account-aware commit.
-- Phase 4 of docs/design/residual-splits.md, §5.1 and §5.4.
--
-- commit_residual_import_v2(batch_id_input int) returns jsonb
--   {"written": n, "skipped": m}, and n + m is the number of staged rows.
--
-- A NEW FUNCTION BESIDE THE OLD ONE, not a replacement. create or replace
-- cannot change a return type (int -> jsonb), and the old name must keep
-- working for an app version still deployed somewhere. The app switches to
-- v2 in phase 4b; the old function is dropped in phase 9, once the three
-- conditions in design §5.1 hold.
--
-- FOR A BATCH WITH NO SHARED ACCOUNT, v2 IS THE OLD COMMIT. Same guards in the
-- same order and with the same messages, the same `for update` on the batch,
-- the same upsert -- its text is the old statement's plus ONE predicate that
-- keeps shared and skipped rows out of it -- the same staging delete, status
-- flip and row_count, and the same single audit row, deliberately under the
-- same action name: it is the same event, and an audit reader filtering on
-- 'commit_residual_import' must not lose commits made through v2. `written` is
-- the old function's return value. tests/rls/commit-residual-import-v2.test.ts
-- runs one sequence of batches through both and requires identical ledger,
-- history, audit and batch rows.
--
-- WHAT IT ADDS. After the old guards and the batch lock it takes the share
-- lock -- pg_advisory_xact_lock(hashtext('tapswipe.merchant_rep_shares')),
-- the lock every share RPC and set_shared_residual take -- and only then reads
-- merchant_rep_shares. A share edit and a commit therefore cannot interleave:
-- whichever starts second waits, then sees the other's committed state. (A
-- share RPC refuses a boundary at or before a committed month, so a share
-- started while a commit waited on the lock is refused for that month rather
-- than left disagreeing with it.) PGlite is a single connection, so this was
-- checked by hand against real Postgres with two psql sessions.
--
-- Each staged row is then planned, once, into a temp table, before anything
-- is written -- so no row's plan depends on another row's write:
--
--   ordinary  no share covers this MID in this month, OR the file names a
--             rep outside the pair. Through the old upsert, unchanged. (The
--             third-rep case is "share not applied" -- flagged at preview,
--             phase 4b, and imported for the rep the file names.)
--   shared    the file names the SIGNER. Two lines: the signer's, upserted
--             with the file's own columns, and the partner's, inserted.
--   skipped   recorded on the batch, never silently dropped:
--     partner_named    the file names the PARTNER. That key, (month,
--                      partner, MID), belongs to the partner's shared line
--                      whether or not the pair exists yet; importing the row
--                      as an ordinary line would break the pair the first
--                      time the signer's row arrived.
--     line_not_shared  either key of the pair already holds a line that is
--                      not this share's line in that role. The month rule
--                      makes that unreachable through the RPCs (a share can
--                      only start after the MID's last committed month), so
--                      it means a hand-made or old-commit line -- and
--                      building half a pair on it would be worse than
--                      skipping the row.
--
-- "Covers" means: the share on the merchant whose CURRENT merchants.mid is the
-- row's MID, with period in [effective_from, effective_to). Commit is
-- authoritative; a preview is advisory, and a share can change between them.
--
-- THE SHARED LINES, FIRST COMMIT. Signer: merchant name, merchant id, volume,
-- average ticket, total cost and batch from the file; the share snapshot.
-- Partner: the same merchant name and id, NO volume, average ticket or total
-- cost (the account's volume is counted once, on the signer's line), the same
-- snapshot. Residual and rate are NULL on both -- "not worked out yet" -- and
-- are set afterwards by set_shared_residual() and an edit of the signer's
-- rate, which copies itself across. A residual or rate the FILE supplies for
-- a shared line is IGNORED, on first commit and on re-import alike (design
-- Q11; the preview flags it in phase 4b): those figures describe one rep's
-- line and there is no single line here for them to describe.
--
-- If the partner's line has gone missing while the signer's survives (an
-- admin may delete a line), it is re-created from the signer's line -- its
-- account residual, its piece of it, and the signer's rate -- so the pair is
-- whole again rather than permanently half.
--
-- RE-IMPORT NEVER OVERWRITES A DIVIDED LINE (design §5.3, requirement R-1).
-- On conflict only the SIGNER line's file columns are updated (merchant name,
-- merchant id, volume, average ticket, total cost, batch). residual_income,
-- account_residual_income, rep_split_pct and every share column are never
-- written on conflict, on either line, and the partner's insert is `do
-- nothing`. This is the shared counterpart of THE COALESCE above, and like it,
-- its reversal would be quiet for the rate: guard_shared_line() refuses a
-- write to either residual piece, but it ADMITS a change to the signer's rate
-- -- that is the sanctioned edit -- and the rate-copy trigger would then carry
-- a file's figure onto the partner too. The test reverts this rule and
-- watches R-1 go red.
--
-- SKIPPED ROWS are stored on the batch before the staging rows are deleted:
-- rep_payout_batches.skipped_rows, a jsonb array of
--   {row_number, period, mid, agent_number, reason}
-- in sheet-row order -- the memo's four keys plus period, because a batch is
-- not tied to one month and phase 4b lists skips on each period page. Only
-- identifiers already in the admin's own file; no figure, no name. An admin
-- acknowledges them through acknowledge_residual_skips() (phase 4b), which
-- sets skips_acknowledged_at; NULL there with a non-empty array means a skip
-- nobody has reviewed yet. The column is admin-only like the rest of the
-- batch (select policy is_admin()); narrowing the batch UPDATE grant to
-- (status), so an admin's PATCH cannot clear a skip record, is phase 4b's,
-- with the acknowledgement it protects.
--
-- `security definer` for the old function's three reasons (no INSERT policy
-- on the ledger, no DELETE on staging, no INSERT on audit_log at all), with a
-- hand-written is_admin() guard as the first statement and search_path
-- pinned. The temp table is pg_temp-qualified on create and drop, so the drop
-- can never reach a table in public.
-- =====================================================================

alter table rep_payout_batches
  add column skipped_rows jsonb not null default '[]'::jsonb,
  add column skips_acknowledged_at timestamptz;

alter table rep_payout_batches
  add constraint rep_payout_batches_skipped_rows_array
    check (jsonb_typeof(skipped_rows) = 'array');

-- ---------------------------------------------------------------------
-- The old commit, re-created with ONE guard (design §5.1): a batch that
-- contains a row a share covers is refused, so an app still calling this
-- name can never write a shared MID as one ordinary signer line -- the one
-- outcome the shared-account design exists to prevent. The guard takes the
-- same share lock as v2 before it looks, so a share created while this commit
-- runs either waits for it (and is then refused for the committed month) or
-- is seen by it. Everything else is byte-for-byte the previous body, comments
-- included; with no shares it behaves exactly as before, and
-- tests/rls/commit-residual-import.test.ts runs against it unchanged.
-- ---------------------------------------------------------------------
create or replace function commit_residual_import(batch_id_input int)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  batch      rep_payout_batches;
  blocked    int;
  staged     int;
  imported   int;
begin
  if not is_admin() then
    raise exception 'admin only' using errcode = 'PT403';
  end if;

  -- `for update` is load-bearing, not defensive habit. Without it two
  -- concurrent commits of the same batch BOTH observe status = 'review' and
  -- both proceed: the ledger survives (the upsert on (period, agent_id, mid)
  -- makes the insert idempotent) but audit_log gets two rows for one commit,
  -- committed_at is overwritten, and both callers are told they succeeded.
  -- Reproduced deliberately with two overlapping transactions -- 2 audit rows,
  -- both returning 1. The status check below is only a guard if the row it read
  -- cannot change underneath it, so the lock is what makes this function
  -- genuinely idempotent rather than idempotent-if-you-click-slowly.
  select * into batch from rep_payout_batches where id = batch_id_input for update;
  if not found then
    raise exception 'import not found' using errcode = 'PT404';
  end if;

  if batch.status <> 'review' then
    raise exception 'this import is already %', batch.status
      using errcode = 'PT409';
  end if;

  select count(*) into staged
    from rep_payout_import_rows where batch_id = batch_id_input;

  -- Refused rather than treated as a trivial success: flipping a batch to
  -- 'committed' having imported nothing reads as a successful import of an empty
  -- month, which is worse than an error.
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

  -- THE SHARE GUARD (20261016120000), the one addition.
  perform pg_advisory_xact_lock(hashtext('tapswipe.merchant_rep_shares'));

  if exists (
    select 1
      from rep_payout_import_rows r
      join merchants m on m.mid = r.mid_raw
      join merchant_rep_shares s
        on s.merchant_id = m.id
       and r.period >= s.effective_from
       and (s.effective_to is null or r.period < s.effective_to)
     where r.batch_id = batch_id_input
  ) then
    raise exception 'This import contains shared accounts. Reload the page to commit it.'
      using errcode = 'PT409';
  end if;

  insert into rep_payout_rows (
    agent_id, period, mid, merchant_name, merchant_id,
    volume, average_ticket, total_cost,
    residual_income, rep_split_pct, batch_id
  )
  select
    r.agent_id, r.period, r.mid_raw, r.merchant_name_raw, r.merchant_id,
    r.volume, r.average_ticket, r.total_cost,
    r.residual_income, r.rep_split_pct, batch_id_input
    from rep_payout_import_rows r
   where r.batch_id = batch_id_input
  on conflict (period, agent_id, mid) do update set
    merchant_name   = excluded.merchant_name,
    merchant_id     = excluded.merchant_id,
    volume          = excluded.volume,
    average_ticket  = excluded.average_ticket,
    total_cost      = excluded.total_cost,
    -- See THE COALESCE above. Kept, not cleared, unless the file said otherwise.
    residual_income = coalesce(excluded.residual_income,
                               rep_payout_rows.residual_income),
    rep_split_pct   = coalesce(excluded.rep_split_pct,
                               rep_payout_rows.rep_split_pct),
    batch_id        = excluded.batch_id;

  get diagnostics imported = row_count;

  delete from rep_payout_import_rows where batch_id = batch_id_input;

  update rep_payout_batches
     set status = 'committed', committed_at = now(), row_count = staged
   where id = batch_id_input;

  insert into audit_log (actor_id, action, table_name, row_id)
  values (auth.uid(), 'commit_residual_import', 'rep_payout_batches',
          batch_id_input::text);

  return imported;
end;
$$;

revoke all on function commit_residual_import(int) from public;
grant execute on function commit_residual_import(int) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- commit_residual_import_v2. See the header of this block.
-- ---------------------------------------------------------------------
create or replace function commit_residual_import_v2(batch_id_input int)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  batch       rep_payout_batches;
  blocked     int;
  staged      int;
  ordinary    int;
  shared      int;
  skipped     int;
  skip_record jsonb;
begin
  if not is_admin() then
    raise exception 'admin only' using errcode = 'PT403';
  end if;

  -- The old function's guards, in its order, with its messages.
  select * into batch from rep_payout_batches where id = batch_id_input for update;
  if not found then
    raise exception 'import not found' using errcode = 'PT404';
  end if;

  if batch.status <> 'review' then
    raise exception 'this import is already %', batch.status
      using errcode = 'PT409';
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

  -- 1. The share lock, before merchant_rep_shares is read.
  perform pg_advisory_xact_lock(hashtext('tapswipe.merchant_rep_shares'));

  -- 2. The plan: every staged row, its share (if one covers it), and what
  -- happens to it. Taken before any write.
  drop table if exists pg_temp.residual_commit_plan;

  create temporary table residual_commit_plan on commit drop as
  select r.id as staging_id,
         r.row_number,
         r.period,
         r.mid_raw,
         r.agent_number_raw,
         s.id as share_id,
         s.secondary_agent_id,
         s.primary_rep_pct,
         s.secondary_rep_pct,
         case
           when s.id is null then 'ordinary'
           when r.agent_id = s.secondary_agent_id then 'partner_named'
           when r.agent_id <> s.primary_agent_id then 'ordinary'
           when exists (
             select 1 from rep_payout_rows l
              where l.period = r.period
                and l.mid = r.mid_raw
                and l.agent_id in (s.primary_agent_id, s.secondary_agent_id)
                and (l.rep_share_id is distinct from s.id
                     or l.share_role is distinct from
                        case when l.agent_id = s.primary_agent_id
                             then 'primary' else 'secondary' end)
           ) then 'line_not_shared'
           else 'shared'
         end as plan
    from rep_payout_import_rows r
    left join merchants m on m.mid = r.mid_raw
    left join merchant_rep_shares s
      on s.merchant_id = m.id
     and r.period >= s.effective_from
     and (s.effective_to is null or r.period < s.effective_to)
   where r.batch_id = batch_id_input;

  -- 3. Ordinary rows: the old upsert, with one predicate added.
  insert into rep_payout_rows (
    agent_id, period, mid, merchant_name, merchant_id,
    volume, average_ticket, total_cost,
    residual_income, rep_split_pct, batch_id
  )
  select
    r.agent_id, r.period, r.mid_raw, r.merchant_name_raw, r.merchant_id,
    r.volume, r.average_ticket, r.total_cost,
    r.residual_income, r.rep_split_pct, batch_id_input
    from rep_payout_import_rows r
   where r.batch_id = batch_id_input
     and r.id in (select p.staging_id from pg_temp.residual_commit_plan p
                   where p.plan = 'ordinary')
  on conflict (period, agent_id, mid) do update set
    merchant_name   = excluded.merchant_name,
    merchant_id     = excluded.merchant_id,
    volume          = excluded.volume,
    average_ticket  = excluded.average_ticket,
    total_cost      = excluded.total_cost,
    -- THE COALESCE. Kept, not cleared, unless the file said otherwise.
    residual_income = coalesce(excluded.residual_income,
                               rep_payout_rows.residual_income),
    rep_split_pct   = coalesce(excluded.rep_split_pct,
                               rep_payout_rows.rep_split_pct),
    batch_id        = excluded.batch_id;

  get diagnostics ordinary = row_count;

  -- 4a. Shared rows, the signer's line. The file's residual and rate are not
  -- read: NULL on insert, and on conflict only the file columns are written.
  insert into rep_payout_rows (
    agent_id, period, mid, merchant_name, merchant_id,
    volume, average_ticket, total_cost,
    residual_income, rep_split_pct, batch_id,
    rep_share_id, share_role, primary_rep_pct, secondary_rep_pct,
    account_residual_income
  )
  select
    r.agent_id, r.period, r.mid_raw, r.merchant_name_raw, r.merchant_id,
    r.volume, r.average_ticket, r.total_cost,
    null, null, batch_id_input,
    p.share_id, 'primary', p.primary_rep_pct, p.secondary_rep_pct,
    null
    from rep_payout_import_rows r
    join pg_temp.residual_commit_plan p on p.staging_id = r.id
   where r.batch_id = batch_id_input
     and p.plan = 'shared'
  on conflict (period, agent_id, mid) do update set
    -- NEVER THE MONEY ON CONFLICT (design §5.3). File columns only.
    merchant_name   = excluded.merchant_name,
    merchant_id     = excluded.merchant_id,
    volume          = excluded.volume,
    average_ticket  = excluded.average_ticket,
    total_cost      = excluded.total_cost,
    batch_id        = excluded.batch_id;

  get diagnostics shared = row_count;

  -- 4b. The partner's line, from the signer's line as it now stands: on a
  -- first commit that carries no figures; if only the partner's line was
  -- missing, it is rebuilt from the signer's account figure and rate.
  insert into rep_payout_rows (
    agent_id, period, mid, merchant_name, merchant_id,
    volume, average_ticket, total_cost,
    residual_income, rep_split_pct, batch_id,
    rep_share_id, share_role, primary_rep_pct, secondary_rep_pct,
    account_residual_income
  )
  select
    p.secondary_agent_id, sl.period, sl.mid, sl.merchant_name, sl.merchant_id,
    null, null, null,
    shared_part(sl.account_residual_income, sl.secondary_rep_pct,
                sl.primary_rep_pct + sl.secondary_rep_pct),
    sl.rep_split_pct, batch_id_input,
    sl.rep_share_id, 'secondary', sl.primary_rep_pct, sl.secondary_rep_pct,
    sl.account_residual_income
    from pg_temp.residual_commit_plan p
    join rep_payout_import_rows r on r.id = p.staging_id
    join rep_payout_rows sl
      on sl.period = p.period
     and sl.agent_id = r.agent_id
     and sl.mid = p.mid_raw
     and sl.rep_share_id = p.share_id
     and sl.share_role = 'primary'
   where p.plan = 'shared'
  on conflict (period, agent_id, mid) do nothing;

  -- 5. What was not applied, kept on the batch.
  select count(*),
         coalesce(jsonb_agg(jsonb_build_object(
                    'row_number',   p.row_number,
                    'period',       to_char(p.period, 'YYYY-MM-DD'),
                    'mid',          p.mid_raw,
                    'agent_number', p.agent_number_raw,
                    'reason',       p.plan)
                  order by p.row_number), '[]'::jsonb)
    into skipped, skip_record
    from pg_temp.residual_commit_plan p
   where p.plan in ('partner_named', 'line_not_shared');

  drop table pg_temp.residual_commit_plan;

  -- 6. As the old function: staging delete, status flip, one audit row.
  delete from rep_payout_import_rows where batch_id = batch_id_input;

  update rep_payout_batches
     set status = 'committed', committed_at = now(), row_count = staged,
         skipped_rows = skip_record
   where id = batch_id_input;

  insert into audit_log (actor_id, action, table_name, row_id)
  values (auth.uid(), 'commit_residual_import', 'rep_payout_batches',
          batch_id_input::text);

  return jsonb_build_object('written', ordinary + shared, 'skipped', skipped);
end;
$$;

revoke all on function commit_residual_import_v2(int) from public;
grant execute on function commit_residual_import_v2(int) to authenticated, service_role;
