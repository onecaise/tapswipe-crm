-- =====================================================================
-- brands: the manufacturers /admin/products is organised by, as a table
-- of their own so a brand can exist before it has any products.
--
-- Spec: docs/tapswipe_crm_schema.sql (BRANDS), which was updated first.
-- The doc carries the reasoning; this file carries what a reader of the
-- migration needs on top of it.
--
-- The shape, in one line: products.brand stays text and becomes a foreign
-- key to brands(name) ON UPDATE CASCADE ON DELETE RESTRICT. No reader of
-- products.brand changes -- the store, lib/quotes-data.ts and the loader
-- all read the same text -- and nothing on a quote snapshots the brand.
-- =====================================================================

create table if not exists brands (
  id serial primary key,
  -- `unique` because the FK below targets it.
  name text not null unique
    constraint brands_name_trimmed check (name = btrim(name) and name <> ''),
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);

-- "Square" and "square" would otherwise be two boxes on the grid.
create unique index if not exists idx_brands_name_lower on brands (lower(name));

-- ---------------------------------------------------------------------
-- Backfill, before the FK, from what products already names.
--
-- Trim first: products_brand_not_blank only refuses an ALL-blank brand,
-- so a padded one ("Square ") is legal in products and would fail
-- brands_name_trimmed. Trimming the product makes it name the brand the
-- backfill is about to create.
--
-- Case collisions ("Square" and "square" both in products) are NOT
-- merged here. Picking a winner would rename a vendor on a rep's store
-- as a side effect of a migration; idx_brands_name_lower refuses the
-- second insert instead and the migration fails, naming the index. The
-- catalog loaded from data/hardware-catalog.csv has none.
-- ---------------------------------------------------------------------
update products set brand = btrim(brand)
 where brand is not null and brand <> btrim(brand);

insert into brands (name)
select distinct brand from products where brand is not null
on conflict (name) do nothing;

-- Ordinary, not NOT VALID: the backfill above made every non-null brand
-- name a row that exists, so the existing rows are clean by construction
-- and validating them costs nothing but a scan.
alter table products
  add constraint products_brand_fkey
  foreign key (brand) references brands(name)
  on update cascade on delete restrict;

-- ---------------------------------------------------------------------
-- The checklist: RLS, four policies, explicit grants. Step 1 (agent_id)
-- struck out -- a manufacturer is not owned by a rep.
-- ---------------------------------------------------------------------
alter table brands enable row level security;

create policy "select active or admin" on brands
  for select using (is_active_agent() or is_admin());
create policy "admin inserts" on brands
  for insert with check (is_admin());
create policy "admin updates" on brands
  for update using (is_admin()) with check (is_admin());
-- Unlike products. Whether a delete destroys anything is the FK's
-- question, and `on delete restrict` answers it by refusing.
create policy "admin deletes" on brands
  for delete using (is_admin());

create trigger brands_set_updated_at
  before update on brands
  for each row execute function set_updated_at();

-- No log_cross_agent_change(): no agent_id, so it would log every write.

grant select, insert, update, delete on brands to authenticated;
grant usage on brands_id_seq to authenticated;

-- scripts/load-hardware-catalog.mjs creates missing brands as service
-- role before inserting the products that name them.
grant all on brands to service_role;
grant usage on brands_id_seq to service_role;
