-- =====================================================================
-- A quote belongs to a LEAD or to a MERCHANT -- exactly one -- and a rep
-- cannot put a price on one.
--
-- Spec: docs/tapswipe_crm_schema.sql, updated first. The doc carries the
-- full reasoning; this file carries the migration order, which matters in
-- three places and is called out where it does.
-- =====================================================================

-- ---------------------------------------------------------------------
-- 1. quotes gains a second owner column, and lead_id stops being required
-- ---------------------------------------------------------------------

alter table quotes
  add column if not exists merchant_id int references merchants(id) on delete cascade;

alter table quotes alter column lead_id drop not null;

-- ORDINARY, NOT `not valid`, and that is a decision. NOT VALID exists for
-- a constraint added over data that predates it --
-- documents_file_key_matches_owner and merchants_split_totals_100 both
-- carry it because hand-rolled rows already violated them. Here the
-- existing rows can be PROVEN clean: lead_id was `not null` until the
-- statement above, and merchant_id was added by this migration so it is
-- null on every row -- therefore num_nonnulls(lead_id, merchant_id) = 1
-- for every existing row by construction. Adding it NOT VALID anyway
-- would give up the guarantee for nothing, and silently: a NOT VALID
-- constraint looks identical in the schema and enforces nothing on the
-- rows that were there first.
alter table quotes
  add constraint quotes_exactly_one_owner
  check (num_nonnulls(lead_id, merchant_id) = 1);

-- Partial on each owner column. A plain two-column index could not stand
-- in: every merchant quote has a null lead_id and vice versa, so an
-- unpartitioned index carries a null half for each. Postgres uses a
-- partial index only when the query's WHERE implies the predicate, and
-- both detail pages do exactly that -- `where lead_id = $1` implies
-- `lead_id is not null`.
drop index if exists idx_quotes_lead;
create index idx_quotes_lead
  on quotes(lead_id, quote_group_id, version desc)
  where lead_id is not null;
create index if not exists idx_quotes_merchant
  on quotes(merchant_id, quote_group_id, version desc)
  where merchant_id is not null;

-- ---------------------------------------------------------------------
-- 2. The insert policy gains the merchant branch.
--
-- NOT optional. With lead_id nullable, the old single
-- `exists (… leads.id = lead_id …)` returns no rows for a merchant quote
-- -- so without this a rep could not quote a merchant at all, while an
-- admin silently could.
--
-- The merchant branch MIRRORS the merchants select policy rather than
-- inventing a rule: a rep may quote exactly the merchants they could
-- already see, so this opens no new reachable surface. Spelled out rather
-- than leaning on RLS to filter the subquery, matching the leads branch.
--
-- The `is not null` guards keep the two branches honest -- without them a
-- merchant quote would evaluate the leads `exists` against null, which is
-- harmlessly false but reads as if either subquery could admit the other
-- kind of row.
--
-- Renamed, so the policy's name still describes it. Dropped by the OLD
-- name first, because `create policy` cannot replace.
-- ---------------------------------------------------------------------
drop policy if exists "insert own via own lead" on quotes;
drop policy if exists "insert own via own lead or merchant" on quotes;
create policy "insert own via own lead or merchant" on quotes
  for insert with check (
    (
      (agent_id = auth.uid() and is_active_agent())
      or is_admin()
    )
    and (
      is_admin()
      or (
        lead_id is not null
        and exists (
          select 1 from leads
           where leads.id = lead_id and leads.agent_id = auth.uid()
        )
      )
      or (
        merchant_id is not null
        and exists (
          select 1 from merchants
           where merchants.id = merchant_id and merchants.agent_id = auth.uid()
        )
      )
    )
  );

-- ---------------------------------------------------------------------
-- 3. quote_line_items snapshots two more facts.
--
-- ORDER MATTERS HERE and it is the reason these are three statements
-- rather than one: added nullable, BACKFILLED from products, and only
-- then made NOT NULL. Adding them NOT NULL with a default would have
-- stamped every historical line with the default instead of with what its
-- own product actually says.
--
-- The backfill is safe because products.billing and products.kind are
-- themselves NOT NULL with defaults, so every row the FK points at has a
-- value to copy. It runs BEFORE the trigger below exists, and would be
-- unaffected anyway -- that trigger is INSERT-only and this is an UPDATE.
--
-- No CHECK on either, deliberately: products.kind and products.billing
-- carry one because they are current state a person types, while these
-- are a record of what was true when the quote was sent. If the
-- vocabulary is ever changed, an old row holding a retired value is
-- correct history, and a constraint would turn that migration into one
-- that has to rewrite documents.
-- ---------------------------------------------------------------------
alter table quote_line_items add column if not exists product_billing text;
alter table quote_line_items add column if not exists product_kind text;

update quote_line_items li
   set product_billing = p.billing,
       product_kind    = p.kind
  from products p
 where p.id = li.product_id
   and (li.product_billing is null or li.product_kind is null);

alter table quote_line_items alter column product_billing set not null;
alter table quote_line_items alter column product_kind set not null;

-- ---------------------------------------------------------------------
-- 4. THE PRICE LOCK.
--
-- A rep cannot put a price on a quote. The hole this closes is real and
-- not theoretical: `grant select, insert on quote_line_items to
-- authenticated` plus an insert policy that only asks whether the parent
-- quote is the caller's means a rep's own session can POST a line item to
-- PostgREST with any unit_price it likes, on their own quote, and every
-- policy agrees.
--
-- Three more obvious answers, and why each fails:
--
--   * Hiding the field in the UI is not a boundary at all.
--   * A column-level grant (`grant insert (quote_id, product_id,
--     quantity, sort_order)`) is the right instinct -- it is what makes
--     quotes.status the only mutable column -- and fails HERE because
--     create_quote_version() is security INVOKER and would be refused its
--     own snapshot. Making it definer to work around that trades a narrow
--     problem for the broad one invoker exists to avoid.
--   * Revoking INSERT outright fails for the same reason.
--
-- So a BEFORE INSERT trigger that OVERWRITES the five snapshot columns
-- from products, whatever the caller supplied. Overwrite rather than
-- raise, because nothing legitimate ever supplies a price: the RPC has no
-- parameter for one. unit_price is a DERIVED column that happens not to
-- be generated, because `generated always as` cannot reach another table.
--
-- SECURITY DEFINER, and the reason is not reach -- every active user can
-- already read every product. It is definer so the figure on a document
-- cannot be changed by changing a POLICY: an invoker trigger reads
-- products through the caller's select policy, so narrowing that later
-- would break the snapshot inside the one function whose job is to be
-- unweakenable. Contrast enforce_compatibility_kinds() in the previous
-- migration, which is invoker because it has no such claim to make.
-- ---------------------------------------------------------------------
create or replace function snapshot_quote_line_item()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  p record;
begin
  select name, sku, list_price, billing, kind, archived_at
    into p
    from products
   where id = NEW.product_id;

  -- Checked rather than left to the foreign key, because a BEFORE trigger
  -- runs ahead of constraint checks: without this the assignments below
  -- would read NULL off an unassigned record and the insert would fail on
  -- product_name being null, naming a column rather than the cause.
  if not found then
    raise exception 'a quote line item must name a product that is in the catalog';
  end if;

  if p.archived_at is not null then
    raise exception 'a quote line item cannot name an archived product';
  end if;

  -- null means "not priced yet", never zero. Coalescing here is the exact
  -- failure products.list_price is nullable to prevent: a free terminal
  -- on a document a merchant reads, raising nothing.
  if p.list_price is null then
    raise exception 'a quote line item must name a product that has a list price';
  end if;

  NEW.unit_price      := p.list_price;
  NEW.product_name    := p.name;
  NEW.product_sku     := p.sku;
  NEW.product_billing := p.billing;
  NEW.product_kind    := p.kind;

  return NEW;
end;
$$;

revoke all on function snapshot_quote_line_item() from public;
-- Trigger function: revoked and deliberately NOT granted, like
-- enforce_quote_version() and set_updated_at(). A trigger fires whether
-- or not the querying role holds EXECUTE.
revoke all on function snapshot_quote_line_item() from anon, authenticated;

-- INSERT only. There is no UPDATE grant or policy on this table at either
-- layer, so there is no update to intercept -- and `or update` here would
-- quietly imply one exists.
drop trigger if exists quote_line_items_snapshot on quote_line_items;
create trigger quote_line_items_snapshot
  before insert on quote_line_items
  for each row execute function snapshot_quote_line_item();

-- ---------------------------------------------------------------------
-- 5. enforce_quote_version() also pins WHO a group is about.
--
-- A CHECK cannot express it, for the reason the agent test cannot: this
-- is a fact about a row's siblings.
--
-- Reachable without it, and not hypothetically: create_quote_version()
-- takes a group id and an owner as separate arguments, so a rep passing
-- their own group id with a different (also their own) merchant_id would
-- add a "version 2" about another business. Nothing leaks -- both records
-- are theirs -- but the print route filters by owner, so it would render
-- "version 2 of 1" on one page and "version 1 of 1" on the other. The
-- append-only design exists to settle what a merchant was shown, and a
-- group spanning two merchants cannot.
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
begin
  -- One scan for every fact about the group. An empty group yields NULLs
  -- throughout, which is the brand-new-quote case.
  --
  -- min() on the two owner columns rather than a bare reference: they are
  -- not in the GROUP BY, and they are constant across the group precisely
  -- because of the check below -- so any aggregate reads the group's one
  -- value, and min() says "whatever this group holds" without implying an
  -- ordering means anything.
  select q.agent_id, min(q.lead_id), min(q.merchant_id), max(q.version)
    into group_agent_id, group_lead_id, group_merchant_id, max_version
    from quotes q
   where q.quote_group_id = NEW.quote_group_id
   group by q.agent_id;

  if group_agent_id is not null and group_agent_id <> NEW.agent_id then
    -- Deliberately not naming the owner. "Not yours" and "does not exist"
    -- are indistinguishable everywhere else here, and an error message is
    -- as good an id oracle as a status code.
    raise exception 'quote group belongs to another agent';
  end if;

  -- `is distinct from` on both, so a NULL on either side compares as a
  -- real difference. Plain `<>` would be NULL -- not false -- for a lead
  -- quote whose group_merchant_id is null, and the `if` would not fire.
  if group_agent_id is not null
     and (group_lead_id     is distinct from NEW.lead_id
       or group_merchant_id is distinct from NEW.merchant_id) then
    raise exception 'quote group belongs to a different lead or merchant';
  end if;

  NEW.version := coalesce(max_version, 0) + 1;
  return NEW;
end;
$$;

revoke all on function enforce_quote_version() from public;
revoke all on function enforce_quote_version() from anon, authenticated;

-- ---------------------------------------------------------------------
-- 6. create_quote_version() takes a merchant.
--
-- THE SEVEN-ARGUMENT VERSION IS DROPPED, NOT LEFT BESIDE THE NEW ONE.
-- `create or replace function` with a different number of parameters
-- creates a SECOND function rather than replacing the first, so giving
-- merchant_id_input a default would leave a 7-argument call with two
-- candidates -- an ambiguity Postgres reports at CALL time, from the
-- browser, as a failed save. Exactly the trap dashboard_counts() hit, and
-- the same answer: drop the old signature here, and assert in a test that
-- the name resolves to exactly one function.
--
-- Neither owner argument has a default, deliberately. supabase-js calls
-- this with named parameters so a default would cost nothing to use, but
-- it would let a caller pass neither and get a constraint violation
-- naming quotes_exactly_one_owner instead of a signature that made them
-- say which record they meant.
-- ---------------------------------------------------------------------
drop function if exists create_quote_version(int, uuid, uuid, text, text, text, jsonb);

create or replace function create_quote_version(
  lead_id_input int,
  merchant_id_input int,
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
  -- Refused here as well as by quotes_exactly_one_owner, so the message
  -- says what to do. The constraint's error names a constraint and a row;
  -- this names the choice the caller failed to make.
  if (lead_id_input is null) = (merchant_id_input is null) then
    raise exception 'a quote belongs to exactly one of a lead or a merchant';
  end if;

  if line_items_input is null
     or jsonb_typeof(line_items_input) <> 'array'
     or jsonb_array_length(line_items_input) = 0 then
    raise exception 'a quote needs at least one line item';
  end if;

  -- Three refusals, each with its own message, rather than one count
  -- comparison at the end: a count tells the rep that SOMETHING is wrong,
  -- these tell them which thing, and the three causes need three
  -- different actions.
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

  -- version is omitted: quotes_enforce_version assigns it, and a value
  -- passed here would be overwritten anyway.
  insert into quotes (
    quote_group_id, lead_id, merchant_id, agent_id, status, title, notes
  )
  values (
    coalesce(quote_group_id_input, gen_random_uuid()),
    lead_id_input,
    merchant_id_input,
    agent_id_input,
    coalesce(status_input, 'draft'),
    nullif(btrim(coalesce(title_input, '')), ''),
    nullif(btrim(coalesce(notes_input, '')), '')
  )
  returning id into new_quote_id;

  -- THE SNAPSHOT, taken from products rather than trusted from the
  -- caller: the browser sends product_id and quantity and nothing else
  -- that reaches a column.
  --
  -- Written here AND re-derived by snapshot_quote_line_item(), which is
  -- two layers computing the same thing from the same table in the same
  -- transaction, so they cannot disagree. Deliberate, and the same
  -- arrangement documents_file_key_matches_owner has with
  -- fileKeyMatchesOwner(): this copy is the one a reader of the RPC can
  -- see, the trigger is the one no caller can skip, and either alone is
  -- correct.
  --
  -- `with ordinality` supplies sort_order from the array's own order. That
  -- is load-bearing rather than cosmetic now: the printed proposal reads
  -- its device/add-on GROUPING off (sort_order, product_kind), so the
  -- cart's order is what puts each add-on under the device it was chosen
  -- for.
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

revoke all on function create_quote_version(int, int, uuid, uuid, text, text, text, jsonb)
  from public;
grant execute on function create_quote_version(int, int, uuid, uuid, text, text, text, jsonb)
  to authenticated, service_role;
