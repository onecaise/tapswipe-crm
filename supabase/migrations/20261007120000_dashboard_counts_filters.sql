-- Filter parameters for dashboard_counts().
--
-- Mirrors docs/tapswipe_crm_schema.sql, which is the spec.
--
-- STILL SECURITY INVOKER, and that is the point of this migration rather than
-- an incidental property it happens to keep. Every parameter below is an EXTRA
-- where clause ANDed on top of the caller's own policies, never a substitute
-- for them:
--
--   * An agent who passes agent_id_input = <another rep> gets
--     `agent_id = other` AND the policy's `agent_id = auth.uid()`. That is
--     unsatisfiable, so the answer is zero. Not a check this function performs
--     — a consequence of it not bypassing anything.
--   * manager_id_input and territory_input resolve through `profiles`, and
--     that subselect is RLS-scoped too (own row plus admin), so for an agent it
--     can only ever return their own row.
--
-- A `security definer` version would have to re-implement
-- `(agent_id = auth.uid() and is_active_agent()) or is_admin()` by hand before
-- it could apply any filter at all — six more places for the access rule to
-- drift, in a function whose entire output is numbers about other people's
-- books. tests/rls/dashboard-filters.test.ts asserts prosecdef is false and
-- asserts the zero-not-disclosure behaviour directly.
--
-- NOT AN ACCESS CHANGE. No policy is touched here and none reads manager_id or
-- territory; both stay the reporting labels their column comments describe. A
-- manager gains no wider book by being named. What this adds is filtering FOR
-- AN ADMIN WHO ALREADY SEES EVERY ROW — the exact use profiles.manager_id's
-- comment anticipates.

-- The zero-argument function is DROPPED rather than replaced. Creating the
-- parameterised one alongside it would leave two candidates for a bare
-- `dashboard_counts()` call, since every new parameter has a default — an
-- ambiguity that surfaces at call time, from the browser, not here. Every
-- existing caller keeps working through the defaults instead.
drop function if exists public.dashboard_counts();

create or replace function dashboard_counts(
  agent_id_input uuid default null,
  manager_id_input uuid default null,
  territory_input text default null,
  status_input text default null,
  from_date_input date default null,
  to_date_input date default null
)
returns table (
  active_merchants bigint,
  active_leads bigint,
  ghost_sheets_total bigint,
  pre_apps_total bigint,
  open_tickets bigint,
  -- Null when no stage was asked for, and that is deliberate. A stage filter
  -- does NOT narrow active_leads: that column means "a lead no pre-app points
  -- at yet", a funnel position the records themselves prove, while a stage is
  -- something a rep types. Folding one into the other would make a single
  -- output mean two different things depending on a parameter, and would read
  -- as near-zero for 'application_sent' — whose leads are precisely the ones a
  -- pre-app points at — while looking entirely healthy.
  leads_at_stage bigint
)
language sql
stable
-- Output names avoid the table names because `returns table` puts each one in
-- scope inside the body, so an output called `ghost_sheets` would collide with
-- the relation. The parameters carry _input for the same reason.
as $$
  with filters as (
    select (agent_id_input is not null
         or manager_id_input is not null
         or territory_input is not null) as by_agent
  ),
  scoped_agents as (
    -- RLS applies to this read like any other. For an admin it is every
    -- matching rep; for an agent it is at most their own row, which is what
    -- makes "filter by somebody else" return nothing rather than something.
    select p.id
      from public.profiles p, filters f
     where f.by_agent
       and (agent_id_input is null or p.id = agent_id_input)
       and (manager_id_input is null or p.manager_id = manager_id_input)
       and (territory_input is null or p.territory = territory_input)
  )
  select
    (select count(*)
       from public.merchants m, filters f
      where m.status = 'active'
        and (not f.by_agent or m.agent_id in (select id from scoped_agents))
        and (from_date_input is null or m.created_at >= from_date_input)
        -- `< to_date + 1`, not `<= to_date`: created_at is a timestamptz, so
        -- anything created after midnight on the last day would otherwise fall
        -- outside the range the person believes they asked for.
        and (to_date_input is null or m.created_at < to_date_input + 1)),
    (select count(*)
       from public.leads l, filters f
      where not exists (
            select 1 from public.pre_apps p where p.lead_id = l.id
          )
        and (not f.by_agent or l.agent_id in (select id from scoped_agents))
        and (from_date_input is null or l.created_at >= from_date_input)
        and (to_date_input is null or l.created_at < to_date_input + 1)),
    (select count(*)
       from public.ghost_sheets g, filters f
      where (not f.by_agent or g.agent_id in (select id from scoped_agents))
        and (from_date_input is null or g.created_at >= from_date_input)
        and (to_date_input is null or g.created_at < to_date_input + 1)),
    (select count(*)
       from public.pre_apps a, filters f
      where (not f.by_agent or a.agent_id in (select id from scoped_agents))
        and (from_date_input is null or a.created_at >= from_date_input)
        and (to_date_input is null or a.created_at < to_date_input + 1)),
    (select count(*)
       from public.support_tickets t, filters f
      where t.status = 'open'
        and (not f.by_agent or t.agent_id in (select id from scoped_agents))
        and (from_date_input is null or t.created_at >= from_date_input)
        and (to_date_input is null or t.created_at < to_date_input + 1)),
    case when status_input is null then null else (
      select count(*)
        from public.leads ls, filters f
       where ls.status = status_input
         and (not f.by_agent or ls.agent_id in (select id from scoped_agents))
         and (from_date_input is null or ls.created_at >= from_date_input)
         and (to_date_input is null or ls.created_at < to_date_input + 1)
    ) end;
$$;

-- The signature changed, so these name the new one. The privileges on the
-- dropped zero-argument function went with it, and Postgres grants EXECUTE to
-- PUBLIC — which includes anon — on every new function, with no declarative
-- backstop. Without these two lines this RPC is callable unauthenticated from
-- the moment it exists.
revoke all on function dashboard_counts(uuid, uuid, text, text, date, date) from public;
grant execute on function dashboard_counts(uuid, uuid, text, text, date, date)
  to authenticated, service_role;
