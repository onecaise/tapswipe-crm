-- A signed-in user may move a residual import batch only from review to
-- abandoned. Item C of the phase 5 brief (docs/design/residual-splits.md).
--
-- Matches docs/tapswipe_crm_schema.sql, updated first; the block below is
-- copied from it verbatim.
--
-- =====================================================================
-- BATCH STATUS TRANSITIONS (20261016170000) — a signed-in user may move a
-- residual import batch from 'review' to 'abandoned', and make no other
-- change to a batch at all.
--
-- The UPDATE grant (20261016140000) stops a client writing any column but
-- status. It cannot say WHICH status: a grant sees columns, never values, and
-- the "admin abandons" policy only asks whether the caller is an admin. So an
-- admin's session could PATCH a committed batch back to 'review' -- after which
-- it can be parsed again (parse-residual-import only refuses a batch that is
-- not in review) and committed a second time, re-importing a month that has
-- already landed -- or straight to 'committed' with nothing imported, which
-- reads as a successful import that never happened, the exact state the
-- commit's `staged = 0` refusal exists to prevent. Or flip an abandoned batch
-- back into review.
--
-- guard_batch_status_transition(), a BEFORE UPDATE trigger, refuses (PT409)
-- every update a SIGNED-IN USER makes to a batch unless it is review ->
-- abandoned. "Signed-in user" is current_user = 'authenticated': the role
-- PostgREST runs every client request as. The legitimate other writers are
-- untouched by construction, because none of them runs as that role:
--   * both commit functions and acknowledge_residual_skips() are security
--     definer, so their statements run as the function owner;
--   * residual-import-file-url and parse-residual-import write through the
--     service role (file_key, status, row_count, adjustment_rows_ignored).
-- A plain BEFORE UPDATE, not `update of status`: the grant means every client
-- update names status today, but "everything else is refused" should not
-- depend on the grant staying that narrow. The trigger is security INVOKER --
-- it needs no privilege, and current_user must be the caller's.
--
-- The one client writer, abandonResidualBatch() (lib/residual-batches.ts),
-- writes review -> abandoned and nothing else; pointed at a batch that is not
-- in review it now gets this sentence rather than a silent rewrite.
-- =====================================================================

create or replace function guard_batch_status_transition()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if current_user = 'authenticated'
     and not (old.status = 'review' and new.status = 'abandoned') then
    raise exception 'Only an import still in review can be changed here, and only to abandoned. This one is %.', old.status
      using errcode = 'PT409';
  end if;
  return new;
end;
$$;

revoke all on function guard_batch_status_transition() from public;

create trigger rep_payout_batches_status_transition
  before update on rep_payout_batches
  for each row execute function guard_batch_status_transition();
