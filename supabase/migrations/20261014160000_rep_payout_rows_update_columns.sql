-- Phase 3b of docs/design/residual-splits.md: authenticated's UPDATE on
-- rep_payout_rows narrows from the whole table to the two columns an admin
-- edits by hand. Matches the rep_payout_rows grant in
-- docs/tapswipe_crm_schema.sql, updated first; its reasoning is there.
--
-- Every path that writes another column is unaffected, and was checked before
-- this was written:
--   * commit_residual_import (security definer) -- the file-sourced columns,
--     merged with ON CONFLICT DO UPDATE;
--   * set_shared_residual (security definer) -- the shared pair's residual;
--   * merchant_id / batch_id ON DELETE SET NULL -- FK actions run as the
--     table owner;
--   * the service role (seed scripts, test teardowns) -- keeps `grant all`.
-- The client paths -- the inline figure cell, the bulk split, and the
-- partner-rate copy trigger that runs inside them as security invoker --
-- write only residual_income and rep_split_pct.
--
-- REVOKE of the table-level privilege also revokes any column-level UPDATE
-- (there is none today), so the grant below is the whole surface afterwards.
-- SELECT and DELETE are untouched; service_role is untouched.

revoke update on rep_payout_rows from authenticated;
grant update (residual_income, rep_split_pct) on rep_payout_rows to authenticated;
