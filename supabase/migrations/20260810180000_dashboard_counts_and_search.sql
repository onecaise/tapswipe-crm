-- Dashboard counts and global search.
--
-- Both are plain (security INVOKER) functions, which is the point of them
-- rather than an oversight. The caller's own RLS scopes every read inside, so
-- an agent gets their own book and an admin gets the company's with no role
-- branch in the SQL and no agent_id filter to keep in step with the policies.
--
-- A `security definer` version of either would run as the owner, bypass RLS,
-- and have to re-implement `(agent_id = auth.uid() and is_active_agent()) or
-- is_admin()` once per table by hand. For search that is the difference between
-- a feature and a disclosure bug: the box must not be able to surface a record
-- the rest of the app hides.
--
-- Mirrors docs/tapswipe_crm_schema.sql, which is the spec.

-- ---------------------------------------------------------------------
-- DASHBOARD COUNTS
--
-- One round trip instead of five head:true selects, so the figures are also a
-- single snapshot rather than five reads that can disagree.
--
-- On "active": `active_merchants` is merchants.status = 'active', a real
-- constrained vocabulary. `active_leads` is deliberately NOT `status =
-- 'active'` — leads.status is nullable unconstrained text defaulting to 'open',
-- so there is no 'active' to compare against, and inventing one here is exactly
-- the drift the bare column was left bare to avoid. A lead is counted until a
-- pre-app points at it, which makes the row read as a funnel: a deal counted
-- under Pre-Apps is no longer counted under Leads.
-- ---------------------------------------------------------------------
create or replace function dashboard_counts()
returns table (
  active_merchants bigint,
  active_leads bigint,
  ghost_sheets_total bigint,
  pre_apps_total bigint,
  open_tickets bigint
)
language sql
stable
-- The output names avoid the table names on purpose: `returns table` puts each
-- one in scope inside the body, so an output called `ghost_sheets` would
-- collide with the relation. Every reference below is qualified for the same
-- reason.
as $$
  select
    (select count(*) from public.merchants m where m.status = 'active'),
    (select count(*)
       from public.leads l
      where not exists (
        select 1 from public.pre_apps p where p.lead_id = l.id
      )),
    (select count(*) from public.ghost_sheets),
    (select count(*) from public.pre_apps),
    (select count(*) from public.support_tickets t where t.status = 'open');
$$;

-- Postgres grants EXECUTE to PUBLIC (which includes anon) on every new
-- function, and there is no declarative backstop for it. Without these two
-- lines this RPC is callable unauthenticated from the moment it exists.
revoke all on function dashboard_counts() from public;
grant execute on function dashboard_counts() to authenticated, service_role;

-- ---------------------------------------------------------------------
-- GLOBAL SEARCH
--
-- Flat (kind, record_id, title, subtitle) rows across the five record types
-- that have pages, so the caller renders one list. `record_id` rather than `id`
-- because `returns table` puts these names in scope inside the body.
--
-- Notes and tasks are excluded: they are panels on an owner record, not
-- navigable records of their own, so a hit on one has nowhere to link to.
--
-- limit_input applies per kind, not overall, so one busy table cannot crowd the
-- others out of the results.
-- ---------------------------------------------------------------------
create or replace function search_crm(query_input text, limit_input int default 5)
returns table (
  kind text,
  record_id int,
  title text,
  subtitle text
)
language sql
stable
as $$
  with term as (
    select
      '%' ||
      -- Backslash first: escaping it after the others would re-escape the
      -- backslashes this expression just introduced. ILIKE treats \ as its
      -- escape character, so a rep typing '%' searches for a percent sign
      -- instead of matching every row they can see.
      replace(replace(replace(btrim(query_input), '\', '\\'), '%', '\%'), '_', '\_')
      || '%' as pattern,
      -- Below two characters the function returns nothing, so an empty or
      -- single-keystroke query doesn't select the caller's whole book.
      length(btrim(coalesce(query_input, ''))) as term_length
  ),
  hits as (
    select * from (
      select 1 as rank, 'lead'::text as kind, l.id as record_id,
             coalesce(l.dba, l.contact_name, 'Lead #' || l.id) as title,
             l.contact_name as subtitle
        from public.leads l, term t
       where t.term_length >= 2
         and (l.dba ilike t.pattern
           or l.contact_name ilike t.pattern
           or l.contact_phone ilike t.pattern
           or l.contact_email ilike t.pattern
           or l.merchant_legal_name ilike t.pattern)
       order by l.dba
       limit limit_input
    ) lead_hits
    union all
    select * from (
      select 2 as rank, 'pre_app'::text as kind, p.id as record_id,
             p.dba_name as title,
             coalesce(p.legal_business_name, p.contact_name) as subtitle
        from public.pre_apps p, term t
       where t.term_length >= 2
         and (p.dba_name ilike t.pattern
           or p.legal_business_name ilike t.pattern
           or p.contact_name ilike t.pattern
           or p.email_address ilike t.pattern)
       order by p.dba_name
       limit limit_input
    ) pre_app_hits
    union all
    select * from (
      select 3 as rank, 'merchant'::text as kind, m.id as record_id,
             m.dba as title,
             coalesce(m.legal_business_name, m.mid) as subtitle
        from public.merchants m, term t
       where t.term_length >= 2
         and (m.dba ilike t.pattern
           or m.legal_business_name ilike t.pattern
           or m.mid ilike t.pattern)
       order by m.dba
       limit limit_input
    ) merchant_hits
    union all
    select * from (
      select 4 as rank, 'ghost_sheet'::text as kind, g.id as record_id,
             coalesce(g.dba, g.contact_name, 'Ghost sheet #' || g.id) as title,
             g.contact_name as subtitle
        from public.ghost_sheets g, term t
       where t.term_length >= 2
         and (g.dba ilike t.pattern
           or g.contact_name ilike t.pattern
           or g.contact_phone ilike t.pattern)
       order by g.dba
       limit limit_input
    ) ghost_sheet_hits
    union all
    select * from (
      select 5 as rank, 'support_ticket'::text as kind, s.id as record_id,
             s.subject as title,
             coalesce(s.category, s.serial_number_imei) as subtitle
        from public.support_tickets s, term t
       where t.term_length >= 2
         and (s.subject ilike t.pattern
           or s.serial_number_imei ilike t.pattern
           or s.category ilike t.pattern)
       order by s.subject
       limit limit_input
    ) support_ticket_hits
  )
  select h.kind, h.record_id, h.title, h.subtitle
    from hits h
   order by h.rank, h.title;
$$;

revoke all on function search_crm(text, int) from public;
grant execute on function search_crm(text, int) to authenticated, service_role;
