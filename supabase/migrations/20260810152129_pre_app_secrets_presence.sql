-- Presence-only access to the pre-app secrets tables, for the wizard's review
-- step.
--
-- docs/tapswipe_crm_schema.sql is the spec and was updated first; the function
-- body below is copied from it verbatim.
--
-- Why this is not read-pre-app-secrets: that Edge Function decrypts, and
-- audits every read. The review step needs two booleans -- is banking on file,
-- how many owners lack an SSN -- to mirror submit_pre_app's rules before the
-- rep spends a round trip. Getting them from the decrypting path meant an
-- admin's browser received full plaintext to render a checklist, and every
-- render of the tab wrote an audit_log row claiming a full read nobody
-- performed. That trail exists to answer "who looked at an SSN"; filling it
-- with form renders destroys its only value.
--
-- Presence is not disclosure. "This pre-app has banking details on file" is
-- exactly what the rep is being asked to supply, so it does not need the
-- audited door -- but it does still need the ownership guard, which is why
-- this is a definer function with submit_pre_app's checks rather than a plain
-- grant on the tables. The tables themselves keep zero policies and zero
-- grants, as ever.

create or replace function pre_app_secrets_presence(pre_app_id_input int)
returns table (banking_on_file boolean, owners_missing_ssn int)
language plpgsql
security definer
set search_path = public
as $$
declare
  pa pre_apps;
begin
  select * into pa from pre_apps where id = pre_app_id_input;
  if not found then
    raise exception 'pre-app not found' using errcode = 'PT404';
  end if;

  -- Byte-for-byte the guard submit_pre_app uses, for the same reason: "not
  -- yours" and "doesn't exist" must be indistinguishable.
  if is_admin() then
    null;
  elsif pa.agent_id = auth.uid() then
    if not is_active_agent() then
      raise exception 'account is deactivated' using errcode = 'PT403';
    end if;
  else
    raise exception 'pre-app not found' using errcode = 'PT404';
  end if;

  -- Existence and counting only. No *_encrypted column is named anywhere in
  -- this body, so no ciphertext can leave even though the definer privilege
  -- could read one. tests/rls/pre-app-secrets-presence.test.ts pins that from
  -- pg_get_functiondef rather than trusting this comment.
  return query
    select
      exists (
        select 1 from pre_app_banking_secrets b where b.pre_app_id = pa.id
      ),
      (
        select count(*)::int
          from pre_app_owners o
         where o.pre_app_id = pa.id
           and not exists (
             select 1 from pre_app_owner_secrets s
              where s.pre_app_owner_id = o.id
           )
      );
end;
$$;

-- Postgres grants EXECUTE to PUBLIC on every new function and PUBLIC includes
-- anon, so without these two lines this RPC would be callable unauthenticated
-- from the moment it exists. There is no declarative backstop for functions.
revoke all on function pre_app_secrets_presence(int) from public;
grant execute on function pre_app_secrets_presence(int) to authenticated, service_role;
