-- record_pre_app_secret_reveal(): the audit row and rate limit behind an
-- admin's per-field "Show" (phase 5 of docs/design/intake-and-reports.md, §1.E
-- and A24; closes the "admins see full SSNs as soon as the step opens"
-- follow-up).
--
-- Matches docs/tapswipe_crm_schema.sql, updated first; the reasoning is there.
--
--   * read-pre-app-secrets now answers EVERY default read with last four
--     (presence only for the RP password), admin included. A full value is
--     returned only for one field at a time, on a request that names it, and
--     only after this function has returned.
--   * Admin only: is_admin() first. A rep, a deactivated admin and anon are
--     refused before anything is counted or written.
--   * One audit_log row per reveal, naming the admin (actor_id), the pre-app
--     (row_id), the field (in the action) and the time (created_at):
--       read_pre_app_secrets:reveal:<field>
--       read_pre_app_secrets:reveal:owner_ssn:<pre_app_owner_id>
--     No exception handler: no audit row, no value (the function raises and
--     the Edge Function returns 500 with nothing in the body).
--   * 30 reveals per admin per rolling hour, counted from those rows under a
--     per-caller advisory lock, as accounts_in_city() counts a rep's searches
--     (20261023120000); the 31st raises PT429 with a showable message.
--   * It reads no *_secrets table and decrypts nothing: the key exists only in
--     the Edge Function. Called directly by an admin, all it can do is write
--     an audit row against themselves.

create function record_pre_app_secret_reveal(
  pre_app_id_input int,
  field_input text,
  pre_app_owner_id_input int default null
)
returns void
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  recent_reveals int;
  oldest_reveal timestamptz;
  wait_minutes int;
begin
  if not is_admin() then
    raise exception 'Only an admin can reveal a full value.' using errcode = 'PT403';
  end if;

  if field_input is null
     or field_input not in ('owner_ssn', 'aba_routing', 'account_number', 'rp_password', 'tax_id') then
    raise exception 'Unknown secret field.' using errcode = '22023';
  end if;
  if (field_input = 'owner_ssn') <> (pre_app_owner_id_input is not null) then
    raise exception 'An owner is named for an owner SSN, and only for one.' using errcode = '22023';
  end if;

  if not exists (select 1 from pre_apps where id = pre_app_id_input) then
    raise exception 'pre-app not found' using errcode = 'PT404';
  end if;
  if pre_app_owner_id_input is not null and not exists (
    select 1 from pre_app_owners
     where id = pre_app_owner_id_input and pre_app_id = pre_app_id_input
  ) then
    raise exception 'pre-app not found' using errcode = 'PT404';
  end if;

  perform pg_advisory_xact_lock(hashtextextended('reveal_pre_app_secret:' || auth.uid()::text, 0));
  select count(*), min(a.created_at)
    into recent_reveals, oldest_reveal
    from audit_log a
   where a.actor_id = auth.uid()
     and a.action like 'read_pre_app_secrets:reveal:%'
     and a.created_at > now() - interval '1 hour';
  if recent_reveals >= 30 then
    wait_minutes := greatest(1, ceil(extract(epoch from
                      (oldest_reveal + interval '1 hour' - now())) / 60)::int);
    raise exception 'You have reached the limit of 30 reveals an hour. Try again in % minute%.',
      wait_minutes, case when wait_minutes = 1 then '' else 's' end
      using errcode = 'PT429';
  end if;

  insert into audit_log (actor_id, action, table_name, row_id)
  values (
    auth.uid(),
    'read_pre_app_secrets:reveal:' || field_input
      || coalesce(':' || pre_app_owner_id_input::text, ''),
    'pre_apps',
    pre_app_id_input::text
  );
end;
$$;

revoke all on function record_pre_app_secret_reveal(int, text, int) from public;
grant execute on function record_pre_app_secret_reveal(int, text, int) to authenticated, service_role;

-- The rate limit's count: one admin's reveal rows in the last hour.
create index audit_log_secret_reveal_idx on audit_log (actor_id, created_at)
  where action like 'read_pre_app_secrets:reveal:%';
