-- Ties documents.file_key to the row it sits on.
--
-- The documents row is written by the browser: create-upload-url authorizes the
-- caller and signs a key, then the client inserts the metadata itself. So all
-- four of agent_id / owner_type / owner_id / file_key arrive from the client,
-- and only agent_id is checked -- by the insert policy, against auth.uid().
-- file_key was checked by nothing at all.
--
-- That was a live cross-agent read. Demonstrated against the running local
-- stack: agent B inserts a documents row with agent_id = B (satisfying the
-- insert policy) and file_key = an object uploaded by agent A. B then calls
-- create-download-url with that row's id; the function resolves the row through
-- B's own client, RLS says yes because agent_id = B, and it signs whatever
-- file_key it found -- with the service role. B fetched A's file, HTTP 200.
-- The same forgery aimed at owner_id planted a row on another rep's merchant,
-- where an admin reading that merchant's page sees it as that rep's document.
--
-- The key is {agent_id}/{owner_type}/{owner_id}/{uuid}, so one prefix check
-- closes both: a forged file_key belongs to a different agent_id, and a forged
-- owner_id no longer matches the key that was actually signed.
--
-- starts_with() rather than LIKE, because owner_type contains an underscore
-- ('pre_app', 'support_ticket') and LIKE would read it as a wildcard. It is
-- immutable, so it is legal in a CHECK.
--
-- The two split_part() conjuncts make this a whole-key check rather than a
-- prefix one: a bare prefix ('<agent>/merchant/7/') and a nested key
-- ('<agent>/merchant/7/a/b') both satisfy the prefix alone. Neither crosses a
-- trust boundary — they are covered so this matches fileKeyMatchesOwner() in
-- supabase/functions/_shared/documents.ts exactly rather than approximately.
-- split_part returns '' for a field that isn't there, which is what makes "and
-- no fifth segment" expressible.
--
-- NOT VALID: rows predating this came from hand-rolled fixtures and dev seeds
-- with keys like 'k/3', and validating would make `supabase db push` fail
-- against whichever environment still holds one. documents has no UPDATE policy
-- and no UPDATE grant, so no row can be edited into violating it -- NOT VALID
-- still covers everything the app can create. create-download-url re-derives
-- the same prefix and refuses to sign a mismatch, so an exempted legacy row is
-- not a usable read primitive either.

alter table documents
  add constraint documents_file_key_matches_owner
  check (
    starts_with(
      file_key,
      agent_id::text || '/' || owner_type || '/' || owner_id::text || '/'
    )
    and split_part(file_key, '/', 4) <> ''
    and split_part(file_key, '/', 5) = ''
  ) not valid;
