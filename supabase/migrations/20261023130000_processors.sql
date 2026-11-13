-- One processor vocabulary: the `processors` reference table, referenced by
-- merchants.processor and a new pre_apps.processor, and copied onto the
-- merchant by approve_pre_app().
--
-- Phase 1 of docs/design/intake-and-reports.md. Matches
-- docs/tapswipe_crm_schema.sql, updated first.
--
-- REFUSES TO RUN over rows it would break. merchants.processor was free text
-- until now; the foreign key below cannot be added over a value that is not in
-- the list, and silently NULLing or rewriting someone's processor is exactly the
-- quiet data change this repo does not do. Prod and dev hold no real merchants
-- (reset, Oct 2026), so on them the check passes trivially. Anywhere it does not,
-- the migration stops with the offending values named, and the fix is a
-- deliberate mapping, not a retry.
--
-- Why not "refuse unless the table is empty": measured 23 Oct 2026, a strict
-- empty-table guard here fails four hermetic suites (accounts-in-city,
-- accounts-in-city-limits, merchant-location, merchant-location-backfill),
-- because they seed an existing database BEFORE replaying later migrations --
-- the shape of a real project with data -- and every row they seed is valid.
-- What must be refused is a row this migration would break, not a row.
--
-- pre_apps gains a NULLABLE column, which changes no existing row, so there is
-- nothing on that table for a guard to find.

do $$
declare
  bad text;
begin
  select string_agg(distinct quote_literal(processor), ', ' order by quote_literal(processor))
    into bad
    from merchants
   where processor is not null
     and processor not in ('TSYS', 'Red Fynn', 'PayBright', 'Netevia HQ', 'Square');
  if bad is not null then
    raise exception 'processors migration refuses to run: merchants.processor holds values outside the processor list: %. Map them to a listed processor (or NULL) deliberately, then re-run.', bad;
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- The table. Natural key: the code is what the referencing columns hold, so
-- there is no serial, no sequence and no sequence grant. code = label for now
-- (memo A1); label exists so a display name can change without rewriting rows.
-- ---------------------------------------------------------------------
create table processors (
  code text primary key
    constraint processors_code_trimmed check (code = btrim(code) and code <> ''),
  label text not null
    constraint processors_label_trimmed check (label = btrim(label) and label <> ''),
  sort_order int not null constraint processors_sort_order_key unique
);

-- The four-step checklist, with step 1 (agent_id) struck out: a processor is
-- not owned by a rep. Step 3 is one policy, not four -- there is no client
-- write, so there is nothing for an insert/update/delete policy to admit.
alter table processors enable row level security;

create policy "select active or admin" on processors
  for select using (is_active_agent() or is_admin());

-- No log_cross_agent_change(): no agent_id, and no client can write it.

-- SELECT only, for both roles. A write from a signed-in session is
-- `permission denied`. service_role gets SELECT for the residual import
-- functions that will validate a chosen processor (phases 6-7); nothing
-- writes this table outside a migration. Never anything for anon.
--
-- `revoke all` FIRST, because a new table does not start empty everywhere.
-- Measured on the local stack 23 Oct 2026: pg_default_acl for role postgres
-- in schema public still hands service_role `Dxtm` (TRUNCATE, REFERENCES,
-- TRIGGER, MAINTAIN) on every table it creates -- the residue
-- 20260805210000 left for service_role -- and PGlite has no such default, so
-- the hermetic suite cannot see it. Starting from nothing makes this table's
-- surface exactly the two lines below on every database it lands on.
revoke all on processors from anon, authenticated, service_role;
grant select on processors to authenticated;
grant select on processors to service_role;

insert into processors (code, label, sort_order) values
  ('TSYS',       'TSYS',       10),
  ('Red Fynn',   'Red Fynn',   20),
  ('PayBright',  'PayBright',  30),
  ('Netevia HQ', 'Netevia HQ', 40),
  ('Square',     'Square',     50);

-- ---------------------------------------------------------------------
-- The two referencing columns. NULL stays legal on both: "not set yet".
-- NO ACTION on delete and update, so a processor a row names cannot be
-- removed or renamed out from under it.
-- ---------------------------------------------------------------------
alter table merchants
  add constraint merchants_processor_fkey
  foreign key (processor) references processors(code);

alter table pre_apps
  add column processor text
  constraint pre_apps_processor_fkey references processors(code);

-- ---------------------------------------------------------------------
-- approve_pre_app(): carries the processor across. The body is otherwise
-- byte-for-byte 20261013130000's.
-- ---------------------------------------------------------------------
create or replace function approve_pre_app(pre_app_id_input int)
returns int
language plpgsql
security definer
set search_path = public
as $$
declare
  pa pre_apps;
  new_merchant_id int;
begin
  if not is_admin() then
    raise exception 'only admins can approve pre-apps' using errcode = 'PT403';
  end if;

  select * into pa from pre_apps where id = pre_app_id_input;
  if not found then
    -- The caller is a verified admin who can already see every row, so there
    -- is nothing to withhold and this names the id. The opposite of
    -- submit_pre_app's deliberately vague 404, for the opposite reason.
    raise exception 'pre-app % not found', pre_app_id_input using errcode = 'PT404';
  end if;

  if pa.status = 'approved' then
    raise exception 'pre-app % is already approved', pre_app_id_input using errcode = 'PT409';
  end if;
  if pa.status <> 'submitted' then
    raise exception 'pre-app % must be submitted before approval (status: %)',
      pre_app_id_input, pa.status using errcode = 'PT409';
  end if;

  -- agent_id comes from the pre-app, never auth.uid(): an admin approving on
  -- a rep's behalf must not move the merchant into their own book. Same
  -- reasoning as convert_ghost_sheet_to_lead.
  --
  -- pre_app_id records which application this came from. Note what it is not:
  -- a live link. Every other column here is a COPY taken at approval, and
  -- nothing syncs afterwards, so an admin editing an approved pre-app changes
  -- the application and not the merchant. That is deliberate -- the merchant is
  -- the record of what was agreed -- and the pointer exists so the divergence
  -- is at least visible from both ends rather than silent.
  --
  -- LOCATION (20261013130000). The business address is carried across --
  -- physical_address into street, city, state upper-cased, zip -- because
  -- merchants_location_guard refuses a new merchant without one. A pre-app
  -- submitted before 20261013132000 may lack a city or state (submission did
  -- not require them until then), and such a pre-app CANNOT be approved: it is
  -- refused here by name, before any write, rather than left to fail on the
  -- constraint with a message that names a constraint instead of a fix. The
  -- fix is to reopen it and have the rep fill the address in.
  if coalesce(char_length(norm_city(pa.city)) < 2, true)
     or char_length(btrim(pa.city)) > 60
     or coalesce(upper(btrim(pa.state)) !~ '^[A-Z]{2}$', true) then
    raise exception 'pre-app % needs a city and a two-letter state before it can be approved',
      pre_app_id_input using errcode = 'PT409';
  end if;

  -- PROCESSOR (20261023130000). Copied as-is, NULL included: the FK on both
  -- columns means a value the pre-app holds is one the merchant accepts, so
  -- nothing here can fail on it.
  insert into merchants (agent_id, dba, legal_business_name, status,
                         split_agent_pct, split_company_pct, pre_app_id,
                         street, city, state, zip, processor)
  values (pa.agent_id, pa.dba_name, pa.legal_business_name, 'active',
          pa.split_agent_pct, pa.split_company_pct, pa.id,
          nullif(btrim(pa.physical_address), ''), btrim(pa.city),
          upper(btrim(pa.state)), nullif(btrim(pa.zip), ''), pa.processor)
  returning id into new_merchant_id;

  perform set_config('tapswipe.pre_app_transition', 'on', true);
  update pre_apps set status = 'approved' where id = pa.id;
  perform set_config('tapswipe.pre_app_transition', '', true);

  -- Two rows, so the trail links both directions. audit_log has no detail
  -- column and adding one is a bigger change than this needs.
  insert into audit_log (actor_id, action, table_name, row_id) values
    (auth.uid(), 'approve_pre_app', 'pre_apps',  pa.id::text),
    (auth.uid(), 'approve_pre_app', 'merchants', new_merchant_id::text);

  return new_merchant_id;
end;
$$;

-- create or replace keeps the existing ACL; restated so this file shows the
-- function's privilege surface.
revoke all on function approve_pre_app(int) from public;
grant execute on function approve_pre_app(int) to authenticated, service_role;
