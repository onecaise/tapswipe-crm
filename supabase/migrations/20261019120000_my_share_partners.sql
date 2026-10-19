-- my_share_partners(): a rep's own shares, the partner's name and the rep's
-- own share only. Phase 6 of docs/design/residual-splits.md (§8).
--
-- Matches docs/tapswipe_crm_schema.sql, updated first; the block below is
-- copied from it verbatim.
--
-- =====================================================================
-- MY SHARE PARTNERS (20261019120000) — the one way a rep learns who they
-- share an account with. Phase 6 of docs/design/residual-splits.md, §8.
--
-- my_share_partners(merchant_id_input int default null) returns jsonb
--   [{"rep_share_id": n, "partner_name": "...", "own_rep_pct": 40.00,
--     "effective_from": "YYYY-MM-DD", "effective_to": "YYYY-MM-DD" | null}]
--
-- THE RULE (Owen, 14 Oct 2026): each rep on a shared account sees the
-- partner's NAME and their OWN share, never the partner's payout. Neither is
-- reachable any other way: merchant_rep_shares is admin-only by policy, and
-- profiles shows a rep only their own row. So this is `security definer`,
-- which is what lets it see past both -- and it pays for that reach the way
-- accounts_in_city() and check_duplicates() do: a hand-written guard first,
-- search_path pinned, and a return shape decided key by key.
--
-- WHO IT ANSWERS FOR: the caller, and only as a PARTY. A row comes back only
-- where auth.uid() is the share's signer or its partner -- admins included.
-- An admin reads the table directly under its own policy; widening this
-- function for them would make it a second admin read path that nothing
-- needs, and an admin who is not a party gets []. A deactivated caller is
-- refused (PT403) before anything is read: a valid JWT outlives the account.
--
-- WHAT COMES BACK, and nothing else. Five keys, built with jsonb_build_object
-- so anything not named is ABSENT, not null:
--   rep_share_id    the key a ledger line already carries; the caller can read
--                   it on their own line, so it reveals nothing, and without
--                   it a name cannot be put against the right line when a rep
--                   has two shared accounts.
--   partner_name    the OTHER party's full_name.
--   own_rep_pct     the caller's own figure, in rep-percent terms (40, not 80%).
--   effective_from  first month; effective_to the exclusive end, or null.
-- Never: the partner's share, id or rate, any payout, the merchant's id, MID,
-- name or anything else of the merchant's. (The partner's share is arithmetic
-- -- the two total 50 -- and the caller's own ledger line carries the share
-- snapshot; design §8 records that as a display rule, not a secret. This
-- function does not add to it.)
--
-- merchant_id_input FILTERS and is never echoed. The signer's merchant page
-- passes it to say "shared with Bo Lee" on that merchant; the partner cannot
-- open the merchant record (no RLS changes here), and learns nothing from
-- the filter that their own ledger line -- which carries merchant_id -- does
-- not already say.
--
-- NOT AUDITED, like accounts_in_city() and check_duplicates(): a read that
-- names the caller's own business.
-- =====================================================================

create or replace function my_share_partners(merchant_id_input int default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
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
             'rep_share_id', s.id,
             'partner_name', p.full_name,
             'own_rep_pct', case when s.primary_agent_id = caller
                                 then s.primary_rep_pct
                                 else s.secondary_rep_pct end,
             'effective_from', s.effective_from,
             'effective_to', s.effective_to)
           order by s.effective_from desc, s.id desc),
         '[]'::jsonb)
    into result
    from merchant_rep_shares s
    join profiles p
      on p.id = case when s.primary_agent_id = caller
                     then s.secondary_agent_id
                     else s.primary_agent_id end
   where (s.primary_agent_id = caller or s.secondary_agent_id = caller)
     and (merchant_id_input is null or s.merchant_id = merchant_id_input);

  return result;
end;
$$;

revoke all on function my_share_partners(int) from public;
grant execute on function my_share_partners(int) to authenticated, service_role;
