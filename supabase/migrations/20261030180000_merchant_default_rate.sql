-- A merchant created without a split rate takes its owner's profile rate.
-- Decision A31 of docs/design/intake-and-reports.md (30 Oct 2026), built
-- with phase 9.
--
-- Matches docs/tapswipe_crm_schema.sql, updated first; the block below is
-- copied from it verbatim.
--
-- =====================================================================
-- MERCHANT DEFAULT RATE (20261030180000) — a merchant created without a
-- split rate takes its owner's CURRENT profile rate, as a snapshot (memo
-- A31, §0b.4).
--
-- Until now a merchant an admin created by hand (the merchant form) had no
-- rate at all, and commit_residual_import_v3 refused its MID until someone
-- remembered set_merchant_split. Approval never had the gap: submit_pre_app()
-- snapshots the rep's rate onto the pre-app and approve_pre_app() copies it.
-- This gives the hand-made merchant the same rule at the moment it is made.
--
-- default_merchant_split(), BEFORE INSERT on merchants:
--   * only when BOTH split columns arrive NULL. A rate the insert carries
--     (approve_pre_app's snapshot) is kept as it is; a half-filled pair is
--     left for merchants_split_zero_to_fifty to refuse.
--   * split_agent_pct := the owner's profiles.split_rate_pct,
--     split_company_pct := 100 minus it. The house profile (rate 0) gives
--     0 / 100: the company keeps all of it, and v3 still writes its line.
--   * NO RATE IS INVENTED. An owner with no profile row, or no rate on it,
--     refuses the insert (PT409, a sentence for the form). split_rate_pct is
--     NOT NULL today, so this is the backstop for an owner that does not
--     exist (agent_id NULL or unknown -- the trigger runs before the NOT NULL
--     and foreign-key checks) and for any future change to that column.
--   * A SNAPSHOT. Nothing ties the merchant to the profile afterwards:
--     set_rep_split changes the rep's rate for merchants created later, and
--     set_merchant_split (audited, refused while a share is live) is the one
--     way to change this merchant's.
--   * INSERT only. UPDATE stays guard_merchant_split_and_owner()'s: moving a
--     merchant to another rep does NOT re-rate it (the rate is the merchant's
--     snapshot, not the owner's).
--   * Security DEFINER, deliberately, though it only reads. A BEFORE
--     trigger runs before RLS's WITH CHECK, so an invoker copy, run for a
--     rep inserting a merchant into another rep's book, could not see that
--     profile and would refuse with "the owner has no split rate" -- a
--     false sentence about someone else's profile -- where the "admin
--     insert only" policy must be what refuses. As definer it reads the
--     true rate and the policy decides, exactly as before. It reads one
--     column of one row and writes only NEW; no client may call it.
--   * No backfill. Merchants that already have no rate keep none, and v3
--     keeps refusing their MIDs until set_merchant_split gives them one: a
--     rate given now would not be the one in force when they were made.
-- =====================================================================

create or replace function default_merchant_split()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  rate numeric(5,2);
begin
  if new.split_agent_pct is not null or new.split_company_pct is not null then
    return new;
  end if;

  select p.split_rate_pct into rate from profiles p where p.id = new.agent_id;

  if rate is null then
    raise exception 'This merchant''s owner has no split rate on their profile, so the merchant has none to take. Set the rep''s rate in Manage Users, then create the merchant.'
      using errcode = 'PT409';
  end if;

  new.split_agent_pct := rate;
  new.split_company_pct := 100 - rate;
  return new;
end;
$$;

revoke all on function default_merchant_split() from public;
revoke all on function default_merchant_split() from anon, authenticated;

create trigger merchants_default_split
  before insert on merchants
  for each row execute function default_merchant_split();
