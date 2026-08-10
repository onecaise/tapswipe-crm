-- Support tickets, notes and tasks: the delete policies and the indexes the
-- three UIs need. docs/tapswipe_crm_schema.sql is the spec and was updated
-- first; everything below is copied from it.
--
-- No table is created here. support_tickets, notes and tasks have existed since
-- 20260804201300 with RLS enabled and their select/insert/update policies, and
-- 20260805200000 already grants all three (plus their sequences) to
-- `authenticated` and `service_role`. What was missing is what building the UI
-- on top of them exposed.

-- =====================================================================
-- support_tickets.status — a real vocabulary, because the list filters on it.
--
-- It shipped as bare `text default 'open'`, nullable and unconstrained. Both
-- halves matter and for different reasons:
--
--   NOT NULL, exactly as pre_apps.status needed in 20260806140000: a CHECK
--   that evaluates to NULL passes, so `set status = null` would satisfy the
--   constraint added below AND fall out of every status filter at once.
--
--   CHECK, because a vocabulary that exists only in lib/support-tickets.ts is
--   free to drift from what the column actually holds -- the reason the leads
--   list filters on next_followup_date rather than inventing a status list
--   (see the note in lib/leads.ts). merchants.status and pre_apps.status are
--   both constrained; this makes the third filtered status match.
--
-- The normalizing UPDATE runs first so the constraint cannot fail on existing
-- data. Nothing should match it -- the feature was never built, so every
-- environment's table is empty -- but "should be empty" is not a thing to bet a
-- migration on, and 'open' is the column's own default.
-- =====================================================================
update support_tickets set status = 'open'
 where status is null or status not in ('open', 'pending', 'closed');

alter table support_tickets
  alter column status set not null,
  add constraint support_tickets_status_check
    check (status in ('open', 'pending', 'closed'));

-- =====================================================================
-- DELETE POLICIES — the four-policy set every other Tier 1 table carries.
--
-- These three tables shipped with select/insert(/update) and no delete policy
-- at all, which is not "admin only" but "nobody, ever": RLS denies what no
-- policy permits, and there is no way to reach it. merchants, leads,
-- ghost_sheets and pre_apps all have `admin delete only`, so an admin could
-- remove a merchant but not the ticket complaining about it.
--
-- Reps deliberately do NOT get delete on their own rows here. `documents` is
-- the standing exception to admin-only deletes and it is an exception for a
-- specific reason -- a rep who uploads the wrong file has published something
-- and needs it gone. A note or a ticket is a record of what was said, and the
-- correction for a wrong one is another one.
-- =====================================================================
create policy "admin delete only" on support_tickets
  for delete using (is_admin());

create policy "admin delete only" on notes
  for delete using (is_admin());

create policy "admin delete only" on tasks
  for delete using (is_admin());

-- Notes remain APPEND-ONLY: no update policy is added here, on purpose. A note
-- can be written, and removed by an admin, but never silently rewritten, so a
-- quoted note cannot have changed since it was quoted. It is the one Tier 1
-- table without an update policy, which reads like an omission -- it isn't, and
-- the UI must not offer an edit affordance, because RLS would filter the UPDATE
-- to zero rows and the rep would see a save that did nothing.
--
-- tasks keeps the update policy it already has: `completed` exists to be
-- toggled.

-- =====================================================================
-- INDEXES.
--
-- 1. support_tickets(status) — the list page's FilterTabs filter on it, the
--    same shape as merchants(status) and pre_apps(status).
--
-- 2. The polymorphic owner pair, on all THREE tables that carry it. documents
--    is included even though it is not otherwise part of this change: it is
--    read by exactly the same `owner_type = $1 and owner_id = $2` predicate,
--    from the same detail pages that will now also render notes and tasks, so
--    the omission is one omission rather than documents' own.
--
--    agent_id does not serve these queries: a rep's entire book shares one
--    agent_id, so idx_*_agent_id selects everything they own and the owner pair
--    is then filtered row by row. Three such queries per detail-page render.
--
--    owner_type leads the composite -- both columns are always supplied
--    together, so either order serves the pair, and putting the small-domain
--    equality column first also makes the index useful for a bare
--    `where owner_type = 'lead'` sweep. No index on owner_id alone: nothing
--    looks a note up by owner_id without naming the type, and the values
--    collide across types by construction (merchant 7 and lead 7 both exist).
-- =====================================================================
create index idx_support_tickets_status on support_tickets(status);

create index idx_documents_owner on documents(owner_type, owner_id);
create index idx_notes_owner on notes(owner_type, owner_id);
create index idx_tasks_owner on tasks(owner_type, owner_id);
