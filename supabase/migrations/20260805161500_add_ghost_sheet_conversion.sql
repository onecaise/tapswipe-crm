-- =====================================================================
-- Ghost sheet to lead conversion, plus ON DELETE SET NULL on the link.
--
-- Mirrors docs/tapswipe_crm_schema.sql. Two changes:
--
--   1. ghost_sheets.lead_id gains `on delete set null`. It previously had no
--      ON DELETE clause, so it defaulted to NO ACTION and an admin simply
--      could not delete a lead while any ghost sheet still referenced it —
--      the delete was refused outright. Since lead_id is the authoritative
--      record of conversion state, SET NULL means a sheet whose lead is
--      deleted correctly reverts to unconverted.
--
--   2. convert_ghost_sheet_to_lead(), a Tier 2 function (§9: "atomic DB
--      logic, no secrets"). Deliberately NOT security definer, unlike
--      approve_pre_app(): the caller owns both rows, so letting their own
--      RLS scope the reads and writes is safer than re-implementing the
--      ownership check by hand.
--
--      Why a function rather than two client calls: insert-lead and
--      update-sheet must both land or neither. Two supabase-js calls leave a
--      window where the lead exists but the sheet isn't linked, and a retry
--      then creates a *second* lead. A function body is one transaction, so
--      that state is unreachable.
--
-- NOTE ON THE FIRST CHANGE: the schema doc expresses it inline in the
-- `create table ghost_sheets` statement, because that doc describes the
-- finished shape of a fresh database. A migration cannot re-declare an
-- existing column's constraint, so the same change is expressed here as a
-- drop-and-re-add of the constraint. The two are semantically identical but
-- necessarily not textually identical — the resulting delete action is
-- asserted in tests/rls/ghost-sheets.test.ts rather than by text comparison.
-- The function in part 2 *is* byte-for-byte identical to the doc.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. ghost_sheets.lead_id -> on delete set null
-- ---------------------------------------------------------------------
-- Constraint name is Postgres's default for an inline `references` on this
-- column, which is what the initial schema created.
alter table ghost_sheets
  drop constraint ghost_sheets_lead_id_fkey;

alter table ghost_sheets
  add constraint ghost_sheets_lead_id_fkey
  foreign key (lead_id) references leads(id) on delete set null;

-- ---------------------------------------------------------------------
-- 2. convert_ghost_sheet_to_lead()
-- ---------------------------------------------------------------------
create or replace function convert_ghost_sheet_to_lead(ghost_sheet_id_input int)
returns int
language plpgsql
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
  insert into leads (agent_id, dba, contact_name, contact_phone, lead_source, status)
  values (sheet.agent_id, sheet.dba, sheet.contact_name, sheet.contact_phone,
          'ghost_sheet', 'open')
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
