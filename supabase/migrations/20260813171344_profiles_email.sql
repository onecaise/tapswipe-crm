-- profiles.email, so Manage Users can show who an account belongs to.
--
-- The page listed full_name and nothing else, which makes two reps with the
-- same name indistinguishable on the one screen that manages accounts — and
-- there is no other surface in the app that shows an email at all.
--
-- A denormalised copy of auth.users.email, which stays the authority. The
-- alternative was a new admin Edge Function calling auth.admin.listUsers just
-- to render a column, since auth.users is not reachable from the Data API. That
-- is a lot of new authenticated surface for one string.
--
-- The copy is only safe because nothing in this app changes an email after
-- creation: there is no email-change flow, and GoTrue's own would bypass this
-- column entirely. If one is ever added it must write here too.
--
-- Matches docs/tapswipe_crm_schema.sql, updated first.

alter table profiles
  add column if not exists email text;

-- Backfill from the authority. Runs as the migration role, which can read
-- auth.users; nothing at the Data API layer can, which is the whole reason the
-- column exists.
update profiles p
   set email = u.email
  from auth.users u
 where u.id = p.id
   and p.email is null;

-- No grant changes. profiles is already granted to authenticated and the select
-- policy is unchanged, so an agent still sees only their own row and an admin
-- sees all — the same boundary that already governed full_name and role. The
-- column carries no new privilege, only a value that was previously unreachable.
--
-- No index either: the page reads every profile, and there is no lookup by
-- email anywhere. Sign-in goes through GoTrue against auth.users.
