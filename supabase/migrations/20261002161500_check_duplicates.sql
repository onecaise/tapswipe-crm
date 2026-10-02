-- check_duplicates() -- warn a rep that the lead they are about to create may
-- already exist, WITHOUT telling them anything about books they cannot see.
--
-- Matches docs/tapswipe_crm_schema.sql, updated first.
--
-- THIS IS THE MIRROR OF search_crm, AND THE CONTRAST IS THE WHOLE DESIGN.
-- search_crm is deliberately `security invoker` so a search box physically
-- cannot return a record the rest of the app hides. This function cannot be:
-- the duplicates that matter MOST are the ones RLS hides -- two reps working
-- the same merchant is the expensive mistake, and a rep can by definition not
-- see the other rep's row. So it must be `security definer` to look across
-- every book, and it pays for that reach two ways:
--
--   1. a hand-written guard (is_active_agent()), because RLS is no longer
--      doing any of the work; and
--   2. a deliberately narrow return shape. For a record the caller could NOT
--      already see, the function returns the fact that a match exists, which
--      field it matched on, and nothing else -- no id, no name, no contact
--      detail, no owning rep. Handing those back would be exactly the
--      disclosure search_crm's invoker choice exists to prevent, arriving
--      through a different door.
--
-- Same shape of argument as pre_app_secrets_presence: presence is not
-- disclosure, so it gets its own door. That function answers "does ciphertext
-- exist" without decrypting; this one answers "does a duplicate exist" without
-- identifying it.
--
-- IT ONLY EVER WARNS. Nothing here blocks a write, and no caller should make
-- it one. A hard block on a CROSS-BOOK duplicate is unrecoverable from the UI
-- by construction -- the rep cannot see the offending record, so they cannot
-- resolve, merge or dismiss it, and the only move left is to make the check
-- miss. The workaround reps find is typing the phone number wrong, which
-- destroys the single most reliable field the check depends on and poisons
-- every future comparison. A warning they can read and proceed past keeps the
-- data honest.
--
-- VISIBILITY RULE, and the one judgement call worth flagging: a row is shown in
-- full when the caller could already see it under RLS -- `agent_id = auth.uid()`
-- OR the caller is an admin -- and redacted otherwise. That applies uniformly to
-- all three tables including merchants. Redacting a rep's OWN merchant would
-- tell them "something exists, contact an admin" about a record sitting in their
-- own merchant list, which is both useless and a guaranteed support ticket, and
-- it would protect nothing: they can already select the row. The invariant held
-- here is "never disclose what RLS would hide", not "merchants are special".

-- ---------------------------------------------------------------------
-- 0. pg_trgm
--
-- In the `extensions` schema, which is Supabase convention rather than a
-- preference: the hosted projects already have that schema and put extensions
-- there, so installing into bare `public` would work locally and then collide
-- or be shadowed on deploy. Everything downstream carries
-- `set search_path = public, extensions` for the same reason -- a definer
-- function with a pinned search_path cannot find the operators otherwise, and
-- the failure is a bare "operator does not exist: text % text" at runtime.
--
-- `create schema if not exists` because the hermetic suite's PGlite has no
-- such schema; on a real project this is a no-op.
-- ---------------------------------------------------------------------
create schema if not exists extensions;
create extension if not exists pg_trgm with schema extensions;
grant usage on schema extensions to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 1. NORMALISATION HELPERS
--
-- These exist to be indexed. An expression index is only used when the query's
-- expression matches the index's EXACTLY, so writing
-- `regexp_replace(contact_phone, '\D', '', 'g')` by hand in both places is a
-- standing invitation to a silent sequential scan the day one copy gains a
-- space. A named immutable function makes the two impossible to desync.
--
-- IMMUTABLE is required for an expression index and is true here: every one
-- calls only pg_catalog functions on its argument. STRICT so null in is null
-- out, and each maps the empty string to NULL -- '' is a value that would
-- otherwise match every other blank field in the table, which is the single
-- most likely way a duplicate check turns into a false-positive generator.
--
-- NO `set search_path` on these three, deliberately, unlike every definer
-- function in this schema. They are not definer, they call only pg_catalog
-- (which is always implicitly first in the search path and cannot be shadowed
-- by a schema a caller controls), and a SET clause would block inlining --
-- which matters when the expression is evaluated per row during index
-- maintenance.
--
-- DO NOT `create or replace` any of these with different behaviour without
-- reindexing everything below. Postgres will happily accept the replacement
-- and leave the existing index entries computed by the OLD definition, which
-- silently stops matching rows that are in fact duplicates. That failure is
-- invisible -- a duplicate check that returns nothing looks exactly like no
-- duplicates.
-- ---------------------------------------------------------------------
create or replace function dup_digits(input text)
returns text language sql immutable strict parallel safe as $$
  select nullif(regexp_replace(input, '\D', '', 'g'), '')
$$;

create or replace function dup_email(input text)
returns text language sql immutable strict parallel safe as $$
  select nullif(lower(btrim(input)), '')
$$;

-- Host only. "https://www.acme.com/pricing?x=1" and "acme.com" are the same
-- business, and a rep typing either must not look like two different ones.
-- Scheme-agnostic (any scheme, not just http/https), strips a leading www.,
-- and cuts at the first '/' or '?' so a path or query never participates.
-- Port and userinfo are deliberately left in: both are vanishingly rare on a
-- merchant's marketing site, and stripping them is more parsing surface than
-- the case is worth.
create or replace function dup_host(input text)
returns text language sql immutable strict parallel safe as $$
  select nullif(
    regexp_replace(
      split_part(
        split_part(
          regexp_replace(lower(btrim(input)), '^[a-z][a-z0-9+.-]*://', ''),
          '/', 1),
        '?', 1),
      '^www\.', ''),
    '')
$$;

revoke all on function dup_digits(text) from public;
revoke all on function dup_email(text) from public;
revoke all on function dup_host(text) from public;
grant execute on function dup_digits(text) to authenticated, service_role;
grant execute on function dup_email(text) to authenticated, service_role;
grant execute on function dup_host(text) to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 2. INDEXES
--
-- Without these the function is a sequential scan of leads, ghost_sheets AND
-- merchants on every lead create -- three full tables on the one action a rep
-- performs most. Each index below is the expression the function actually
-- queries by, which is what makes it usable.
--
-- Btree for the exact tier, GIN/trgm for the fuzzy tier. The phone indexes are
-- three separate ones rather than a composite, because the predicate is three
-- independent `= any(...)` tests ORed together -- the planner serves that with
-- a BitmapOr over the three, and a composite would serve none of them.
-- ---------------------------------------------------------------------
create index if not exists idx_leads_dup_email
  on leads (dup_email(contact_email));
create index if not exists idx_leads_dup_contact_phone
  on leads (dup_digits(contact_phone));
create index if not exists idx_leads_dup_business_phone
  on leads (dup_digits(business_phone));
create index if not exists idx_leads_dup_mobile_phone
  on leads (dup_digits(mobile_phone));
create index if not exists idx_leads_dup_host
  on leads (dup_host(website));
create index if not exists idx_leads_dup_zip
  on leads (dup_digits(zip));
create index if not exists idx_leads_dba_trgm
  on leads using gin (dba extensions.gin_trgm_ops);
create index if not exists idx_leads_legal_name_trgm
  on leads using gin (merchant_legal_name extensions.gin_trgm_ops);
create index if not exists idx_leads_address_trgm
  on leads using gin (address extensions.gin_trgm_ops);

create index if not exists idx_ghost_sheets_dup_contact_phone
  on ghost_sheets (dup_digits(contact_phone));
create index if not exists idx_ghost_sheets_dba_trgm
  on ghost_sheets using gin (dba extensions.gin_trgm_ops);

create index if not exists idx_merchants_dba_trgm
  on merchants using gin (dba extensions.gin_trgm_ops);
create index if not exists idx_merchants_legal_name_trgm
  on merchants using gin (legal_business_name extensions.gin_trgm_ops);

-- ---------------------------------------------------------------------
-- 3. check_duplicates
--
-- WHAT EACH TABLE CONTRIBUTES, which is decided by what columns it actually
-- has rather than by symmetry:
--
--   leads         email, phones, website (exact); name, address (fuzzy)
--   ghost_sheets  phone (exact); name (fuzzy) -- it has one phone column and
--                 no email, website or address
--   merchants     name (fuzzy) -- it has NO contact columns at all, so dba and
--                 legal_business_name are the entire match surface. That is
--                 also why a merchant duplicate can never reach `exact`
--                 strength, and the UI must not imply it did.
--
-- PHONES ARE COMPARED IN BOTH DIRECTIONS, nine combinations and not three: a
-- rep types a mobile into "contact phone" as often as not, so the input's
-- three values are each tested against the row's three columns. Digits only,
-- so (615) 555-1234 and 6155551234 are one number. A minimum of 7 digits is
-- enforced on the INPUT side -- without it a half-typed "555" matches a
-- substantial fraction of the book and the warning becomes noise the rep
-- learns to click through, which is the failure mode that makes the whole
-- feature worthless.
--
-- ONE SELECT PER MATCH REASON, union'd. The obvious tidier shape -- a LATERAL
-- over a VALUES list of conditions -- was written first and thrown away: it
-- evaluates per outer row, so the planner cannot use ANY of the indexes above
-- and the whole thing degrades to the three sequential scans this migration
-- exists to avoid. Verbose and index-driven beats elegant and quadratic.
--
-- The `%` operator is what the GIN indexes serve; `similarity() >=` is the
-- rule actually being claimed. Both are present on purpose. `%` compares
-- against the `pg_trgm.similarity_threshold` GUC, which is set transaction-
-- locally below so the operator can never be NARROWER than the threshold the
-- caller asked for -- at the default 0.3 a caller passing 0.25 would otherwise
-- silently lose matches between the two.
--
-- 0.4 as the default, and expected to be tuned once there is real usage. It is
-- high enough that unrelated businesses do not collide and low enough that
-- "Joe's Pizza LLC" vs "Joes Pizza" (0.5) warns. Nothing blocks at any
-- threshold, so the cost of it being slightly wrong is a warning a rep reads
-- and dismisses -- which is why tuning can wait for evidence.
-- ---------------------------------------------------------------------
create or replace function check_duplicates(
  contact_email_input  text default null,
  contact_phone_input  text default null,
  business_phone_input text default null,
  mobile_phone_input   text default null,
  website_input        text default null,
  dba_input            text default null,
  legal_name_input     text default null,
  address_input        text default null,
  city_input           text default null,
  state_input          text default null,
  zip_input            text default null,
  exclude_lead_id      int  default null,
  name_threshold       real default 0.4
)
returns table (
  visibility    text,
  record_type   text,
  record_id     int,
  title         text,
  subtitle      text,
  matched_field text,
  strength      text
)
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  caller          uuid := auth.uid();
  caller_is_admin boolean;
  email_key text := dup_email(contact_email_input);
  host_key  text := dup_host(website_input);
  dba_key   text := nullif(btrim(coalesce(dba_input, '')), '');
  legal_key text := nullif(btrim(coalesce(legal_name_input, '')), '');
  addr_key  text := nullif(btrim(coalesce(address_input, '')), '');
  zip_key   text := dup_digits(zip_input);
  city_key  text := nullif(lower(btrim(coalesce(city_input, ''))), '');
  state_key text := nullif(lower(btrim(coalesce(state_input, ''))), '');
  phone_keys text[];
begin
  -- The hand-written guard that pays for `security definer`. RLS is doing none
  -- of the work below, so this is the only thing standing between a caller and
  -- a cross-book read. is_active_agent() tests `is_active` rather than role, so
  -- it covers admins too and refuses a deactivated account whose JWT is still
  -- within its hour.
  if not is_active_agent() then
    raise exception 'not authorised' using errcode = 'PT403';
  end if;

  caller_is_admin := is_admin();

  -- Seven digits, not one. See the note above: a short fragment matches a large
  -- slice of the book and teaches reps to dismiss the warning unread.
  phone_keys := array(
    select d from unnest(array[
      dup_digits(contact_phone_input),
      dup_digits(business_phone_input),
      dup_digits(mobile_phone_input)
    ]) as d
    where d is not null and length(d) >= 7
  );
  if cardinality(phone_keys) = 0 then
    phone_keys := null;
  end if;

  if name_threshold is null or name_threshold <= 0 or name_threshold > 1 then
    name_threshold := 0.4;
  end if;
  -- Transaction-local, so it cannot leak into anything else the caller does.
  perform set_config('pg_trgm.similarity_threshold', name_threshold::text, true);

  return query
  with hits as (
    -- ---- leads: exact tier ----
    select 'lead'::text as record_type, l.id as record_id, l.agent_id,
           coalesce(l.dba, l.contact_name, 'Lead #' || l.id) as title,
           l.contact_name as subtitle,
           'contact_email'::text as matched_field, 'exact'::text as strength
      from leads l
     where email_key is not null
       and (exclude_lead_id is null or l.id <> exclude_lead_id)
       and dup_email(l.contact_email) = email_key

    union all
    select 'lead', l.id, l.agent_id,
           coalesce(l.dba, l.contact_name, 'Lead #' || l.id), l.contact_name,
           'phone', 'exact'
      from leads l
     where phone_keys is not null
       and (exclude_lead_id is null or l.id <> exclude_lead_id)
       and (dup_digits(l.contact_phone)  = any(phone_keys)
         or dup_digits(l.business_phone) = any(phone_keys)
         or dup_digits(l.mobile_phone)   = any(phone_keys))

    union all
    select 'lead', l.id, l.agent_id,
           coalesce(l.dba, l.contact_name, 'Lead #' || l.id), l.contact_name,
           'website', 'exact'
      from leads l
     where host_key is not null
       and (exclude_lead_id is null or l.id <> exclude_lead_id)
       and dup_host(l.website) = host_key

    -- ---- leads: fuzzy tier ----
    union all
    select 'lead', l.id, l.agent_id,
           coalesce(l.dba, l.contact_name, 'Lead #' || l.id), l.contact_name,
           'name', 'fuzzy'
      from leads l
     where (dba_key is not null or legal_key is not null)
       and (exclude_lead_id is null or l.id <> exclude_lead_id)
       and ((dba_key   is not null and (l.dba % dba_key   or l.merchant_legal_name % dba_key))
         or (legal_key is not null and (l.dba % legal_key or l.merchant_legal_name % legal_key)))
       and greatest(
             coalesce(similarity(l.dba, dba_key), 0),
             coalesce(similarity(l.merchant_legal_name, dba_key), 0),
             coalesce(similarity(l.dba, legal_key), 0),
             coalesce(similarity(l.merchant_legal_name, legal_key), 0)
           ) >= name_threshold

    union all
    -- An address alone means nothing -- "100 Main St" exists in every town in
    -- the country. Scoped by zip, falling back to city+state when no zip was
    -- given, so this can only fire on somewhere actually nearby.
    select 'lead', l.id, l.agent_id,
           coalesce(l.dba, l.contact_name, 'Lead #' || l.id), l.contact_name,
           'address', 'fuzzy'
      from leads l
     where addr_key is not null
       and (exclude_lead_id is null or l.id <> exclude_lead_id)
       and (
             (zip_key is not null and dup_digits(l.zip) = zip_key)
          or (zip_key is null and city_key is not null and state_key is not null
              and lower(btrim(l.city)) = city_key
              and lower(btrim(l.state)) = state_key)
           )
       and l.address % addr_key
       and similarity(l.address, addr_key) >= name_threshold

    -- ---- ghost sheets ----
    union all
    select 'ghost_sheet', g.id, g.agent_id,
           coalesce(g.dba, g.contact_name, 'Ghost sheet #' || g.id), g.contact_name,
           'phone', 'exact'
      from ghost_sheets g
     where phone_keys is not null
       and dup_digits(g.contact_phone) = any(phone_keys)

    union all
    select 'ghost_sheet', g.id, g.agent_id,
           coalesce(g.dba, g.contact_name, 'Ghost sheet #' || g.id), g.contact_name,
           'name', 'fuzzy'
      from ghost_sheets g
     where (dba_key is not null or legal_key is not null)
       and ((dba_key is not null and g.dba % dba_key)
         or (legal_key is not null and g.dba % legal_key))
       and greatest(
             coalesce(similarity(g.dba, dba_key), 0),
             coalesce(similarity(g.dba, legal_key), 0)
           ) >= name_threshold

    -- ---- merchants ----
    -- The costliest miss: a rep starting to work an account the company
    -- already has. No contact columns exist here, so name is the whole
    -- surface and nothing from merchants is ever `exact`.
    union all
    select 'merchant', m.id, m.agent_id,
           coalesce(m.dba, m.legal_business_name, 'Merchant #' || m.id),
           m.legal_business_name,
           'name', 'fuzzy'
      from merchants m
     where (dba_key is not null or legal_key is not null)
       and ((dba_key   is not null and (m.dba % dba_key   or m.legal_business_name % dba_key))
         or (legal_key is not null and (m.dba % legal_key or m.legal_business_name % legal_key)))
       and greatest(
             coalesce(similarity(m.dba, dba_key), 0),
             coalesce(similarity(m.legal_business_name, dba_key), 0),
             coalesce(similarity(m.dba, legal_key), 0),
             coalesce(similarity(m.legal_business_name, legal_key), 0)
           ) >= name_threshold
  ),
  classified as (
    select case when caller_is_admin or h.agent_id = caller then 'own' else 'redacted' end as vis,
           h.record_type, h.record_id, h.title, h.subtitle, h.matched_field, h.strength
      from hits h
  )
  -- Own rows: one per record, naming its strongest reason. `distinct on`
  -- rather than one row per matched field, so a lead that matches on both
  -- phone and name appears once in the list the rep is shown.
  select c.vis, c.record_type, c.record_id, c.title, c.subtitle,
         c.matched_field, c.strength
    from (
      select distinct on (c2.record_type, c2.record_id) c2.*
        from classified c2
       where c2.vis = 'own'
       order by c2.record_type, c2.record_id,
                case c2.strength when 'exact' then 0 else 1 end,
                c2.matched_field
    ) c

  union all

  -- Redacted rows: AGGREGATED, and that is a disclosure control rather than
  -- tidiness. One row per record would make the row COUNT a report on how many
  -- records exist in books the caller cannot see -- a weaker leak than a name,
  -- but the same kind, and free to avoid. Grouping to
  -- (record_type, matched_field, strength) answers "a match exists, on this
  -- field" and nothing further. record_id, title and subtitle are NULL here by
  -- construction, not by the caller's good manners.
  select 'redacted', c.record_type, null::int, null::text, null::text,
         c.matched_field, c.strength
    from classified c
   where c.vis = 'redacted'
   group by c.record_type, c.matched_field, c.strength

  order by 7, 2, 6;  -- exact before fuzzy, then record type, then field
end;
$$;

-- Postgres grants EXECUTE to PUBLIC on every new function and PUBLIC includes
-- anon, and this one is `security definer` over every rep's book -- an anon
-- EXECUTE would be a cross-book read with nothing but the publishable key.
revoke all on function check_duplicates(
  text, text, text, text, text, text, text, text, text, text, text, int, real
) from public;
grant execute on function check_duplicates(
  text, text, text, text, text, text, text, text, text, text, text, int, real
) to authenticated, service_role;

-- No policy change and no grant change on leads, ghost_sheets or merchants.
-- This function reaches across them as the owner, which is the point; nothing
-- about a caller's direct access to those tables moves, and `authenticated`
-- holds exactly what it held before.
