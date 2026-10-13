-- READ-ONLY production recon for merchant location, before 20261013130000 and
-- 20261013132000 are pushed. Writes nothing: one READ ONLY transaction, rolled
-- back.
--
-- Runs on a project WITHOUT those migrations (prod today) as well as with
-- them: merchant location columns are read through to_jsonb(), which yields
-- NULL for a column that does not exist, and norm_city() is spelled out
-- inline. Keep that expression identical to norm_city().
--
-- (a) merchants with no city or state
-- (b) pre-apps awaiting approval that lack a usable city or state -- these
--     will be refused by approve_pre_app() once 20261013130000 is live
-- (c) how many of (a) scripts/backfill-merchant-location.sql could fill

begin transaction read only;

-- (a) ---------------------------------------------------------------------
select count(*) as merchants_without_location
  from merchants m
 where nullif(btrim(coalesce(to_jsonb(m) ->> 'city', '')), '') is null
    or nullif(btrim(coalesce(to_jsonb(m) ->> 'state', '')), '') is null;

select m.id, m.dba, m.status, m.agent_id, m.pre_app_id
  from merchants m
 where nullif(btrim(coalesce(to_jsonb(m) ->> 'city', '')), '') is null
    or nullif(btrim(coalesce(to_jsonb(m) ->> 'state', '')), '') is null
 order by m.id;

-- (b) ---------------------------------------------------------------------
select p.id, p.dba_name, p.agent_id, p.date_submitted, p.city, p.state
  from pre_apps p
 where p.status = 'submitted'
   and (coalesce(char_length(nullif(btrim(regexp_replace(
          regexp_replace(lower(p.city), '[[:punct:]]', ' ', 'g'),
          '\s+', ' ', 'g')), '')), 0) < 2
        or char_length(btrim(p.city)) > 60
        or coalesce(upper(btrim(p.state)) !~ '^[A-Z]{2}$', true))
 order by p.date_submitted nulls first, p.id;

-- (c) ---------------------------------------------------------------------
-- The backfill's own rule: no location of its own at all (city AND state
-- empty) and a linked pre-app whose address approve_pre_app() would accept.
select count(*) as backfillable_from_pre_app
  from merchants m
  join pre_apps p on p.id = m.pre_app_id
 where nullif(btrim(coalesce(to_jsonb(m) ->> 'city', '')), '') is null
   and nullif(btrim(coalesce(to_jsonb(m) ->> 'state', '')), '') is null
   and coalesce(char_length(nullif(btrim(regexp_replace(
         regexp_replace(lower(p.city), '[[:punct:]]', ' ', 'g'),
         '\s+', ' ', 'g')), '')), 0) >= 2
   and char_length(btrim(p.city)) <= 60
   and upper(btrim(p.state)) ~ '^[A-Z]{2}$';

rollback;
