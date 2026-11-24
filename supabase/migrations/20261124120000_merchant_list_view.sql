-- =====================================================================
-- MERCHANTS LIST VIEW (20261124120000) — phase 1a of
-- docs/design/merchants-and-dashboard.md (§1.4).
--
-- Matches docs/tapswipe_crm_schema.sql, which was updated first.
--
-- The merchants list stops loading every merchant into the page. It reads
-- one page at a time through PostgREST -- filters, `order`, `range` and an
-- exact count -- and the one order the merchants table cannot give it on
-- its own is "by owner name", which lives on profiles. So the list reads
-- this view, which carries the owner's name and three sort keys beside the
-- merchant's own columns.
--
-- SECURITY INVOKER IS THE WHOLE POINT, AND IT IS NOT THE DEFAULT. A
-- Postgres view runs its query as the VIEW'S OWNER unless told otherwise,
-- and the owner here is the migration role, which bypasses RLS: a plain
-- `create view` would hand every signed-in rep the whole company's
-- merchants and every owner's name. With `security_invoker = true` both
-- base tables' own policies apply to the caller:
--
--   * merchants: "select own or admin" -- a rep sees their own book, an
--     admin everything;
--   * profiles:  "read own profile or admin reads all" -- the left join
--     finds a rep's OWN name only (every merchant they can see is theirs),
--     and every name for an admin.
--
-- So the view shows nobody anything they could not already read from the
-- two tables. tests/rls/merchant-list-view.test.ts asserts the reloptions,
-- the rep's and the admin's rows, and -- by recreating the view without
-- the option on a throwaway database -- that the rep test is what catches
-- its absence.
--
-- `left join`, not inner: a merchant always has an owner (agent_id is not
-- null with a foreign key), but a rep cannot see another profile, and an
-- inner join would make a row disappear the day a policy stopped
-- admitting its owner's name instead of showing it without one.
--
-- The sort keys are columns rather than expressions because PostgREST
-- orders by column name only:
--   dba_sort   lower(dba)        -- case-insensitive; the collation alone
--                                    can put "Zeta" before "acme"
--   mid_sort   mid_key(mid)      -- the key the unique index and commit v3
--                                    match on; TEXT order, decided: MIDs
--                                    hold letters since 20261106140000, so
--                                    there is no numeric order, and a text
--                                    order keeps leading zeros meaningful
--   agent_sort lower(full_name)
-- Every page also orders by id last (in lib/merchants-data.ts), so equal
-- keys never swap between loads.
--
-- ensure_rls does not touch a view (its event trigger acts on CREATE TABLE
-- only), and a view cannot carry RLS of its own: the base tables' policies
-- are the protection, which is exactly what security_invoker makes true.
-- =====================================================================
create view merchant_list
with (security_invoker = true)
as
select m.id,
       m.agent_id,
       m.mid,
       m.dba,
       m.legal_business_name,
       m.status,
       m.processor,
       m.split_agent_pct,
       m.date_added,
       m.city,
       m.state,
       p.full_name        as agent_name,
       lower(m.dba)       as dba_sort,
       mid_key(m.mid)     as mid_sort,
       lower(p.full_name) as agent_sort
  from merchants m
  left join profiles p on p.id = m.agent_id;

comment on view merchant_list is
  'The merchants list page (one page at a time). security_invoker: the caller''s own merchants and profiles policies apply. Read-only.';

-- Grants. Read-only to authenticated; nothing to anon, ever. The join makes
-- the view not auto-updatable today, but SELECT is granted alone anyway: a
-- later edit dropping the join must not leave a second write path into
-- merchants behind a grant nobody meant.
-- No service_role grant: no Edge Function reads it yet (phase 1b's
-- export-merchants reads it through the CALLER-scoped client). The revoke
-- names every Data API role because on the local stack the default ACL for
-- objects `postgres` creates hands service_role extra privileges
-- (docs/claude/grants-inventory.md); this view should carry exactly the one
-- grant below on every project.
revoke all on merchant_list from public;
revoke all on merchant_list from anon, authenticated, service_role;
grant select on merchant_list to authenticated;

-- Indexes. The default page is "newest first", and the processor filter is
-- the one new filter on a column with no index. Not added: lower(dba) and
-- split_agent_pct -- at today's size (low thousands) sorting the filtered
-- set in memory is cheaper than the write cost of more indexes; revisit
-- with the switch to a planned count (design §1.4).
create index if not exists idx_merchants_date_added_id
  on merchants (date_added desc, id desc);
create index if not exists idx_merchants_processor
  on merchants (processor);
