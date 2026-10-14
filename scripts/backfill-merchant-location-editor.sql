-- Backfill merchant locations from their linked pre-app — SUPABASE SQL EDITOR
-- VARIANT of scripts/backfill-merchant-location.sql (the psql version, kept).
--
-- HOW TO RUN: paste this whole file into the SQL Editor and press Run.
--   * As shipped it is a PREVIEW: `false as apply` on the first line of the
--     statement below. It writes nothing and returns the plan.
--   * To write, change that ONE literal to `true` and run it again. Nothing
--     else needs editing.
-- Run scripts/preview-merchant-location-backfill.sql first if you want the
-- reasons the other merchants cannot be filled. Requires 20261013130000.
--
-- WHY ONE STATEMENT, not a DO block or a BEGIN/COMMIT script: a single
-- statement is one transaction by itself, whatever the editor does with
-- multi-statement input, and its result is the grid the editor always shows.
-- A DO block cannot return rows, and would have to report through RAISE
-- NOTICE, which the browser editor does not reliably display.
--
-- WHAT YOU GET BACK — one result, its first row the summary:
--   row_kind = 'summary'   mode ('PREVIEW: nothing written' or 'APPLIED'),
--                          merchants_without_location, would_fill, rows_changed
--                          (always 0 in preview), plus street/zip counts.
--                          merchants_without_location is counted as the
--                          statement began, so in apply mode it is the
--                          BEFORE figure; run the preview again for after.
--   row_kind = 'merchant'  up to 20 merchants it would change (preview) or
--                          did change (apply), with the values it writes
--
-- WHAT IT CHANGES — identical rules to the psql version:
--   * only merchants whose city AND state are both NULL;
--   * only where the linked pre-app's address passes approve_pre_app()'s rule
--     (norm_city >= 2 characters, at most 60 trimmed, state two letters once
--     trimmed and upper-cased) — the merchants_location_format rule, so no
--     update here can be refused by it;
--   * city and state always; street and zip only where the merchant's own is
--     NULL and the pre-app's is non-blank. Never overwrites, never deletes,
--     never touches pre_apps.
-- The plan rows are locked (FOR UPDATE) and the UPDATE is driven from the
-- same plan, so what the summary reports is what is written.
--
-- AUDIT: log_cross_agent_change() writes one `cross_agent_update` row per
-- merchant changed, with the editor session's actor. Wanted: it is the trail.
--
-- tests/rls/merchant-location-backfill.test.ts runs this file in both modes.

with params as (
  select false as apply   -- <<< the one switch: false = preview, true = write
),
plan as (
  select m.id,
         m.dba,
         m.pre_app_id,
         btrim(p.city)         as new_city,
         upper(btrim(p.state)) as new_state,
         case when m.street is null then nullif(btrim(p.physical_address), '') end as new_street,
         case when m.zip    is null then nullif(btrim(p.zip), '') end              as new_zip
    from merchants m
    join pre_apps p on p.id = m.pre_app_id
   where m.city is null
     and m.state is null
     and coalesce(char_length(norm_city(p.city)), 0) >= 2
     and char_length(btrim(p.city)) <= 60
     and upper(btrim(p.state)) ~ '^[A-Z]{2}$'
     for update of m
),
changed as (
  update merchants m
     set city   = b.new_city,
         state  = b.new_state,
         street = coalesce(m.street, b.new_street),
         zip    = coalesce(m.zip, b.new_zip)
    from plan b, params
   where params.apply
     and m.id = b.id
     and m.city is null
     and m.state is null
  returning m.id
),
summary as (
  select 'summary'::text as row_kind,
         case when (select apply from params) then 'APPLIED'
              else 'PREVIEW: nothing written' end as mode,
         null::int  as merchant_id,
         null::text as dba,
         null::int  as pre_app_id,
         null::text as new_street,
         null::text as new_city,
         null::text as new_state,
         null::text as new_zip,
         (select count(*) from merchants where city is null and state is null) as merchants_without_location,
         (select count(*) from plan)                                          as would_fill,
         (select count(*) from changed)                                       as rows_changed,
         (select count(*) from plan where new_street is not null)             as would_also_get_street,
         (select count(*) from plan where new_zip is not null)                as would_also_get_zip
),
sample as (
  select 'merchant'::text, null::text, b.id, b.dba, b.pre_app_id,
         b.new_street, b.new_city, b.new_state, b.new_zip,
         null::bigint, null::bigint, null::bigint, null::bigint, null::bigint
    from plan b
   order by b.id
   limit 20
)
select *
  from (select * from summary union all select * from sample) report
 order by (row_kind = 'summary') desc, merchant_id;
