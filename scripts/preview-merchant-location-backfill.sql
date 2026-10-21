-- READ-ONLY preview of scripts/backfill-merchant-location.sql.
--
-- For every merchant with no location (city AND state both empty), says
-- whether its linked pre-app (merchants.pre_app_id) has an address usable by
-- the backfill, and if not, why. Writes nothing: the whole file runs inside a
-- READ ONLY transaction that is rolled back, so even a mistaken edit to it
-- cannot change data -- Postgres refuses any write in a read-only transaction.
--
-- "Usable" is approve_pre_app()'s rule, character for character: the city
-- normalises (norm_city) to 2+ characters and is at most 60 trimmed, and the
-- state upper-cased and trimmed is two letters. The normalisation is spelled
-- out inline rather than calling norm_city(), and the merchant columns are
-- read through to_jsonb(), so this also runs on a project that does NOT have
-- 20261013130000 yet: there every merchant simply counts as having no
-- location. Keep the inline expression identical to norm_city().
--
-- Run with psql (or paste into the SQL editor) against the project in
-- question. tests/rls/merchant-location-backfill.test.ts executes this file.

begin transaction read only;

with merchant_loc as (
  select m.id, m.dba, m.status, m.pre_app_id, m.agent_id,
         to_jsonb(m) ->> 'city'  as city,
         to_jsonb(m) ->> 'state' as state
    from merchants m
),
missing as (
  select * from merchant_loc
   where nullif(btrim(coalesce(city, '')), '') is null
     and nullif(btrim(coalesce(state, '')), '') is null
),
classified as (
  select mi.id, mi.dba, mi.status, mi.pre_app_id,
         case
           when mi.pre_app_id is null then 'no linked pre-app'
           when p.id is null then 'linked pre-app no longer exists'
           when p.agent_id is distinct from mi.agent_id
             then 'linked pre-app belongs to another rep'
           when coalesce(char_length(nullif(btrim(regexp_replace(
                  regexp_replace(lower(p.city), '[[:punct:]]', ' ', 'g'),
                  '\s+', ' ', 'g')), '')), 0) < 2
             then 'pre-app has no usable city'
           when char_length(btrim(p.city)) > 60
             then 'pre-app city over 60 characters'
           when coalesce(upper(btrim(p.state)) !~ '^[A-Z]{2}$', true)
             then 'pre-app has no usable state'
           else 'fillable'
         end as outcome
    from missing mi
    left join pre_apps p on p.id = mi.pre_app_id
)
select outcome, count(*) as merchants
  from classified
 group by outcome
 order by (outcome = 'fillable') desc, outcome;

rollback;
