-- Pre-app schema hardening, ahead of building the submission flow.
-- docs/tapswipe_crm_schema.sql is the spec and was updated first; this brings
-- the migrations in line with it.
--
-- Five gaps, every one of which the wizard runs into immediately:
--
--   1. `status` is nullable, and a CHECK that evaluates to NULL passes -- so
--      `set status = null` is accepted today and defeats the state machine.
--   2. There is nowhere to record the commission split, so approve_pre_app
--      creates merchants with a NULL split and an admin retypes deal terms
--      the pre-app already captured.
--   3. pre_app_terminal and pre_app_business_profile are one section of one
--      form but nothing stops a second row, so a debounced autosave can
--      silently duplicate them. Nor do the secrets tables constrain their
--      parent reference, so nothing defines "the current SSN".
--   4. No child FK declares a referential action, so an admin deleting a
--      populated pre-app fails on the FK -- and cannot clear the children
--      first, because the *_secrets tables are granted to nobody.
--   5. The three non-secret children have no DELETE policy at all, so
--      "remove this owner" is impossible from the client.
--
-- No new grants: the four non-secret pre-app tables and their sequences were
-- granted in 20260805200000, and service_role holds `grant all`. The three
-- *_secrets tables deliberately gain no grant and no policy here -- adding
-- columns and constraints does not change their access surface, and
-- tests/rls/grants.test.ts pins that they stay at zero privileges.

-- 1. status NOT NULL ---------------------------------------------------
-- Defensive: nothing writes pre_apps yet, so this updates zero rows on every
-- known database. It is here so the migration is safe against any hand-made
-- row in a project that got ahead of the repo.
update pre_apps set status = 'draft' where status is null;
alter table pre_apps alter column status set not null;

-- 2. commission split + decline reason ---------------------------------
alter table pre_apps
  add column decline_reason text,
  add column split_agent_pct numeric(5,2) not null default 50,
  add column split_company_pct numeric(5,2) not null default 50,
  add constraint pre_apps_split_sums_to_100
    check (split_agent_pct + split_company_pct = 100);

-- 3. one row per pre-app ----------------------------------------------
-- No dedupe pass first: nothing in the app writes any of these five tables
-- yet (both secrets Edge Functions are still hello-world stubs), so there are
-- no duplicates to collapse. If that ever stops being true, this migration
-- would need a `delete from ... where id not in (select min(id) ...)` ahead
-- of each constraint.
alter table pre_app_terminal
  add constraint pre_app_terminal_pre_app_id_key unique (pre_app_id);
alter table pre_app_business_profile
  add constraint pre_app_business_profile_pre_app_id_key unique (pre_app_id);
alter table pre_app_owner_secrets
  add constraint pre_app_owner_secrets_pre_app_owner_id_key unique (pre_app_owner_id);
alter table pre_app_banking_secrets
  add constraint pre_app_banking_secrets_pre_app_id_key unique (pre_app_id);
alter table pre_app_terminal_secrets
  add constraint pre_app_terminal_secrets_pre_app_id_key unique (pre_app_id);

-- Each of those constraints creates a unique btree index on the very column
-- these two plain indexes cover, so the plain ones are now duplicate work on
-- every insert and update. pre_app_owners keeps its index -- it has many rows
-- per pre-app and so gets no unique constraint.
drop index idx_pre_app_terminal_pre_app_id;
drop index idx_pre_app_business_profile_pre_app_id;

-- 4. ON DELETE CASCADE on every child FK -------------------------------
-- The cascade runs as the constraint owner and therefore bypasses RLS. That
-- is the point: it is what lets an admin delete a pre-app, and a rep remove
-- an owner who has an SSN on file, without anyone needing a grant on the
-- secrets tables. Same drop-and-re-add shape as ghost_sheets.lead_id in
-- 20260805161500, and the same reason the name is unchanged: it matches what
-- Postgres would have generated inline.
alter table pre_app_owners
  drop constraint pre_app_owners_pre_app_id_fkey,
  add  constraint pre_app_owners_pre_app_id_fkey
    foreign key (pre_app_id) references pre_apps(id) on delete cascade;

alter table pre_app_terminal
  drop constraint pre_app_terminal_pre_app_id_fkey,
  add  constraint pre_app_terminal_pre_app_id_fkey
    foreign key (pre_app_id) references pre_apps(id) on delete cascade;

alter table pre_app_business_profile
  drop constraint pre_app_business_profile_pre_app_id_fkey,
  add  constraint pre_app_business_profile_pre_app_id_fkey
    foreign key (pre_app_id) references pre_apps(id) on delete cascade;

alter table pre_app_owner_secrets
  drop constraint pre_app_owner_secrets_pre_app_owner_id_fkey,
  add  constraint pre_app_owner_secrets_pre_app_owner_id_fkey
    foreign key (pre_app_owner_id) references pre_app_owners(id) on delete cascade;

alter table pre_app_banking_secrets
  drop constraint pre_app_banking_secrets_pre_app_id_fkey,
  add  constraint pre_app_banking_secrets_pre_app_id_fkey
    foreign key (pre_app_id) references pre_apps(id) on delete cascade;

alter table pre_app_terminal_secrets
  drop constraint pre_app_terminal_secrets_pre_app_id_fkey,
  add  constraint pre_app_terminal_secrets_pre_app_id_fkey
    foreign key (pre_app_id) references pre_apps(id) on delete cascade;

-- The same bug one table over, and the same fix ghost_sheets.lead_id already
-- got: with NO ACTION here, an admin cannot delete a lead that any pre-app
-- points at. lead_id records provenance ("this came from that lead"), not a
-- dependency, so losing the link is the right outcome -- SET NULL rather than
-- CASCADE, because deleting a lead must never delete a merchant application.
alter table pre_apps
  drop constraint pre_apps_lead_id_fkey,
  add  constraint pre_apps_lead_id_fkey
    foreign key (lead_id) references leads(id) on delete set null;

-- 4b. key_version on the secrets tables --------------------------------
-- The stored layout is a bare IV || ciphertext || tag with no version field,
-- so nothing in the value itself says which key or which algorithm produced
-- it. Rotating PRE_APP_SECRETS_KEY, or moving off AES-256-GCM later, would
-- leave every existing row undecodable with no way to tell old rows from new.
-- The column is free now and cannot be backfilled once real ciphertext
-- exists, which is the only reason it is in this migration rather than the
-- one that adds the encryption.
--
-- No grant needed: column privileges follow the table, and these three have
-- none for anon or authenticated by design.
alter table pre_app_owner_secrets    add column key_version smallint not null default 1;
alter table pre_app_banking_secrets  add column key_version smallint not null default 1;
alter table pre_app_terminal_secrets add column key_version smallint not null default 1;

-- 5. child DELETE policies, and an explicit `with check` on update -----
-- Delete is NOT admin-only on these three, unlike everywhere else. A rep
-- filling in a long form has to be able to remove a row they added by
-- mistake -- the same exception `documents` already makes for a rep's own
-- uploads. The check is still the parent's: is_active_agent() wrapping an
-- exists() on pre_apps, never a bare agent_id comparison.
--
-- The update policies are dropped and recreated rather than ALTERed so the
-- `with check` half is written down. Postgres reuses the USING expression
-- when a policy omits it, so behaviour does not change -- but a reader
-- should not have to know that rule to see that re-parenting a row to
-- someone else's pre-app is refused. Same drop-and-recreate approach as
-- 20260805103000.

drop policy "update via parent pre_app" on pre_app_owners;
create policy "update via parent pre_app" on pre_app_owners
  for update using (
    is_admin() or (is_active_agent() and exists (
      select 1 from pre_apps where pre_apps.id = pre_app_id and pre_apps.agent_id = auth.uid()
    ))
  )
  with check (
    is_admin() or (is_active_agent() and exists (
      select 1 from pre_apps where pre_apps.id = pre_app_id and pre_apps.agent_id = auth.uid()
    ))
  );
create policy "delete via parent pre_app" on pre_app_owners
  for delete using (
    is_admin() or (is_active_agent() and exists (
      select 1 from pre_apps where pre_apps.id = pre_app_id and pre_apps.agent_id = auth.uid()
    ))
  );

drop policy "update via parent pre_app" on pre_app_terminal;
create policy "update via parent pre_app" on pre_app_terminal
  for update using (
    is_admin() or (is_active_agent() and exists (
      select 1 from pre_apps where pre_apps.id = pre_app_id and pre_apps.agent_id = auth.uid()
    ))
  )
  with check (
    is_admin() or (is_active_agent() and exists (
      select 1 from pre_apps where pre_apps.id = pre_app_id and pre_apps.agent_id = auth.uid()
    ))
  );
create policy "delete via parent pre_app" on pre_app_terminal
  for delete using (
    is_admin() or (is_active_agent() and exists (
      select 1 from pre_apps where pre_apps.id = pre_app_id and pre_apps.agent_id = auth.uid()
    ))
  );

drop policy "update via parent pre_app" on pre_app_business_profile;
create policy "update via parent pre_app" on pre_app_business_profile
  for update using (
    is_admin() or (is_active_agent() and exists (
      select 1 from pre_apps where pre_apps.id = pre_app_id and pre_apps.agent_id = auth.uid()
    ))
  )
  with check (
    is_admin() or (is_active_agent() and exists (
      select 1 from pre_apps where pre_apps.id = pre_app_id and pre_apps.agent_id = auth.uid()
    ))
  );
create policy "delete via parent pre_app" on pre_app_business_profile
  for delete using (
    is_admin() or (is_active_agent() and exists (
      select 1 from pre_apps where pre_apps.id = pre_app_id and pre_apps.agent_id = auth.uid()
    ))
  );

-- 6. An unrelated one-line privilege fix, done here because it is the same
--    class of bug and a whole migration for one line is worse ---------------
-- set_updated_at() was created in 20260805143000 and never named in the
-- grants migration's revoke list, so it still carries Postgres's default
-- `=X/public` ACL and is executable by anon. Harmless in practice -- calling a
-- trigger function directly raises "can only be called as a trigger" -- but
-- it is exactly the gap tests/rls/grants.test.ts claims to pin, and leaving a
-- known-open function around teaches the wrong habit.
--
-- Revoke with no matching grant: a trigger fires regardless of whether the
-- querying role holds EXECUTE on its function, so granting would only widen
-- the surface for nothing.
revoke all on function set_updated_at() from public;
