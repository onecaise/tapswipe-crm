-- Three findings from the functional QA sweep, all on the merchant/pre-app seam.
--
-- 1. merchants took any pair of split percentages. pre_apps has enforced
--    agent + company = 100 since 20260806140000 and the wizard derives the
--    company half, so approved merchants were always consistent; hand-edited
--    ones were not. Saving 60/45 through the merchant form raised nothing.
-- 2. Approving a pre-app created a merchant with no record of where it came
--    from, so neither record could point at the other.
-- 3. convert_ghost_sheet_to_lead wrote lead_source = 'ghost_sheet' into a
--    free-text column whose other values are things a rep typed.
--
-- Matches docs/tapswipe_crm_schema.sql, which was updated first.

-- ---------------------------------------------------------------------
-- 1. MERCHANT SPLIT MUST TOTAL 100
--
-- `not valid` on purpose: it binds every insert and update from here on, and
-- leaves existing rows alone. Nothing in this migration can tell a typo from a
-- deal someone actually struck, and silently rewriting commission figures is a
-- worse outcome than leaving a handful of rows to be looked at by someone who
-- knows. The query to list them is in the schema doc; once they are settled,
--   alter table merchants validate constraint merchants_split_totals_100;
--
-- Both-null stays legal — a merchant whose split is not recorded yet is an
-- ordinary state, and the coalesce pair would otherwise force NULL+NULL to 100.
-- ---------------------------------------------------------------------
alter table merchants
  add constraint merchants_split_totals_100 check (
    (split_agent_pct is null and split_company_pct is null)
    or coalesce(split_agent_pct, 0) + coalesce(split_company_pct, 0) = 100
  ) not valid;

-- ---------------------------------------------------------------------
-- 2. MERCHANT -> PRE-APP PROVENANCE
--
-- `on delete set null` for the reason ghost_sheets.lead_id uses it: pre_apps
-- has an admin-only DELETE policy, and without a referential action that delete
-- fails against any merchant approved from the row. The merchant is the durable
-- record and outlives its application, so losing the pointer is the right trade.
--
-- No backfill is possible. Nothing recorded the relationship before now, and
-- matching on dba text would invent links that may not be true. Rows approved
-- before this migration keep pre_app_id null, and both pages treat null as
-- "created by hand" rather than as an error.
-- ---------------------------------------------------------------------
alter table merchants
  add column if not exists pre_app_id int;

alter table merchants
  add constraint merchants_pre_app_id_fkey
  foreign key (pre_app_id) references pre_apps(id) on delete set null;

create index if not exists idx_merchants_pre_app_id on merchants(pre_app_id);

-- approve_pre_app now records it. Every other column it writes is a copy taken
-- at approval and nothing syncs afterwards, so this pointer is provenance, not
-- a live link — an admin editing an approved pre-app still leaves the merchant
-- untouched. That is deliberate; the pointer just makes the divergence visible.
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
  -- a live link. Every other column here is a COPY taken at approval and
  -- nothing syncs afterwards, so an admin editing an approved pre-app changes
  -- the application and not the merchant. That is deliberate — the merchant is
  -- the record of what was agreed — and the pointer exists so the divergence is
  -- visible from both ends rather than silent.
  insert into merchants (agent_id, dba, legal_business_name, status,
                         split_agent_pct, split_company_pct, pre_app_id)
  values (pa.agent_id, pa.dba_name, pa.legal_business_name, 'active',
          pa.split_agent_pct, pa.split_company_pct, pa.id)
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

revoke all on function approve_pre_app(int) from public;
grant execute on function approve_pre_app(int) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 3. LEAD SOURCE READS LIKE THE OTHER VALUES
--
-- lead_source is unconstrained free text; its other entries are things a rep
-- typed. 'ghost_sheet' rendered raw on the lead page as the one machine-shaped
-- entry in the column.
--
-- The backfill is safe because no code branches on this value — nothing reads
-- lead_source except the display layer and search, both of which take it as
-- text. Scoped to the exact old literal so a rep who typed something similar
-- is left alone.
-- ---------------------------------------------------------------------
update leads set lead_source = 'Ghost sheet' where lead_source = 'ghost_sheet';

create or replace function convert_ghost_sheet_to_lead(ghost_sheet_id_input int)
returns int
language plpgsql
security invoker
set search_path = public
as $$
declare
  sheet ghost_sheets;
  new_lead_id int;
begin
  -- RLS applies (security invoker), so this finds nothing unless the caller
  -- owns the sheet or is an admin — no hand-written ownership check needed.
  -- "not found" therefore covers both a nonexistent sheet and someone
  -- else's, which is the same non-disclosure the detail pages rely on.
  select * into sheet from ghost_sheets where id = ghost_sheet_id_input;
  if not found then
    raise exception 'ghost sheet not found';
  end if;
  if sheet.lead_id is not null then
    raise exception 'ghost sheet already converted';
  end if;

  -- agent_id comes from the sheet, not auth.uid(): an admin converting on a
  -- rep's behalf must not move the lead into their own book.
  --
  -- 'Ghost sheet' rather than 'ghost_sheet': lead_source is free text a rep
  -- types, and this was the one machine-shaped value in the column.
  insert into leads (agent_id, dba, contact_name, contact_phone, lead_source, status)
  values (sheet.agent_id, sheet.dba, sheet.contact_name, sheet.contact_phone,
          'Ghost sheet', 'open')
  returning id into new_lead_id;

  -- leads has no notes column, so the sheet's notes become a row in the
  -- polymorphic notes table. Guarded because notes.body is `not null`.
  if sheet.notes is not null and btrim(sheet.notes) <> '' then
    insert into notes (agent_id, owner_type, owner_id, body)
    values (sheet.agent_id, 'lead', new_lead_id, sheet.notes);
  end if;

  update ghost_sheets
     set lead_id = new_lead_id, status = 'converted'
   where id = ghost_sheet_id_input;

  return new_lead_id;
end;
$$;

revoke all on function convert_ghost_sheet_to_lead(int) from public;
grant execute on function convert_ghost_sheet_to_lead(int) to authenticated, service_role;
