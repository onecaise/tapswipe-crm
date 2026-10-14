-- shared_part(total, part, whole): the cent rule for a shared account.
--
-- Matches docs/tapswipe_crm_schema.sql, updated first. Design:
-- docs/design/residual-splits.md §4. Phase 1 of that memo's build plan: the
-- function only. No table, column or caller uses it yet.
--
-- Two reps sharing an account divide the rep side's payout. The account's
-- payout is worked out once, exactly as for one rep alone --
-- T = round(R * p / 100, 2), rep_payout_rows.rep_payout's own expression --
-- and this returns the PARTNER's piece:
--
--   partner = shared_part(T, partner_rep_pct, signer_rep_pct + partner_rep_pct)
--   signer  = T - partner
--
-- so signer + partner = T exactly, by construction.
--
-- The partner gets the whole cent nearest to T * part / whole, and an exact
-- half-cent tie goes TOWARD ZERO, so the signer's line absorbs the cent on a
-- tie, for a credit and a clawback alike. Odd in its first argument, so a
-- negative month mirrors a positive one. STRICT, so NULL stays NULL.
--
-- Integer arithmetic throughout: floor((2n + d - 1) / (2d)) via div(), with n
-- the amount in cents times part in hundredths of a percent and d the whole in
-- hundredths of a percent. That is ceil(n/d - 1/2) -- nearest, ties down -- with
-- no numeric division to reason about. Inputs finer than a cent or a hundredth
-- of a percent are refused rather than rounded.
--
-- NEVER create-or-replace this with different behaviour: from phase 3 a stored
-- generated column calls it, and Postgres keeps every value the old definition
-- computed (the dup_* normaliser trap). immutable because a generated column
-- requires it; security invoker because it reads nothing.
--
-- Pinned by tests/rls/shared-part.test.ts: every cent from -$200.00 to $200.00
-- across eight ratios.

create or replace function shared_part(total numeric, part numeric, whole numeric)
returns numeric
language plpgsql
immutable
strict
set search_path = public
as $$
declare
  n numeric;  -- |total| in cents, times part in hundredths of a percent
  d numeric;  -- whole in hundredths of a percent
begin
  if whole <= 0 then
    raise exception 'shared_part: whole must be greater than zero'
      using errcode = '22023';
  end if;

  if part < 0 or part > whole then
    raise exception 'shared_part: part must be between 0 and whole'
      using errcode = '22023';
  end if;

  if total <> round(total, 2) or part <> round(part, 2)
     or whole <> round(whole, 2) then
    raise exception 'shared_part: amounts must be whole cents and percentages whole hundredths'
      using errcode = '22023';
  end if;

  n := abs(total) * 100 * (part * 100);
  d := whole * 100;

  -- Nearest whole cent to n/d, an exact half going toward zero. round(..., 2)
  -- only fixes the scale of an already-exact value; it rounds nothing.
  return round(sign(total) * div(2 * n + d - 1, 2 * d) * 0.01, 2);
end;
$$;

-- Postgres grants EXECUTE to PUBLIC (which includes anon) on every new
-- function, and there is no declarative backstop -- see
-- tests/rls/grants.test.ts.
revoke all on function shared_part(numeric, numeric, numeric) from public;
grant execute on function shared_part(numeric, numeric, numeric)
  to authenticated, service_role;
