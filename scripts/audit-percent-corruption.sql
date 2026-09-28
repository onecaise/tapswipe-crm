-- READ-ONLY. Percentage columns reachable through maskPercent + MaskedInput,
-- audited for the pre-fix caret bug's signature. See
-- scripts/audit-percent-corruption.ps1 for what the columns are and why these
-- three counters mean what they mean.
--
-- over_100     => definite corruption (no legitimate path writes >100 here)
-- has_decimals => genuine decimals, which the buggy wizard could not produce
-- whole_1_100  => exposure band; indistinguishable from a real whole number
\pset border 2
select 'AUDIT TARGET: ' || current_database() || ' @ ' || coalesce(host(inet_server_addr()),'SOCKET-LOCAL') as context;

select 'pre_apps.split_agent_pct' as "column",
       count(split_agent_pct) as non_null,
       count(*) filter (where split_agent_pct > 100) as over_100,
       count(*) filter (where split_agent_pct is not null and split_agent_pct <> trunc(split_agent_pct)) as has_decimals,
       count(*) filter (where split_agent_pct is not null and split_agent_pct = trunc(split_agent_pct) and split_agent_pct > 0 and split_agent_pct <= 100) as whole_1_100,
       coalesce(max(split_agent_pct)::text,'-') as max_val
from pre_apps
union all
select 'pre_apps.split_company_pct' as "column",
       count(split_company_pct) as non_null,
       count(*) filter (where split_company_pct > 100) as over_100,
       count(*) filter (where split_company_pct is not null and split_company_pct <> trunc(split_company_pct)) as has_decimals,
       count(*) filter (where split_company_pct is not null and split_company_pct = trunc(split_company_pct) and split_company_pct > 0 and split_company_pct <= 100) as whole_1_100,
       coalesce(max(split_company_pct)::text,'-') as max_val
from pre_apps
union all
select 'pre_app_owners.percent_owned' as "column",
       count(percent_owned) as non_null,
       count(*) filter (where percent_owned > 100) as over_100,
       count(*) filter (where percent_owned is not null and percent_owned <> trunc(percent_owned)) as has_decimals,
       count(*) filter (where percent_owned is not null and percent_owned = trunc(percent_owned) and percent_owned > 0 and percent_owned <= 100) as whole_1_100,
       coalesce(max(percent_owned)::text,'-') as max_val
from pre_app_owners
union all
select 'pre_app_terminal.tax_rate' as "column",
       count(tax_rate) as non_null,
       count(*) filter (where tax_rate > 100) as over_100,
       count(*) filter (where tax_rate is not null and tax_rate <> trunc(tax_rate)) as has_decimals,
       count(*) filter (where tax_rate is not null and tax_rate = trunc(tax_rate) and tax_rate > 0 and tax_rate <= 100) as whole_1_100,
       coalesce(max(tax_rate)::text,'-') as max_val
from pre_app_terminal
union all
select 'pre_app_business_profile.card_swiped_pct' as "column",
       count(card_swiped_pct) as non_null,
       count(*) filter (where card_swiped_pct > 100) as over_100,
       count(*) filter (where card_swiped_pct is not null and card_swiped_pct <> trunc(card_swiped_pct)) as has_decimals,
       count(*) filter (where card_swiped_pct is not null and card_swiped_pct = trunc(card_swiped_pct) and card_swiped_pct > 0 and card_swiped_pct <= 100) as whole_1_100,
       coalesce(max(card_swiped_pct)::text,'-') as max_val
from pre_app_business_profile
union all
select 'pre_app_business_profile.card_keyed_pct' as "column",
       count(card_keyed_pct) as non_null,
       count(*) filter (where card_keyed_pct > 100) as over_100,
       count(*) filter (where card_keyed_pct is not null and card_keyed_pct <> trunc(card_keyed_pct)) as has_decimals,
       count(*) filter (where card_keyed_pct is not null and card_keyed_pct = trunc(card_keyed_pct) and card_keyed_pct > 0 and card_keyed_pct <= 100) as whole_1_100,
       coalesce(max(card_keyed_pct)::text,'-') as max_val
from pre_app_business_profile
union all
select 'pre_app_business_profile.card_present_pct' as "column",
       count(card_present_pct) as non_null,
       count(*) filter (where card_present_pct > 100) as over_100,
       count(*) filter (where card_present_pct is not null and card_present_pct <> trunc(card_present_pct)) as has_decimals,
       count(*) filter (where card_present_pct is not null and card_present_pct = trunc(card_present_pct) and card_present_pct > 0 and card_present_pct <= 100) as whole_1_100,
       coalesce(max(card_present_pct)::text,'-') as max_val
from pre_app_business_profile
union all
select 'pre_app_business_profile.card_not_present_pct' as "column",
       count(card_not_present_pct) as non_null,
       count(*) filter (where card_not_present_pct > 100) as over_100,
       count(*) filter (where card_not_present_pct is not null and card_not_present_pct <> trunc(card_not_present_pct)) as has_decimals,
       count(*) filter (where card_not_present_pct is not null and card_not_present_pct = trunc(card_not_present_pct) and card_not_present_pct > 0 and card_not_present_pct <= 100) as whole_1_100,
       coalesce(max(card_not_present_pct)::text,'-') as max_val
from pre_app_business_profile
union all
select 'pre_app_business_profile.moto_pct' as "column",
       count(moto_pct) as non_null,
       count(*) filter (where moto_pct > 100) as over_100,
       count(*) filter (where moto_pct is not null and moto_pct <> trunc(moto_pct)) as has_decimals,
       count(*) filter (where moto_pct is not null and moto_pct = trunc(moto_pct) and moto_pct > 0 and moto_pct <= 100) as whole_1_100,
       coalesce(max(moto_pct)::text,'-') as max_val
from pre_app_business_profile
union all
select 'pre_app_business_profile.internet_pct' as "column",
       count(internet_pct) as non_null,
       count(*) filter (where internet_pct > 100) as over_100,
       count(*) filter (where internet_pct is not null and internet_pct <> trunc(internet_pct)) as has_decimals,
       count(*) filter (where internet_pct is not null and internet_pct = trunc(internet_pct) and internet_pct > 0 and internet_pct <= 100) as whole_1_100,
       coalesce(max(internet_pct)::text,'-') as max_val
from pre_app_business_profile
order by 1;

-- Detail for anything definitely corrupted, so a finding names the row.
select 'pre_app_owners' as tbl, id::text as row_id, pre_app_id::text as parent,
       'percent_owned' as col, percent_owned::text as value
  from pre_app_owners where percent_owned > 100
union all
select 'pre_app_terminal', id::text, pre_app_id::text, 'tax_rate', tax_rate::text
  from pre_app_terminal where tax_rate > 100
union all
select 'pre_app_business_profile', id::text, pre_app_id::text, 'card_swiped_pct', card_swiped_pct::text
  from pre_app_business_profile where card_swiped_pct > 100
union all
select 'pre_app_business_profile', id::text, pre_app_id::text, 'card_keyed_pct', card_keyed_pct::text
  from pre_app_business_profile where card_keyed_pct > 100
union all
select 'pre_app_business_profile', id::text, pre_app_id::text, 'card_present_pct', card_present_pct::text
  from pre_app_business_profile where card_present_pct > 100
union all
select 'pre_app_business_profile', id::text, pre_app_id::text, 'card_not_present_pct', card_not_present_pct::text
  from pre_app_business_profile where card_not_present_pct > 100
union all
select 'pre_app_business_profile', id::text, pre_app_id::text, 'moto_pct', moto_pct::text
  from pre_app_business_profile where moto_pct > 100
union all
select 'pre_app_business_profile', id::text, pre_app_id::text, 'internet_pct', internet_pct::text
  from pre_app_business_profile where internet_pct > 100
union all
select 'pre_apps', id::text, id::text, 'split_agent_pct', split_agent_pct::text
  from pre_apps where split_agent_pct > 100
order by 1, 4, 2;
