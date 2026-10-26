-- Rep identity: profiles.legal_name + profiles.llc_legal_name, the admin-only
-- set_rep_identity() RPC that is their only write path, and the two matching
-- columns on the bulk import's staging rows.
--
-- Phase 2 of docs/design/intake-and-reports.md (§7.1, §0.6, §9 A16/A20).
-- Matches docs/tapswipe_crm_schema.sql, updated first.
--
-- No row guard. Phase 1's rule is "refuse the rows the change would break, and
-- say which": this migration adds two nullable columns whose CHECKs pass for
-- null, and widens a CHECK vocabulary to a superset. No existing row can fail
-- either, so there is nothing to refuse.
--
-- What this does NOT do (phase 4): refuse a pre-app submit while either value
-- is missing, and snapshot both onto the pre-app at submit.

-- ---------------------------------------------------------------------
-- 1. The columns.
--
-- Nullable: admins and older accounts have none, and both are optional at
-- account creation (memo A20). A rep with no LLC has their own legal name
-- (or sole-proprietor business name) entered as the LLC legal name by the
-- admin, never a placeholder (A16).
--
-- The CHECKs restate set_rep_identity()'s rules -- trimmed, non-blank, at most
-- 200 characters -- so even the service role cannot store a value the RPC
-- would refuse. Named, so tests can pin them by name rather than by SQLSTATE.
--
-- NEVER IN A POLICY. These are not an access boundary. The existing profiles
-- select policy already gives the right read surface: a rep sees their own two
-- values, an admin sees everyone's. tests/rls/set-rep-identity.test.ts greps
-- pg_policies for both names.
-- ---------------------------------------------------------------------
alter table profiles
  add column if not exists legal_name text
    constraint profiles_legal_name_format check (
      legal_name is null or (
        legal_name = btrim(legal_name, E' \t\n\r\f\x0b')
        and legal_name <> ''
        and length(legal_name) <= 200
      )
    ),
  add column if not exists llc_legal_name text
    constraint profiles_llc_legal_name_format check (
      llc_legal_name is null or (
        llc_legal_name = btrim(llc_legal_name, E' \t\n\r\f\x0b')
        and llc_legal_name <> ''
        and length(llc_legal_name) <= 200
      )
    );

-- No grant change. `authenticated` holds SELECT and nothing else on profiles
-- (20260811173000), and there is no UPDATE policy, so neither an admin nor the
-- rep can write these columns directly -- a PATCH is "permission denied".

-- ---------------------------------------------------------------------
-- 2. set_rep_identity(user_id uuid, legal_name text, llc_legal_name text)
--
-- The set_territory() shape (20261002143000): `security definer`, pinned
-- search_path, is_admin() first. is_admin() already requires is_active, so a
-- deactivated admin's still-valid token is refused.
--
-- Sets BOTH columns on every call; the caller sends the pair it wants stored.
-- Per value: null clears it; text is trimmed, and blank-after-trim or over
-- 200 characters is REFUSED (PT400). Blank is refused rather than turned into
-- null so that '' can never be read as "clear" -- a caller that means clear
-- sends null. (The memo said "blank to null"; the phase 2 prompt said "reject
-- empty strings". The prompt is later and stricter; see the build notes.)
--
-- "Trimmed" means ASCII whitespace, not just spaces: plain btrim(x) strips
-- spaces only, so '\tIto LLC' would be stored as typed and ' \t ' would pass as
-- non-blank (both caught by the tests). The explicit set matches what JS
-- .trim() strips for ASCII input, and the CHECKs above use the same set.
--
-- The 200 cap is REP_IDENTITY_MAX_LENGTH in _shared/admin-users.ts.
-- tests/unit/rep-identity.test.ts reads this file and pins the pair.
--
-- Audited as 'set_rep_identity', in the same statement as the update. There is
-- no exception handler around the insert, on purpose: if the audit row cannot
-- be written, the update rolls back with it (fails closed). One verb whatever
-- changed -- audit_log has no detail column, and four set/clear combinations of
-- two fields would be four verbs for one admin action.
--
-- No change, no audit row (`is not distinct from`, as set_territory).
--
-- Parameter names are the memo's. They shadow the column names, so every
-- reference to a parameter inside a SQL statement is qualified with the
-- function name; the SET targets are columns by grammar.
-- ---------------------------------------------------------------------
create or replace function set_rep_identity(
  user_id uuid,
  legal_name text,
  llc_legal_name text
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  new_legal text;
  new_llc text;
  target profiles;
begin
  if not is_admin() then
    raise exception 'admin only' using errcode = 'PT403';
  end if;

  new_legal := btrim(set_rep_identity.legal_name, E' \t\n\r\f\x0b');
  new_llc := btrim(set_rep_identity.llc_legal_name, E' \t\n\r\f\x0b');

  if new_legal = '' then
    raise exception 'legal name cannot be blank' using errcode = 'PT400';
  end if;
  if new_llc = '' then
    raise exception 'LLC legal name cannot be blank' using errcode = 'PT400';
  end if;
  if length(new_legal) > 200 then
    raise exception 'legal name must be 200 characters or fewer'
      using errcode = 'PT400';
  end if;
  if length(new_llc) > 200 then
    raise exception 'LLC legal name must be 200 characters or fewer'
      using errcode = 'PT400';
  end if;

  select * into target from profiles where id = set_rep_identity.user_id;
  if not found then
    raise exception 'user not found' using errcode = 'PT404';
  end if;

  if target.legal_name is not distinct from new_legal
     and target.llc_legal_name is not distinct from new_llc then
    return;
  end if;

  update profiles
     set legal_name = new_legal,
         llc_legal_name = new_llc
   where id = set_rep_identity.user_id;

  insert into audit_log (actor_id, action, table_name, row_id)
  values (auth.uid(), 'set_rep_identity', 'profiles',
          set_rep_identity.user_id::text);
end;
$$;

-- Postgres grants EXECUTE to PUBLIC (which includes anon) on every new
-- function, and nothing declarative revokes it (tests/rls/grants.test.ts pins
-- the gap). Without these two lines this RPC, which writes profiles, would be
-- callable unauthenticated from the moment it exists.
revoke all on function set_rep_identity(uuid, text, text) from public;
grant execute on function set_rep_identity(uuid, text, text) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 3. Bulk import staging: two optional CSV columns ("Legal name", "LLC legal
-- name") and two blockers for a value over the 200 cap.
--
-- Staging rows are admin-only to read and written only by the service role
-- (20260918141129); the table-level grants already cover new columns. The
-- names are stored here only until provision-user-batch hands them to
-- set_rep_identity() for the account it just created.
--
-- The blocker CHECK is replaced by a superset under the same name, so every
-- existing row still passes. Both new blockers BLOCK the batch: they are file
-- problems, fixed by a corrected upload, and isBlocking()'s skippable pair is
-- unchanged.
-- ---------------------------------------------------------------------
alter table user_import_rows
  add column if not exists legal_name_raw text,
  add column if not exists llc_legal_name_raw text,
  add column if not exists legal_name text,
  add column if not exists llc_legal_name text;

alter table user_import_rows
  drop constraint if exists user_import_rows_blocker_check;
alter table user_import_rows
  add constraint user_import_rows_blocker_check check (blocker in (
    'missing_name', 'invalid_email', 'invalid_role', 'invalid_agent_number',
    'invalid_legal_name', 'invalid_llc_legal_name',
    'duplicate_email_in_file', 'duplicate_agent_number_in_file',
    'email_exists', 'agent_number_taken'
  ));
