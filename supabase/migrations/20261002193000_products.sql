-- Product catalog: the hardware and POS lineup a quote is built from.
--
-- Matches docs/tapswipe_crm_schema.sql, which was updated first.
--
-- The SECOND client-readable table with no agent_id, and the same shape of
-- thing as marketing_materials for the same reason: company reference data.
-- Every active rep reads all of it, only an admin writes it, and there is
-- nothing per-rep to compare a row against.
--
-- Three deliberate omissions, written down so they do not read as oversights:
--
-- 1. NO profiles REFERENCE. marketing_materials carries uploaded_by because a
--    material has an upload lifecycle -- file_key is nullable, an unfinished
--    upload is a real state, and "which admin do I ask about this one" is a
--    question that page answers. A product is a handful of fields an admin
--    types, edited in place, so a created_by would record who first typed it
--    and go stale the moment anybody changed the price -- answering a question
--    nobody asks while adding one more column to clear before a user can be
--    deleted. The four teardown lists are already the most-forgotten thing in
--    this repo; this table does not join them.
--
-- 2. NO VERSION HISTORY, unlike the quotes migration that follows. The two
--    look like they should agree and must not: a quote is a document handed to
--    a merchant, so what it said when it was sent has to survive being edited,
--    which is why quote_line_items snapshots the price instead of joining this
--    table live. Once that snapshot exists the catalog is free to be a plain
--    mutable current-state table, because no quote depends on its history.
--
-- 3. NO BULK IMPORT, deliberately deferred. A column-mapping and blocker
--    pipeline of the rep_payout_import_rows / user_import_rows kind encodes
--    rules read off a real file, and the hardware pricing sheet this one would
--    parse does not exist yet. Guessing its columns now means writing a parser
--    to be rewritten and a staging table whose shape is a guess.

-- ---------------------------------------------------------------------
-- 1. TABLE
-- ---------------------------------------------------------------------
create table products (
  id serial primary key,

  name text not null,

  -- The manufacturer's model or part number. Nullable because software and
  -- service line items ("Gateway monthly", "PCI compliance") have no model
  -- number, and a blank must never be stored: the partial unique index below
  -- treats the empty string as a value, so two products cleared that way would
  -- collide. profiles.agent_number set this precedent; both write paths
  -- normalise '' to null the same way.
  sku text,

  -- Free text with no vocabulary, matching marketing_materials.category,
  -- support_tickets.category and profiles.territory. Reference data an admin
  -- extends when the lineup grows a new kind of thing, where a CHECK would
  -- mean a migration every time a vendor ships a product category.
  category text not null,

  -- NULLABLE, and null means "not priced yet" or "call for pricing" -- never
  -- zero. The same distinction rep_payout_rows.rep_payout draws, and for the
  -- same reason: a quote line that silently takes 0.00 off a missing list
  -- price is a figure a rep hands to a merchant. create_quote_version()
  -- refuses an unpriced product outright rather than coalescing it.
  --
  -- Unsigned, unlike rep_payout_rows.total_cost: a clawback is a real negative
  -- residual, but a negative list price is a typo.
  list_price numeric(12,2) check (list_price is null or list_price >= 0),

  description text,

  -- The deliberately loose column, and the reason it exists NOW rather than
  -- when it is needed: the real hardware/POS lineup and the integration
  -- details are not finalised, so the fields each product type turns out to
  -- need are unknown. Whatever they are -- connectivity, processor
  -- compatibility, dimensions, bundled software -- they go here with no
  -- migration.
  --
  -- The CHECK is not decoration. jsonb accepts 4, null and [1,2] as perfectly
  -- valid documents, and every reader here does key lookups -- so a scalar
  -- stored by a careless write turns every `specs ->> 'x'` into a silent NULL
  -- rather than an error. Pinning it to an object means the one shape the code
  -- assumes is the one shape the column holds.
  --
  -- Known cost, stated so it is a choice rather than a discovery: nothing
  -- validates the KEYS. A typo'd key is a fact about the product that no query
  -- finds and no constraint catches. That is the trade a catch-all column is,
  -- and the way out when the lineup settles is to promote the keys that turned
  -- out to matter into real columns -- not to add more checks here.
  specs jsonb not null default '{}'::jsonb
    check (jsonb_typeof(specs) = 'object'),

  -- Retirement is a timestamp, not a delete, for the reason
  -- marketing_materials.archived_at is one and more sharply: a product exists
  -- to be referenced by quote_line_items, and quotes are evidence of what a
  -- merchant was offered. Deleting a discontinued terminal would either cascade
  -- historical quote lines away or be blocked by the FK forever.
  archived_at timestamptz,

  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- ---------------------------------------------------------------------
-- 2. INDEXES
-- ---------------------------------------------------------------------

-- Partial, `where sku is not null`, exactly like profiles.agent_number's. A
-- plain unique index would allow only a single product with no model number in
-- the whole catalog once one of them normalised to '' -- NULLs are distinct
-- from one another, but there is only one empty string.
create unique index idx_products_sku on products(sku) where sku is not null;

-- Browsing is "what is in this category", and an archived product is never in
-- the picker -- so this is partial on exactly the rows that query reads, the
-- same shape as idx_marketing_materials_category.
create index idx_products_category on products(category, name)
  where archived_at is null;

-- ---------------------------------------------------------------------
-- 3. RLS
-- ---------------------------------------------------------------------
alter table products enable row level security;

-- No agent_id comparison, like marketing_materials. is_active_agent() is the
-- load-bearing half and is easy to misread as decoration on a table with no
-- ownership to check: a deactivated rep holds a working JWT until it expires,
-- and without this they keep reading the company's current pricing after being
-- let go.
create policy "select active or admin" on products
  for select using (is_active_agent() or is_admin());

-- Admin-only writes, as policies rather than service-role-only, because the
-- admin UI edits every field through PostgREST directly. There is no file and
-- so no Edge Function here at all.
create policy "admin inserts" on products
  for insert with check (is_admin());
create policy "admin updates" on products
  for update using (is_admin()) with check (is_admin());
-- No DELETE policy, and no DELETE grant below. See archived_at.

-- ---------------------------------------------------------------------
-- 4. TRIGGERS
-- ---------------------------------------------------------------------
create trigger products_set_updated_at
  before update on products
  for each row execute function set_updated_at();

-- No cross-agent audit trigger: no agent_id, so log_cross_agent_change() would
-- read NULL out of to_jsonb(NEW) and log EVERY write -- the
-- support_ticket_replies trap, and the same answer marketing_materials gives.

-- ---------------------------------------------------------------------
-- 5. GRANTS
--
-- RLS decides which rows; grants decide whether the table is reachable at all.
-- A table with perfect policies and no grant answers every request with
-- `permission denied`, and 20260805210000 removed the default privileges that
-- used to paper over this.
-- ---------------------------------------------------------------------

-- INSERT and UPDATE are granted even though only an admin may use them: that
-- separation is RLS's job and a grant cannot express it. Same arrangement
-- marketing_materials, bug_reports and rep_payout_rows already have. No DELETE
-- in either layer.
grant select, insert, update on products to authenticated;

-- USAGE only, never SELECT: nextval() is all a serial insert needs, and SELECT
-- on a sequence hands out last_value -- here a free count of the catalog, which
-- matters less than it does on an owner table but is still nothing a rep needs.
-- Granted at all (unlike the four rep_payout sequences) because an admin's
-- INSERT goes through PostgREST as `authenticated`.
grant usage on products_id_seq to authenticated;

grant all on products to service_role;
grant usage on products_id_seq to service_role;

-- Never anon. 20260805210000 revoked the default privileges precisely so this
-- is a decision rather than an accident; stated here so a reader does not have
-- to go and check.
revoke all on products from anon;
revoke all on products_id_seq from anon;
