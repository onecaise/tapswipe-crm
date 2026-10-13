-- Backfill merchant locations from their linked pre-app's business address.
--
-- REVIEWED BY HAND, RUN BY HAND, NEVER BY ANYTHING AUTOMATIC. Not a
-- migration (it is in scripts/, not supabase/migrations/), so `db push` and
-- `db reset` never run it. Requires 20261013130000 (the columns and
-- norm_city()). Run scripts/preview-merchant-location-backfill.sql first.
--
-- DRY RUN BY DEFAULT. It always prints the plan and then ROLLS BACK, unless
-- psql is given -v apply=1:
--     psql "<url>" -f scripts/backfill-merchant-location.sql              # dry run
--     psql "<url>" -v apply=1 -f scripts/backfill-merchant-location.sql   # writes
-- The \if is a psql meta-command, so this file needs psql; the Supabase SQL
-- editor would run it without the switch and stop at the first backslash.
--
-- WHAT IT CHANGES, and nothing else:
--   * only merchants whose city AND state are both NULL -- a merchant with
--     any location of its own is never touched, even a partial one;
--   * only where the linked pre-app's address is usable by approve_pre_app()'s
--     rule (norm_city >= 2 characters, at most 60 trimmed, state two letters
--     once trimmed and upper-cased) -- the same rule merchants_location_format
--     enforces, so no update here can be refused by it;
--   * city and state always (city trimmed, state upper-cased); street and zip
--     only where the merchant's own is NULL and the pre-app's is non-blank.
-- It never overwrites a non-NULL merchant field, never touches pre_apps, and
-- never deletes.
--
-- ONE TRANSACTION. The plan is computed once into a temp table with the
-- merchant rows locked (FOR UPDATE), printed, and then applied from that same
-- table -- so the rows it reports are exactly the rows it writes, and nothing
-- can change them in between.
--
-- AUDIT. merchants carries log_cross_agent_change(); a psql session has no
-- auth.uid(), so each updated merchant gets a `cross_agent_update` row with a
-- NULL actor. That is the trail of this backfill, and is wanted.

\set ON_ERROR_STOP on

begin;

create temp table backfill_plan on commit drop as
select m.id,
       m.dba,
       btrim(p.city)                                 as new_city,
       upper(btrim(p.state))                         as new_state,
       case when m.street is null then nullif(btrim(p.physical_address), '') end as new_street,
       case when m.zip    is null then nullif(btrim(p.zip), '') end              as new_zip,
       m.pre_app_id
  from merchants m
  join pre_apps p on p.id = m.pre_app_id
 where m.city is null
   and m.state is null
   and coalesce(char_length(norm_city(p.city)), 0) >= 2
   and char_length(btrim(p.city)) <= 60
   and upper(btrim(p.state)) ~ '^[A-Z]{2}$'
   for update of m;

\echo '== merchants with no location, and how many this would fill'
select (select count(*) from merchants where city is null and state is null) as merchants_without_location,
       (select count(*) from backfill_plan)                                  as would_fill,
       (select count(*) from backfill_plan where new_street is not null)     as would_also_get_street,
       (select count(*) from backfill_plan where new_zip is not null)        as would_also_get_zip;

\echo '== the first 20 merchants it would change'
select id, dba, pre_app_id, new_street, new_city, new_state, new_zip
  from backfill_plan
 order by id
 limit 20;

update merchants m
   set city   = b.new_city,
       state  = b.new_state,
       street = coalesce(m.street, b.new_street),
       zip    = coalesce(m.zip, b.new_zip)
  from backfill_plan b
 where m.id = b.id
   and m.city is null
   and m.state is null;

\echo '== merchants updated in this transaction'
select count(*) as updated
  from merchants m join backfill_plan b on b.id = m.id
 where m.city = b.new_city and m.state = b.new_state;

\if :{?apply}
  \echo '== apply=1 given: COMMITTING'
  commit;
\else
  \echo '== dry run (no -v apply=1): ROLLING BACK, nothing was written'
  rollback;
\endif
