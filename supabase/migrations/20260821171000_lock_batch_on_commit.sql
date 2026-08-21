-- Make commit_residual_import genuinely idempotent, not idempotent-if-you-are-slow.
--
-- Mirrors docs/tapswipe_crm_schema.sql, which is the spec.
--
-- The function has always refused a second commit: `if batch.status <> 'review'`
-- raises PT409, and tests/rls/commit-residual-import.test.ts has asserted
-- "cannot be committed twice" since 20260817110000. That test passes, and it was
-- never wrong -- it just cannot express the case that breaks, because PGlite is a
-- single connection and the failure needs two.
--
-- Reproduced against real Postgres with two deliberately overlapping
-- transactions (session A calls the function and holds its transaction open;
-- session B calls it before A commits):
--
--   A returned 1
--   B returned 1
--   audit_rows = 2   ledger_rows = 1   status = committed
--
-- Both callers were told they imported a row, and audit_log -- the table whose
-- entire job is to be the authoritative trail -- recorded one commit twice.
--
-- Why the guard did not hold: `select * into batch ... ` took no row lock, so
-- both transactions read status = 'review' and both passed the check. A guard on
-- a value that can change between the read and the write is not a guard. Under
-- READ COMMITTED B's later statements then re-read fresh, so B's
-- `insert ... select` still saw the staging rows A had not yet committed a delete
-- for, upserted over the row A had just written, blocked on A's row lock at the
-- `update rep_payout_batches`, and finally wrote its own audit row.
--
-- What saved the ledger was the unique index on (period, agent_id, mid) plus the
-- `on conflict do update`: the second write updated the row rather than
-- duplicating it. That is luck of a good schema, not idempotency of this
-- function, and it would not have saved the two money columns if the values had
-- differed between the two calls.
--
-- `for update` fixes it by making the read authoritative: B blocks at the SELECT
-- until A commits, then reads status = 'committed' and raises PT409 like any
-- other second commit. No deadlock risk -- this is the first and only lock the
-- function takes, so there is no ordering to get wrong.
--
-- Everything else in the body is unchanged; the coalesce() merge rule on the two
-- money columns in particular is byte-for-byte what 20260817110000 established.
-- Reverse those arguments and every re-import silently clears a month of
-- hand-entered residuals, which is why tests/rls/commit-residual-import.test.ts
-- greps the function body for it.
create or replace function commit_residual_import(batch_id_input int)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  batch    rep_payout_batches;
  blocked  int;
  staged   int;
  imported int;
begin
  if not is_admin() then
    raise exception 'admin only' using errcode = 'PT403';
  end if;

  -- The one line this migration exists for. See the header.
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

  -- Refused rather than treated as a trivial success. Flipping a batch to
  -- 'committed' having imported nothing reads as a successful import of an empty
  -- month, which is worse than an error someone has to read.
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
    -- THE MERGE RULE. excluded first, existing second: the file wins when it
    -- carries a figure, the hand-entered value survives when it does not.
    -- Reversed, every re-import wipes a month of typed-in residuals silently.
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

-- Re-stated because create or replace does not preserve them being *checked*:
-- the grants persist across a replace, but stating them keeps the privilege
-- surface greppable in one place per function, per the rule in the spec.
revoke all on function commit_residual_import(int) from public;
grant execute on function commit_residual_import(int) to authenticated, service_role;
