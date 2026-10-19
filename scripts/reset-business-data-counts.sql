-- Row counts for the business-data reset — READ-ONLY, SUPABASE SQL EDITOR.
--
-- Run it BEFORE scripts/reset-business-data.sql and again AFTER the commit,
-- and keep both grids. One row per table in `public` (found from the catalog,
-- so a table added later shows up without editing this file), plus auth.users
-- and storage.objects. Counts only: no column is read.
--
-- Expected after a committed reset: profiles and auth.users as before,
-- audit_log 1 (the 'business_data_reset' marker), every other public table 0,
-- storage.objects as before until the files are deleted by hand.
--
-- One SELECT, so it is one read-only statement. query_to_xml is how a single
-- statement counts tables it only learns the names of at run time.

select c.relname::text as table_name,
       (xpath('/row/n/text()',
              query_to_xml(format('select count(*) as n from public.%I', c.relname), false, true, '')
       ))[1]::text::bigint as row_count
  from pg_class c
 where c.relnamespace = 'public'::regnamespace
   and c.relkind in ('r', 'p')
   and not c.relispartition
union all
select 'auth.users', (select count(*) from auth.users)
union all
select 'storage.objects',
       case when to_regclass('storage.objects') is not null then
         (xpath('/row/n/text()', query_to_xml('select count(*) as n from storage.objects', false, true, '')))[1]::text::bigint
       end
 order by 1;
