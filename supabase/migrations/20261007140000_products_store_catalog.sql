-- =====================================================================
-- The product catalog grows the three facts the store browses by, plus
-- the table that says which add-ons fit which devices.
--
-- Spec: docs/tapswipe_crm_schema.sql, which was updated first. The doc
-- carries the per-column reasoning; this file carries only what a reader
-- of the migration needs that the doc does not already say.
-- =====================================================================

-- ---------------------------------------------------------------------
-- products: brand, kind, billing
-- ---------------------------------------------------------------------

-- Nullable, because the catalog legitimately holds things no manufacturer
-- makes ("Gateway monthly", "PCI compliance"). The store has a bucket for
-- the nulls; NOT NULL would force an admin to type something that then
-- appears in a rep's brand list as if it were a vendor.
alter table products add column if not exists brand text;

-- A CHECK that `sku` deliberately does NOT have, and the asymmetry is the
-- point rather than an oversight. Both columns must never hold '', but
-- the consequences differ: a blank sku collides with the next blank sku
-- on idx_products_sku, so it fails loudly on the second one. `brand` has
-- no uniqueness to trip over, so a '' would simply render as an empty
-- heading in the store's browse list and nothing anywhere would object.
-- normalizeBrand() in lib/products.ts handles the browser side; this is
-- the layer no caller can skip.
alter table products
  add constraint products_brand_not_blank
  check (brand is null or btrim(brand) <> '');

-- Closed vocabularies, unlike `category` and `brand`, because CODE reads
-- these: the compatibility trigger below, the store's device list and the
-- printed proposal's two totals. A third value typed by an admin would
-- not be a new label, it would be a row all three silently skip.
--
-- Both carry a default so they can be NOT NULL with no backfill decision.
-- 'device' is the safe reading of "nobody has marked this as an
-- accessory" -- it stays visible in the store rather than vanishing into
-- an add-on list under a device it was never linked to -- and 'one_time'
-- is right because every product predating this column is hardware.
alter table products
  add column if not exists kind text not null default 'device';
alter table products
  add constraint products_kind_vocabulary
  check (kind in ('device', 'addon'));

alter table products
  add column if not exists billing text not null default 'one_time';
alter table products
  add constraint products_billing_vocabulary
  check (billing in ('one_time', 'monthly'));

-- Brand is the store's primary browse axis, so it gets the same shape of
-- index idx_products_category already has: partial on exactly the rows
-- the rep-facing query reads, because an archived product is never in the
-- store.
create index if not exists idx_products_brand
  on products(brand, name)
  where archived_at is null;

-- ---------------------------------------------------------------------
-- product_compatibility
--
-- The THIRD client-readable table with no agent_id, and it inherits that
-- from its parents rather than choosing it: a fact about two catalog rows
-- cannot be owned by a rep. The CLAUDE.md checklist therefore applies
-- with step 1 struck out, and step 4's sequence grant refers to an object
-- that does not exist -- the PAIR is the primary key, so there is no
-- `_id_seq`.
-- ---------------------------------------------------------------------
create table if not exists product_compatibility (
  addon_product_id  int references products(id) not null,
  device_product_id int references products(id) not null,

  -- Ordinary, not NOT VALID: the table is new, so it has no rows that
  -- could fail it. NOT VALID is for a constraint added over data that
  -- predates it; reaching for it when the rows can be proven clean gives
  -- up the guarantee for nothing.
  constraint product_compatibility_distinct
    check (addon_product_id <> device_product_id),

  primary key (addon_product_id, device_product_id)
);

-- "Which add-ons fit this device" is the store's query, run every time a
-- rep drops a device in the cart. The primary key's index leads with
-- addon_product_id, so it cannot serve a lookup by device.
create index if not exists idx_product_compatibility_device
  on product_compatibility(device_product_id, addon_product_id);

-- Step 2 of the checklist, and the one whose omission fails in opposite
-- directions on the hosted project (RLS on, no policies, denies
-- everyone) and everywhere else (wide open). Never rely on ensure_rls.
alter table product_compatibility enable row level security;

-- Copied from products, down to is_active_agent() being the load-bearing
-- half for the same reason: a deactivated rep holds a working JWT until
-- it expires, and the catalog's shape is as much company information as
-- its prices are.
create policy "select active or admin" on product_compatibility
  for select using (is_active_agent() or is_admin());

create policy "admin inserts" on product_compatibility
  for insert with check (is_admin());
create policy "admin updates" on product_compatibility
  for update using (is_admin()) with check (is_admin());

-- DELETE, which products deliberately withholds. Not an inconsistency:
-- a product is archived rather than deleted because quote_line_items
-- snapshots what it said, so the row is history. A compatibility row is
-- not history -- nothing snapshots it and no quote depends on it -- it is
-- a current-state claim an admin got wrong or a vendor stopped
-- honouring. An archived_at here would mean tombstones every reader has
-- to remember to filter.
create policy "admin deletes" on product_compatibility
  for delete using (is_admin());

-- ---------------------------------------------------------------------
-- The kinds, enforced where a CHECK cannot reach.
--
-- A CHECK sees only its own row and this rule is about two OTHER rows --
-- the same reason set_manager()'s one-hop rule lives in a function.
--
-- Worth having even though a wrong row is inert rather than dangerous:
-- the store only ever asks "which add-ons fit this device", keyed on
-- device_product_id, and only devices are offered as cart parents. So a
-- row written with the ids the wrong way round matches nothing, ever, and
-- nothing reports it. An admin links an accessory to a terminal, the
-- store does not offer it, and /admin/products looks correct. This turns
-- a silent nothing into a sentence.
--
-- security INVOKER, the default that needs no defence here -- and note
-- why no definer is wanted: only an admin may write this table, and an
-- admin can read every product, so there is nothing the caller may not
-- already see. Contrast snapshot_quote_line_item() in the next
-- migration, which IS definer because the price on a document must not
-- depend on a policy.
-- ---------------------------------------------------------------------
create or replace function enforce_compatibility_kinds()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  addon_kind  text;
  device_kind text;
begin
  select kind into addon_kind  from products where id = NEW.addon_product_id;
  select kind into device_kind from products where id = NEW.device_product_id;

  -- A missing product is left to the foreign key, which names it
  -- precisely. Raising here too would mean two messages for one cause,
  -- and this one would be the vaguer of them.
  if addon_kind is not null and addon_kind <> 'addon' then
    raise exception
      'the add-on side of a compatibility row must be a product of kind addon';
  end if;

  if device_kind is not null and device_kind <> 'device' then
    raise exception
      'the device side of a compatibility row must be a product of kind device';
  end if;

  return NEW;
end;
$$;

revoke all on function enforce_compatibility_kinds() from public;
-- Trigger function: revoked and deliberately NOT granted, like
-- enforce_quote_version(), log_cross_agent_change() and set_updated_at().
-- A trigger fires whether or not the querying role holds EXECUTE, so a
-- grant would widen the callable surface for nothing.
revoke all on function enforce_compatibility_kinds() from anon, authenticated;

drop trigger if exists product_compatibility_enforce_kinds
  on product_compatibility;
create trigger product_compatibility_enforce_kinds
  before insert or update on product_compatibility
  for each row execute function enforce_compatibility_kinds();

-- No cross-agent audit trigger, for the reason products has none: no
-- agent_id, so log_cross_agent_change() would read NULL and log 100% of
-- writes -- the support_ticket_replies trap.

-- ---------------------------------------------------------------------
-- Step 4: explicit grants. RLS decides which rows; grants decide whether
-- the table is reachable at all, and 20260805210000 removed the default
-- privileges that used to auto-grant new tables precisely so this cannot
-- be skipped by accident.
--
-- INSERT, UPDATE and DELETE are granted even though only an admin may
-- use them: that separation is RLS's job and a grant cannot express it.
-- ---------------------------------------------------------------------
grant select, insert, update, delete on product_compatibility to authenticated;

-- No `grant usage on product_compatibility_id_seq` -- there is no
-- sequence. The composite primary key is the whole key, so nothing here
-- consumes one.

grant all on product_compatibility to service_role;

-- Never anon.
revoke all on product_compatibility from anon;
