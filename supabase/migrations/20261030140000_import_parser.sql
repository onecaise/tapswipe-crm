-- The import parser: processor and month required on every new residual
-- import batch, the staging columns the six-column file needs, every
-- refusal per staged row, the narrowed blocker vocabulary and the
-- payee_changed note. Phase 7 of docs/design/intake-and-reports.md.
--
-- Matches docs/tapswipe_crm_schema.sql, updated first; the block below is
-- copied from it verbatim.
--
-- =====================================================================
-- IMPORT PARSER (20261030140000) — the database half of phase 7 of
-- docs/design/intake-and-reports.md (§1.G, §2.2, §2.4): the six-column
-- processor file, the payee found by MID, the new refusals and warnings,
-- and processor and month REQUIRED on every new batch.
--
--   rep_payout_batches
--     PROCESSOR AND MONTH ARE REQUIRED ON NEW BATCHES. Phase 6 left both
--       nullable because the upload did not send them; residual-import-
--       file-url now always does. Not a NOT NULL, because review and
--       abandoned batches started before this migration have neither, and
--       there is no honest value to give them (memo §1.B wants not null;
--       the conservative reading is "every batch from now on"):
--       * require_payout_batch_month() (BEFORE INSERT OR UPDATE) refuses an
--         INSERT without a processor and month (PT400), an UPDATE that
--         clears them, and an UPDATE to 'committed' of a batch that has
--         none (PT409, "abandon it and upload the file again").
--       * rep_payout_batches_month_when_committed: CHECK (status not in
--         ('committed', 'replaced') or processor is not null) -- the
--         structural backstop, VALIDATED, because the migration first
--         refuses any committed batch that lacks them (below). With
--         rep_payout_batches_processor_period_together, processor implies
--         period.
--       A legacy review batch is therefore left exactly as it is: it can
--       still be abandoned (the one client transition), but it can be
--       neither committed (the trigger and the CHECK) nor read again
--       (parse-residual-import refuses a batch with no processor, 409).
--       A legacy abandoned batch is inert and stays so.
--
--   rep_payout_import_rows (staging)
--     processor_raw, income_type_raw text: the file's Processor and Income
--       Type cells, kept raw for the review screen (memo §2.2).
--     blockers text[] not null default '{}': EVERY refusal a row trips, so
--       the review screen lists every unknown MID, every repeat and every
--       wrong Income Type even when one row trips several. `blocker` stays
--       the single code v2 (and v3) test with `blocker is not null`: the
--       first of `blockers` by the parser's precedence.
--       * rep_payout_import_rows_blockers_vocabulary: each element one of
--         the seven codes below.
--       * rep_payout_import_rows_blockers_need_blocker: a row with any
--         element in `blockers` has a `blocker`, so a writer cannot list a
--         refusal and leave the row committable.
--       * rep_payout_import_rows_blocker_in_blockers: when both are set,
--         `blocker` is one of `blockers`.
--     blocker vocabulary NARROWED to the memo's seven (§2.4):
--       missing_mid, unknown_mid, duplicate_mid, mid_in_other_batch,
--       wrong_income_type, missing_figure, unreadable_number. The four
--       retired codes (unknown_agent, unparseable_period, bad_number,
--       duplicate_in_file) went with the Agent # parser.
--     preview_flag gains 'payee_changed' (memo A10): informational, never
--       a blocker -- "last month this MID paid Ann Ito; this month it pays
--       Bo Lee, the merchant's current owner". 'looks_shared' is no longer
--       written and stays allowed only so a staged row from before this
--       migration still satisfies the CHECK.
--
-- WHAT THIS DOES NOT DO: the commit is still v2, which neither reads
-- `warnings` nor checks a staged row's period against the batch's; v3
-- (phase 8) recomputes and enforces both. The replace (phase 9) is not
-- built: the upload refuses a second file for a committed processor-month.
--
-- REFUSES TO RUN over rows it cannot carry, naming them, and otherwise
-- changes no existing row:
--   1. a committed (or replaced) batch with no processor and month, by id:
--      it would be outside the one-committed rule and the replace for
--      good, and only a person can say which processor and month it was;
--   2. a staged row carrying a retired blocker code, by batch id: no code
--      can describe it any more. Abandon the batch, delete its staged rows,
--      and upload the file again.
-- Not "the tables must be empty" (the phase 1 lesson).
-- =====================================================================

-- 0. What this migration cannot carry, named.
do $$
declare
  bad text;
begin
  select string_agg(id::text, ', ' order by id) into bad
    from rep_payout_batches
   where status in ('committed', 'replaced') and processor is null;
  if bad is not null then
    raise exception 'import parser migration refuses to run: committed rep_payout_batches % have no processor and month. Set both on each (processor, period) by hand, or remove the batch deliberately, then re-run.', bad;
  end if;

  select string_agg(distinct batch_id::text, ', ') into bad
    from rep_payout_import_rows
   where blocker in ('unknown_agent', 'unparseable_period', 'bad_number',
                     'duplicate_in_file');
  if bad is not null then
    raise exception 'import parser migration refuses to run: staged rows in rep_payout_batches % carry a retired blocker code. Abandon those batches, delete their staged rows, and upload the files again, then re-run.', bad;
  end if;
end $$;

-- 1. Batches: processor and month required from now on.
alter table rep_payout_batches
  add constraint rep_payout_batches_month_when_committed
    check (status not in ('committed', 'replaced') or processor is not null);

-- Invoker: it reads only the row being written.
create or replace function require_payout_batch_month()
returns trigger
language plpgsql
set search_path = public, pg_temp
as $$
begin
  if tg_op = 'INSERT' then
    if new.processor is null or new.period is null then
      raise exception 'A residual import needs its processor and month. Choose both when uploading the file.'
        using errcode = 'PT400';
    end if;
    return new;
  end if;

  if old.processor is not null and new.processor is null then
    raise exception 'An import''s processor and month cannot be cleared.'
      using errcode = 'PT400';
  end if;
  if new.status = 'committed' and new.processor is null then
    raise exception 'This import was started before the processor and month were chosen at upload, so it cannot be committed. Abandon it and upload the file again.'
      using errcode = 'PT409';
  end if;
  return new;
end;
$$;

revoke all on function require_payout_batch_month() from public;

create trigger rep_payout_batches_require_month
  before insert or update on rep_payout_batches
  for each row execute function require_payout_batch_month();

-- 2. Staging: the raw cells, every refusal per row, the narrowed codes.
alter table rep_payout_import_rows
  add column processor_raw text,
  add column income_type_raw text,
  add column blockers text[] not null default '{}'
    constraint rep_payout_import_rows_blockers_vocabulary
      check (blockers <@ array['missing_mid', 'unknown_mid', 'duplicate_mid',
                               'mid_in_other_batch', 'wrong_income_type',
                               'missing_figure', 'unreadable_number']::text[]);

alter table rep_payout_import_rows
  add constraint rep_payout_import_rows_blockers_need_blocker
    check (cardinality(blockers) = 0 or blocker is not null),
  add constraint rep_payout_import_rows_blocker_in_blockers
    check (blocker is null or cardinality(blockers) = 0
           or blocker = any(blockers));

alter table rep_payout_import_rows drop constraint rep_payout_import_rows_blocker_check;
alter table rep_payout_import_rows
  add constraint rep_payout_import_rows_blocker_check check (blocker in (
    'missing_mid', 'unknown_mid', 'duplicate_mid', 'mid_in_other_batch',
    'wrong_income_type', 'missing_figure', 'unreadable_number'
  ));

alter table rep_payout_import_rows
  drop constraint rep_payout_import_rows_preview_flag_check;
alter table rep_payout_import_rows
  add constraint rep_payout_import_rows_preview_flag_check check (
    preview_flag in ('share_not_applied', 'partner_named', 'line_not_shared',
                     'share_not_in_force', 'looks_shared', 'payee_changed')
  );
