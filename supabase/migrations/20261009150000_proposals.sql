-- =====================================================================
-- Proposals become their own record: owned by a rep, optionally linked
-- to ONE lead or ONE merchant, and always naming who they are for.
--
-- Spec: docs/tapswipe_crm_schema.sql (quotes), updated first. Nothing is
-- renamed in the database -- "Proposals" is UI wording only.
--
-- Four changes, in an order that matters in two places:
--   1. customer_name: added, backfilled, THEN made NOT NULL.
--   2. quotes_exactly_one_owner (= 1) -> quotes_at_most_one_link (<= 1).
--   3. The insert policy: rep for themselves, admin for anyone; each link
--      must be a record the caller can see; no link is allowed.
--   4. enforce_quote_version() snapshots customer_name; create_quote_version()
--      takes it, with the old 8-argument signature DROPPED first.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. customer_name
--
-- Every existing row has a lead or a merchant (quotes_exactly_one_owner
-- still holds at this point), so every row has a name to copy -- the same
-- derivation enforce_quote_version() uses below, so a backfilled row and
-- a new row agree on what a record is called.
--
-- The cross-agent audit trigger is DISABLED around the backfill. It is an
-- AFTER UPDATE trigger, and a migration has no auth.uid(), so it would
-- write a cross_agent_update row for every quote in the table -- an audit
-- trail of an event that is not anybody's action. Re-enabled immediately.
-- ---------------------------------------------------------------------
alter table quotes add column if not exists customer_name text;

alter table quotes disable trigger quotes_audit_cross_agent;

update quotes q
   set customer_name = coalesce(nullif(btrim(l.dba), ''),
                                nullif(btrim(l.merchant_legal_name), ''),
                                'Lead #' || l.id)
  from leads l
 where l.id = q.lead_id
   and q.customer_name is null;

update quotes q
   set customer_name = coalesce(nullif(btrim(m.dba), ''),
                                nullif(btrim(m.legal_business_name), ''),
                                'Merchant #' || m.id)
  from merchants m
 where m.id = q.merchant_id
   and q.customer_name is null;

alter table quotes enable trigger quotes_audit_cross_agent;

alter table quotes alter column customer_name set not null;
alter table quotes
  add constraint quotes_customer_name_not_blank
  check (btrim(customer_name) <> '');

-- ---------------------------------------------------------------------
-- 2. At most one link. Ordinary, not NOT VALID: `<= 1` admits every row
-- `= 1` did, so the existing rows are clean by construction.
-- ---------------------------------------------------------------------
alter table quotes drop constraint if exists quotes_exactly_one_owner;
alter table quotes
  add constraint quotes_at_most_one_link
  check (num_nonnulls(lead_id, merchant_id) <= 1);

-- ---------------------------------------------------------------------
-- 3. The insert policy.
--
-- agent_id now means "the rep this proposal is for", not "the owner of
-- the parent record" -- the same values for every existing row, a
-- different rule for new ones. The `exists` clauses lean on the leads and
-- merchants select policies on purpose: the rule is "a record the caller
-- can see", and a policy subquery runs under the caller's RLS. See the
-- doc for the itemised difference from the old policy.
-- ---------------------------------------------------------------------
drop policy if exists "insert own via own lead or merchant" on quotes;
drop policy if exists "insert own, linked only to what the caller can see" on quotes;
create policy "insert own, linked only to what the caller can see" on quotes
  for insert with check (
    (
      (agent_id = auth.uid() and is_active_agent())
      or is_admin()
    )
    and (
      lead_id is null
      or exists (select 1 from leads where leads.id = quotes.lead_id)
    )
    and (
      merchant_id is null
      or exists (select 1 from merchants where merchants.id = quotes.merchant_id)
    )
  );

-- ---------------------------------------------------------------------
-- 4a. enforce_quote_version() also snapshots customer_name.
-- ---------------------------------------------------------------------
create or replace function enforce_quote_version()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  group_agent_id    uuid;
  group_lead_id     int;
  group_merchant_id int;
  max_version       int;
  linked_name       text;
begin
  select q.agent_id, min(q.lead_id), min(q.merchant_id), max(q.version)
    into group_agent_id, group_lead_id, group_merchant_id, max_version
    from quotes q
   where q.quote_group_id = NEW.quote_group_id
   group by q.agent_id;

  if group_agent_id is not null and group_agent_id <> NEW.agent_id then
    -- Not naming the owner: an error message is as good an id oracle as a
    -- status code.
    raise exception 'quote group belongs to another agent';
  end if;

  -- A group cannot change what it is linked to -- including from unlinked
  -- to linked or back. `is distinct from` so NULL compares as a value.
  if group_agent_id is not null
     and (group_lead_id     is distinct from NEW.lead_id
       or group_merchant_id is distinct from NEW.merchant_id) then
    raise exception 'quote group belongs to a different lead or merchant';
  end if;

  -- The name snapshot. Linked: the record's, over whatever was sent.
  -- Definer reads the record even if the caller cannot -- harmless, since
  -- the insert policy's WITH CHECK runs after this trigger and refuses the
  -- row, so the computed name is never written or returned.
  if NEW.lead_id is not null then
    select coalesce(nullif(btrim(l.dba), ''),
                    nullif(btrim(l.merchant_legal_name), ''),
                    'Lead #' || l.id)
      into linked_name
      from leads l where l.id = NEW.lead_id;
  elsif NEW.merchant_id is not null then
    select coalesce(nullif(btrim(m.dba), ''),
                    nullif(btrim(m.legal_business_name), ''),
                    'Merchant #' || m.id)
      into linked_name
      from merchants m where m.id = NEW.merchant_id;
  end if;
  -- A link to a record that does not exist finds no name and keeps the
  -- typed one; the foreign key then refuses the row.
  NEW.customer_name := coalesce(linked_name, btrim(NEW.customer_name));

  NEW.version := coalesce(max_version, 0) + 1;
  return NEW;
end;
$$;

revoke all on function enforce_quote_version() from public;
revoke all on function enforce_quote_version() from anon, authenticated;

-- ---------------------------------------------------------------------
-- 4b. create_quote_version() takes the customer name.
--
-- THE 8-ARGUMENT SIGNATURE IS DROPPED FIRST. `create or replace` with a
-- different parameter list makes a second function, and the ambiguity
-- surfaces at call time from the browser. The dashboard_counts() lesson.
-- ---------------------------------------------------------------------
drop function if exists create_quote_version(int, int, uuid, uuid, text, text, text, jsonb);

create or replace function create_quote_version(
  lead_id_input int,
  merchant_id_input int,
  customer_name_input text,
  agent_id_input uuid,
  quote_group_id_input uuid,
  status_input text,
  title_input text,
  notes_input text,
  line_items_input jsonb
)
returns int
language plpgsql
set search_path = public
as $$
declare
  new_quote_id int;
begin
  if lead_id_input is not null and merchant_id_input is not null then
    raise exception 'a proposal is linked to at most one of a lead or a merchant';
  end if;

  if lead_id_input is null and merchant_id_input is null
     and btrim(coalesce(customer_name_input, '')) = '' then
    raise exception 'a proposal that is not linked to a lead or merchant needs a customer name';
  end if;

  if line_items_input is null
     or jsonb_typeof(line_items_input) <> 'array'
     or jsonb_array_length(line_items_input) = 0 then
    raise exception 'a quote needs at least one line item';
  end if;

  if exists (
    select 1 from jsonb_array_elements(line_items_input) as elem
     where not exists (
       select 1 from products p
        where p.id = (elem.value ->> 'product_id')::int
          and p.archived_at is null
     )
  ) then
    raise exception 'every line item must name a product that is in the catalog';
  end if;

  if exists (
    select 1 from jsonb_array_elements(line_items_input) as elem
      join products p on p.id = (elem.value ->> 'product_id')::int
     where p.list_price is null
  ) then
    raise exception 'every line item must name a product that has a list price';
  end if;

  if exists (
    select 1 from jsonb_array_elements(line_items_input) as elem
     where coalesce((elem.value ->> 'quantity')::int, 0) <= 0
  ) then
    raise exception 'every line item needs a quantity of at least 1';
  end if;

  insert into quotes (
    quote_group_id, lead_id, merchant_id, customer_name, agent_id,
    status, title, notes
  )
  values (
    coalesce(quote_group_id_input, gen_random_uuid()),
    lead_id_input,
    merchant_id_input,
    customer_name_input,
    agent_id_input,
    coalesce(status_input, 'draft'),
    nullif(btrim(coalesce(title_input, '')), ''),
    nullif(btrim(coalesce(notes_input, '')), '')
  )
  returning id into new_quote_id;

  -- The snapshot, from products; re-derived by snapshot_quote_line_item()
  -- at a layer no caller can skip.
  insert into quote_line_items (
    quote_id, product_id, quantity, unit_price,
    product_name, product_sku, product_billing, product_kind, sort_order
  )
  select
    new_quote_id,
    p.id,
    (elem.value ->> 'quantity')::int,
    p.list_price,
    p.name,
    p.sku,
    p.billing,
    p.kind,
    (elem.ord - 1)::int
  from jsonb_array_elements(line_items_input) with ordinality as elem(value, ord)
  join products p
    on p.id = (elem.value ->> 'product_id')::int
   and p.archived_at is null;

  return new_quote_id;
end;
$$;

revoke all on function create_quote_version(int, int, text, uuid, uuid, text, text, text, jsonb)
  from public;
grant execute on function create_quote_version(int, int, text, uuid, uuid, text, text, text, jsonb)
  to authenticated, service_role;
