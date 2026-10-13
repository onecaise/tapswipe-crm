-- accounts_in_city(city, state) -- "do we already have accounts in this city?"
--
-- Matches docs/tapswipe_crm_schema.sql, updated first; the full reasoning is
-- there, next to check_duplicates(), whose design this copies:
--
--   * security definer, because the answer that matters is in other reps'
--     books; paid for with a hand-written is_active_agent() guard and a narrow
--     return shape. A non-admin gets dba, legal_business_name, city and state
--     per account -- as jsonb objects carrying exactly those four keys -- and
--     nothing else. An admin also gets merchant_id, agent_id, agent_name,
--     status, street and zip.
--   * equality on norm_city() (20261013130000) only. No LIKE, no fuzzy, no
--     prefix; %, _ and * are punctuation to norm_city.
--   * city required, <= 60 characters trimmed, >= 2 once normalised; state an
--     optional two-letter filter. Bad input is 22023 with a showable message;
--     no accounts is an empty result, never an error.
--   * 'inactive' merchants are excluded (the closed state -- there is no
--     'closed' or 'cancelled' status); 'active' and 'other' are returned.
--   * at most 100 results plus has_more.
--   * not audited: neither check_duplicates() nor pre_app_secrets_presence()
--     logs its calls, so there is no mechanism here to follow.

create or replace function accounts_in_city(city text, state text default null)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  raw_city  text := btrim(coalesce(accounts_in_city.city, ''));
  state_key text := nullif(upper(btrim(coalesce(accounts_in_city.state, ''))), '');
  city_key  text;
  caller_is_admin boolean;
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
