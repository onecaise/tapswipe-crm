-- accounts_in_city(): audit every call, rate-limit reps (security review phase 5)
--
-- Matches docs/tapswipe_crm_schema.sql, updated first; the reasoning is there.
--
--   * Every call that returns an answer writes one audit_log row:
--     action 'accounts_in_city:1' (1 = cities queried; the function takes one),
--     table_name 'merchants', actor_id the caller. Not the city, not the results.
--     Admins too. No exception handler: no audit row, no answer.
--   * A non-admin gets 30 calls per rolling hour, counted from those rows under
--     a per-caller advisory lock; the 31st raises PT429 with a showable message.
--     Admins are exempt from the limit.
--   * One city per call by signature, inside the 5-per-call cap.
--   * volatile now (it writes); search_path gains pg_temp.
--
-- Same signature, so create or replace keeps the existing grants; they are
-- restated anyway, as every function migration here does.

create or replace function accounts_in_city(city text, state text default null)
returns jsonb
language plpgsql
volatile
security definer
set search_path = public, pg_temp
as $$
declare
  raw_city  text := btrim(coalesce(accounts_in_city.city, ''));
  state_key text := nullif(upper(btrim(coalesce(accounts_in_city.state, ''))), '');
  city_key  text;
  caller_is_admin boolean;
  recent_calls int;
  oldest_call timestamptz;
  wait_minutes int;
  result_rows jsonb;
  more boolean;
begin
  if not is_active_agent() then
    raise exception 'not authorised' using errcode = 'PT403';
  end if;

  if raw_city = '' then
    raise exception 'Enter a city.' using errcode = '22023';
  end if;
  if char_length(raw_city) > 60 then
    raise exception 'A city name is at most 60 characters.' using errcode = '22023';
  end if;
  city_key := norm_city(raw_city);
  if city_key is null or char_length(city_key) < 2 then
    raise exception 'Enter at least 2 letters of the city name.' using errcode = '22023';
  end if;
  if state_key is not null and state_key !~ '^[A-Z]{2}$' then
    raise exception 'State must be a two-letter code.' using errcode = '22023';
  end if;

  caller_is_admin := is_admin();

  if not caller_is_admin then
    perform pg_advisory_xact_lock(hashtextextended('accounts_in_city:' || auth.uid()::text, 0));
    select count(*), min(a.created_at)
      into recent_calls, oldest_call
      from audit_log a
     where a.actor_id = auth.uid()
       and a.action like 'accounts_in_city:%'
       and a.created_at > now() - interval '1 hour';
    if recent_calls >= 30 then
      wait_minutes := greatest(1, ceil(extract(epoch from
                        (oldest_call + interval '1 hour' - now())) / 60)::int);
      raise exception 'You have reached the limit of 30 city searches an hour. Try again in % minute%.',
        wait_minutes, case when wait_minutes = 1 then '' else 's' end
        using errcode = 'PT429';
    end if;
  end if;

  insert into audit_log (actor_id, action, table_name, row_id)
  values (auth.uid(), 'accounts_in_city:1', 'merchants', null);

  select coalesce(jsonb_agg(r.row_json order by r.rn) filter (where r.rn <= 100),
                  '[]'::jsonb),
         count(*) > 100
    into result_rows, more
    from (
      select row_number() over (order by m.state, lower(m.dba), m.id) as rn,
             case when caller_is_admin then
               jsonb_build_object(
                 'merchant_id', m.id,
                 'dba', m.dba,
                 'legal_business_name', m.legal_business_name,
                 'city', m.city,
                 'state', m.state,
                 'street', m.street,
                 'zip', m.zip,
                 'status', m.status,
                 'agent_id', m.agent_id,
                 'agent_name', p.full_name)
             else
               jsonb_build_object(
                 'dba', m.dba,
                 'legal_business_name', m.legal_business_name,
                 'city', m.city,
                 'state', m.state)
             end as row_json
        from merchants m
        left join profiles p on p.id = m.agent_id
       where norm_city(m.city) = city_key
         and (state_key is null or m.state = state_key)
         and m.status <> 'inactive'
       order by rn
       limit 101
    ) r;

  return jsonb_build_object('results', result_rows, 'has_more', more);
end;
$$;

revoke all on function accounts_in_city(text, text) from public;
grant execute on function accounts_in_city(text, text) to authenticated, service_role;

-- The rate limit's count: one rep's city-search rows in the last hour.
create index audit_log_city_search_idx on audit_log (actor_id, created_at)
  where action like 'accounts_in_city:%';
