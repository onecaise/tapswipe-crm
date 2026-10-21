-- READ-ONLY production recon for merchant location.
--
-- HOW TO RUN: paste into the PRODUCTION Supabase SQL Editor and run it. It
-- writes nothing: the three queries are plain SELECTs inside a READ ONLY
-- transaction that is rolled back, so Postgres itself refuses any write.
--
-- THREE QUERIES, ONE RESULT ROW EACH, labelled in the first column:
--   a  merchants with no city or state       -> total + the merchants as JSON
--   b  pre-apps awaiting approval (status     -> total + the pre-apps as JSON
--      'submitted') without a usable city or
--      state; approve_pre_app() refuses these
--   c  merchants scripts/backfill-merchant-location*.sql could fill -> total
-- If the editor shows only the LAST result of a multi-statement run, select
-- one query (a, b or c) and run just the selection; each stands alone, and a
-- lone SELECT writes nothing either.
--
-- RUNS WITH OR WITHOUT the 20261013130000 migration — prod today has neither
-- the merchant location columns nor norm_city(). The merchant columns are read
-- through to_jsonb(m) ->> 'city', which is NULL when the column does not
-- exist (so before the migration every merchant counts as having none), and
-- norm_city() is spelled out inline. Keep that expression identical to
-- norm_city(). tests/rls/merchant-location-backfill.test.ts runs this file
-- end to end against the pre-migration schema and asserts both facts.

begin transaction read only;

-- a -----------------------------------------------------------------------
select 'a: merchants with no city or state' as query,
       count(*) as total,
       coalesce(jsonb_agg(jsonb_build_object(
         'id', m.id, 'dba', m.dba, 'status', m.status,
         'agent_id', m.agent_id, 'pre_app_id', m.pre_app_id)
         order by m.id), '[]'::jsonb) as merchants
  from merchants m
 where nullif(btrim(coalesce(to_jsonb(m) ->> 'city', '')), '') is null
    or nullif(btrim(coalesce(to_jsonb(m) ->> 'state', '')), '') is null;

-- b -----------------------------------------------------------------------
select 'b: submitted pre-apps without a usable city or state' as query,
       count(*) as total,
       coalesce(jsonb_agg(jsonb_build_object(
         'id', p.id, 'dba_name', p.dba_name, 'agent_id', p.agent_id,
         'date_submitted', p.date_submitted, 'city', p.city, 'state', p.state)
         order by p.date_submitted nulls first, p.id), '[]'::jsonb) as pre_apps
  from pre_apps p
 where p.status = 'submitted'
   and (coalesce(char_length(nullif(btrim(regexp_replace(
          regexp_replace(lower(p.city), '[[:punct:]]', ' ', 'g'),
          '\s+', ' ', 'g')), '')), 0) < 2
        or char_length(btrim(p.city)) > 60
        or coalesce(upper(btrim(p.state)) !~ '^[A-Z]{2}$', true));

-- c -----------------------------------------------------------------------
-- The backfill's own rule: no location of its own at all (city AND state
-- empty) and a linked pre-app whose address approve_pre_app() would accept.
select 'c: merchants the backfill could fill' as query,
       count(*) as total
  from merchants m
  join pre_apps p on p.id = m.pre_app_id
                  and p.agent_id = m.agent_id   -- same owner: never another rep's address
 where nullif(btrim(coalesce(to_jsonb(m) ->> 'city', '')), '') is null
   and nullif(btrim(coalesce(to_jsonb(m) ->> 'state', '')), '') is null
   and coalesce(char_length(nullif(btrim(regexp_replace(
         regexp_replace(lower(p.city), '[[:punct:]]', ' ', 'g'),
         '\s+', ' ', 'g')), '')), 0) >= 2
   and char_length(btrim(p.city)) <= 60
   and upper(btrim(p.state)) ~ '^[A-Z]{2}$';

rollback;
