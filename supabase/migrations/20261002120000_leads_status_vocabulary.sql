-- leads gets a real status vocabulary, a required reason for losing one, and
-- the website field pre_apps has always had.
--
-- Matches docs/tapswipe_crm_schema.sql, which was updated first.
--
-- Until now `leads.status` was `text default 'open'` with no check and no
-- not-null. The standing argument for that (recorded on support_tickets.status
-- and in lib/leads.ts) was that a vocabulary living only in TypeScript is free
-- to drift from the column's real contents. True -- and the answer is to put
-- the vocabulary in the column, not to leave the column shapeless. What the
-- shapeless version actually bought was a free-text <input> on the lead form
-- whose toPayload() maps blank to NULL, so production holds 'open', NULL, and
-- whatever each rep typed.
--
-- Seven values and no 'won'. A lead's win is derived -- an approved pre_app or
-- a merchant pointing back at the lead -- exactly the way dashboard_counts()
-- already derives active_leads, and for the same reason: a stage a rep edits by
-- hand and a funnel position the records themselves prove are different facts,
-- and storing the second as the first lets them disagree. No won column and no
-- won value.
--
-- No state-machine trigger, deliberately, unlike pre_apps_guard_transitions.
-- Sales moves backwards as a matter of course (qualified back to contacted when
-- a champion leaves) and no lead stage has a consequence the way a pre-app
-- approval does, which creates a merchant. A guard would stop a rep undoing a
-- mis-click and nothing else. The audit trail is already covered: leads is one
-- of the seven tables carrying log_cross_agent_change().

-- ---------------------------------------------------------------------
-- 1. NEW COLUMNS
--
-- website first, because it is the uncomplicated one. pre_apps.website has
-- existed since the initial schema while leads has not, so a rep who found a
-- merchant's site while working the lead had nowhere to put it and retyped it
-- at pre-app time. preAppDefaultsFromLead now carries it across.
--
-- lost_reason mirrors pre_apps.decline_reason: a terminal state owes the next
-- person reading the record an explanation. Plain nullable text -- the CHECK
-- below is what makes it required, and only when it is required.
-- ---------------------------------------------------------------------
alter table leads
  add column if not exists website     text,
  add column if not exists lost_reason text;

-- ---------------------------------------------------------------------
-- 2. BACKFILL THE TWO UNAMBIGUOUS CASES, AND ONLY THOSE
--
-- NULL and 'open' both mean "nobody has moved this anywhere", which is 'new'.
-- NULL arrives from toPayload() turning a blank field into NULL; 'open' is the
-- column default every row got before anyone touched it. Neither carries
-- information this rewrite can lose.
--
-- Rep-typed strings are NOT touched. They are a human's words about a specific
-- deal, and a migration cannot tell 'Left voicemail' from 'dead' from
-- 'VM 3x, try Tuesday'. Mapping them by guess would destroy information no
-- backup brings back, and mapping them all to 'new' would quietly resurrect
-- lost deals into the top of the pipeline. They stay as they are and are
-- listed by the review query in step 4.
-- ---------------------------------------------------------------------
update leads set status = 'new' where status is null or status = 'open';

-- ---------------------------------------------------------------------
-- 3. DEFAULT AND NOT NULL
--
-- NOT NULL is not optional alongside the CHECK, it is half of the same
-- mechanism. A CHECK evaluates to NULL for a NULL input and a CHECK that
-- evaluates to NULL PASSES -- so without this line `set status = null` is
-- accepted and defeats the vocabulary, the pipeline filter and every count
-- built on them, silently. pre_apps.status carries the identical pair and its
-- comment says so.
--
-- Validated immediately rather than NOT VALID: step 2 just removed the only
-- NULLs there can be, so the scan has nothing to find. The vocabulary CHECK is
-- the one that cannot say that.
-- ---------------------------------------------------------------------
alter table leads
  alter column status set default 'new',
  alter column status set not null;

-- ---------------------------------------------------------------------
-- 4. THE VOCABULARY, NOT VALID
--
-- `not valid` for the reason merchants_split_totals_100 is: it binds every
-- insert and update from here on and leaves existing rows alone, because this
-- migration has no authority to rewrite what a rep typed. Note what NOT VALID
-- does NOT mean -- it is not "off". An existing bad row that anyone edits is
-- checked on the way out, so working a stale lead through the app is what
-- fixes it, which is exactly the review path intended.
--
-- To find what predates this:
--
--   select id, agent_id, dba, status from leads
--    where status not in ('new', 'contacted', 'qualified', 'proposal_sent',
--                         'application_sent', 'nurturing', 'lost')
--    order by status, id;
--
-- Fix those rows THROUGH THE APP rather than with an UPDATE here: the lead form
-- now offers the vocabulary as a <select> and shows an unrecognised value as a
-- "needs review" option that cannot be saved, the cross-agent audit trigger
-- sees the change, and the rep who wrote the words is the one choosing what
-- they meant. Then, in a follow-up migration once the query returns nothing:
--
--   alter table leads validate constraint leads_status_vocabulary;
--
-- leads_lost_reason_required is NOT VALID for a narrower reason: nothing
-- stopped a rep typing the literal word 'lost' into the old free-text column,
-- and no such row can have a lost_reason because the column did not exist until
-- step 1. Its own check, for the same follow-up:
--
--   select id, agent_id, dba from leads
--    where status = 'lost' and (lost_reason is null or btrim(lost_reason) = '');
--
-- btrim in the constraint because '' is a value. A reason that accepts a single
-- space enforces nothing anyone cares about -- the same trap profiles
-- .agent_number's partial unique index has to dodge.
--
-- Both named rather than inline so a test can match on the name and say which
-- rule it caught, instead of matching a generic /check|violates/.
-- ---------------------------------------------------------------------
alter table leads
  add constraint leads_status_vocabulary check (status in (
    'new', 'contacted', 'qualified', 'proposal_sent', 'application_sent',
    'nurturing', 'lost'
  )) not valid,
  add constraint leads_lost_reason_required check (
    status <> 'lost' or (lost_reason is not null and btrim(lost_reason) <> '')
  ) not valid;

-- ---------------------------------------------------------------------
-- 5. INDEX
--
-- The pipeline view filters on status the way the existing view filters on
-- next_followup_date, and both are now offered together. Two single-column
-- indexes rather than a composite: either filter is usable on its own, the
-- agent_id index already narrows the set, and the pair is never the predicate
-- by itself.
-- ---------------------------------------------------------------------
create index if not exists idx_leads_status on leads(status);

-- ---------------------------------------------------------------------
-- 6. convert_ghost_sheet_to_lead WRITES 'new'
--
-- It hardcoded 'open', which is no longer in the vocabulary -- and NOT VALID
-- does not exempt it, because this is an INSERT. Left alone, converting a ghost
-- sheet would start failing the moment this migration landed.
--
-- Replaced whole rather than patched: `create or replace` preserves the
-- existing ACL, but the revoke/grant pair is restated below anyway, matching
-- 20260813162634 -- the cost is two lines and the failure mode of assuming
-- otherwise is an RPC callable by anon.
--
-- The body is otherwise identical to 20260813162634's.
-- ---------------------------------------------------------------------
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
  -- owns the sheet or is an admin -- no hand-written ownership check needed.
  -- "not found" therefore covers both a nonexistent sheet and someone else's,
  -- which is the same non-disclosure the detail pages rely on.
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
  -- 'Ghost sheet' rather than 'ghost_sheet'. lead_source is free text a rep
  -- types ("Referral", "Cold call", "Web form") and it renders raw on the lead
  -- page, so the machine-shaped value stood out as the one entry nobody wrote.
  --
  -- status 'new', not 'open': a sheet someone just converted is the most new a
  -- lead can be, and 'open' is not a value any more.
  insert into leads (agent_id, dba, contact_name, contact_phone, lead_source, status)
  values (sheet.agent_id, sheet.dba, sheet.contact_name, sheet.contact_phone,
          'Ghost sheet', 'new')
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

-- No grant change and no policy change on leads itself. The table already
-- grants select, insert, update and delete to authenticated and its four
-- policies are untouched, so a rep still sees only their own book and an admin
-- the company's -- the same boundary that already governed dba and
-- next_followup_date. These columns carry no new privilege, only values that
-- were previously unrecordable. Same reasoning as 20260928143000.
