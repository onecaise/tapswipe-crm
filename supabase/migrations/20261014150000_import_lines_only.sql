-- No adjustment lines until phase 5 of docs/design/residual-splits.md swaps
-- the merge key for its partial index.
--
-- Matches docs/tapswipe_crm_schema.sql, updated first; the block below is
-- copied from it verbatim.
--
-- =====================================================================
-- IMPORT LINES ONLY, UNTIL PHASE 5 (20261014150000).
--
-- The adjustment branch of rep_payout exists (20261014140000) so the column is
-- rewritten once, but NO ROW MAY BE AN ADJUSTMENT LINE YET. The merge key is
-- still the ordinary unique (period, agent_id, mid), so an adjustment posted
-- on a MID that already has an import line in the same month would collide
-- with it -- or, worse, be silently merged into it by the commit's
-- `on conflict (period, agent_id, mid) do update`, overwriting the file-
-- sourced columns of a line nobody meant to touch. Phase 5 swaps that key for
-- `unique (period, agent_id, mid) where line_kind = 'import'` and DROPS THIS
-- CONSTRAINT IN THE SAME MIGRATION; never one without the other.
--
-- The guard (guard_shared_line) already refuses turning an existing line into
-- an adjustment by UPDATE. This covers INSERT, which the guard does not see --
-- the commit runs as definer and the service role holds every privilege, so a
-- constraint is the one layer every writer meets.
--
-- Validated, not NOT VALID: line_kind arrived in 20261014140000 with the
-- constant default 'import' and that migration checks every existing row is
-- 'import', so there is nothing it could fail on.
--
-- Until then the adjustment branch is exercised against a scratch table built
-- from the migration's own expression text (tests/rls/shared-lines.test.ts).
-- =====================================================================

alter table rep_payout_rows
  add constraint rep_payout_rows_import_lines_only
    check (line_kind = 'import');
