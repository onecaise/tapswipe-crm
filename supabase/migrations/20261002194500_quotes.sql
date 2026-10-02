-- Quotes: what a rep offered a lead, and what it said when they sent it.
--
-- Matches docs/tapswipe_crm_schema.sql, which was updated first.
--
-- APPEND-ONLY ON EDIT. This is the whole design and everything below follows
-- from it. A quote is not edited in place: each edit INSERTS a new row sharing
-- the previous one's quote_group_id with version + 1, and the old row stays
-- exactly as it was. The reasoning is the one `notes` carries, one step
-- further along -- a note is append-only because it is a record of what
-- somebody said, and a quote is append-only because it is a record of what a
-- merchant was shown. "We never quoted that" is an argument a CRM should be
-- able to settle.
--
-- THE CURRENT VERSION IS THE HIGHEST version IN THE GROUP. There is no
-- is_current flag to keep in step, no partial unique index to maintain, and no
-- window where two rows could both claim to be current. What the database does
-- enforce is that the rule is WELL-DEFINED: unique (quote_group_id, version)
-- means a group can never hold two rows at the same version, so "the highest"
-- is always exactly one row.
--
-- Why a group id rather than a self-reference to the first version: a parent
-- pointer makes "every version of this quote" a recursive CTE and makes the
-- chain breakable in the middle. A flat group id makes it
-- `where quote_group_id = $1 order by version`, which is an index scan and
-- cannot be malformed -- the same reasoning that keeps profiles.manager_id one
-- hop deep.

-- ---------------------------------------------------------------------
-- 1. QUOTES
-- ---------------------------------------------------------------------
create table quotes (
  id serial primary key,

  -- Every version of one quote shares this. Defaulted rather than required,
  -- so creating a brand-new quote is an insert that does not mention it; an
  -- edit passes the existing group's id and the trigger below does the rest.
  quote_group_id uuid not null default gen_random_uuid(),

  -- ASSIGNED BY enforce_quote_version(), never by the client, and the client's
  -- value is overwritten rather than validated. Two browser tabs that both
  -- read "the latest is v2" would otherwise both write v3, and the unique
  -- constraint would turn one rep's ordinary second edit into an error they
  -- cannot act on.
  version int not null default 1 check (version >= 1),

  -- ON DELETE CASCADE, like marketing_material_events.lead_id and for the same
  -- reason: a quote is ABOUT the lead, and an orphaned one is a document no
  -- page can place. Deleting a lead is admin-only.
  lead_id int references leads(id) on delete cascade not null,

  -- The owning rep, and one more column referencing profiles(id) -- ON DELETE
  -- NO ACTION, like every one of them but profiles.manager_id, so all four
  -- teardown lists need an entry for it.
  --
  -- ONE entry, though, not two, and the contrast with the marketing pair is
  -- the part worth knowing. There, events must be cleared by material and THEN
  -- by actor, because marketing_material_events.material_id is NO ACTION -- so
  -- a delete by uploaded_by alone fails on somebody else's row. Here
  -- quote_line_items.quote_id is ON DELETE CASCADE, so deleting a rep's quotes
  -- takes their lines with it and quote_line_items needs no entry at all. A
  -- line cannot belong to anyone but its quote's owner, which is exactly what
  -- was not true of a marketing event.
  agent_id uuid references profiles(id) not null,

  -- A vocabulary, unlike every other `category`-shaped text column here,
  -- because these are not labels an admin invents -- they are the states a
  -- quote moves through, and statusIntent() in lib/quotes.ts colours each one.
  -- leads.status is the cautionary precedent: it shipped unconstrained and had
  -- to be given a NOT VALID vocabulary later, over rows that already held
  -- rep-typed strings. This table is new, so the constraint is ordinary and
  -- binds every row from the first one.
  status text not null default 'draft'
    check (status in ('draft', 'sent', 'accepted', 'declined', 'expired')),

  -- What the rep calls it. Nullable: an untitled draft is a legitimate state,
  -- and the UI falls back to the lead's name.
  title text,

  -- Rep-facing terms, carried forward into each new version with the lines.
  notes text,

  created_at timestamptz default now(),

  -- The constraint that makes "highest version" well-defined. Also the
  -- concurrency backstop behind enforce_quote_version(): the trigger reads the
  -- current max and adds one, and two transactions doing that at the same
  -- instant both compute the same number -- at which point this rejects the
  -- loser rather than letting the group fork into two rows that each think
  -- they are current.
  unique (quote_group_id, version)
);

-- "Every version of this quote, newest first" is served by the unique
-- constraint's own index on (quote_group_id, version). This one exists for the
-- OTHER query -- the lead page's "every quote on this lead" -- which that
-- index cannot help with at all.
create index idx_quotes_lead on quotes(lead_id, quote_group_id, version desc);
create index idx_quotes_agent_id on quotes(agent_id);

alter table quotes enable row level security;

create policy "select own or admin" on quotes
  for select using ((agent_id = auth.uid() and is_active_agent()) or is_admin());

-- The lead_id `exists` is the documents.file_key lesson in its third form, and
-- it is here for exactly the reason the marketing events policy carries one.
-- lead_id is client-supplied and no other clause in this policy reads it --
-- the shape that made documents.file_key a live cross-agent read. Without it a
-- rep could file quotes against another rep's lead: not reading anything, but
-- putting a document the merchant never saw in front of the admin reviewing
-- that deal.
--
-- The subquery states `leads.agent_id = auth.uid()` rather than leaning on RLS
-- to filter it, matching the pre_apps child tables: same effect, and a reader
-- does not have to know policies nest to see the check is real.
create policy "insert own via own lead" on quotes
  for insert with check (
    (
      (agent_id = auth.uid() and is_active_agent())
      or is_admin()
    )
    and (
      is_admin()
      or exists (
        select 1 from leads
         where leads.id = lead_id and leads.agent_id = auth.uid()
      )
    )
  );

-- AN UPDATE POLICY ON AN APPEND-ONLY TABLE looks like a contradiction and is
-- not. It exists for exactly one column: `status`. WHICH column is enforced by
-- the GRANT, not by this policy -- `grant update (status)` below is a
-- column-level privilege, so an attempt on anything else fails with
-- `permission denied for column`, loudly, at a layer no policy can be widened
-- past. That is the 20260812143407 lesson applied one column at a time: a
-- write the grant refuses is an error a rep can act on, where a write RLS
-- filters is a save that silently did nothing.
--
-- Why status is mutable at all, when the line items are not: the two are
-- different kinds of fact. Changing what is ON a quote changes what the
-- merchant was offered, and that must produce a new version. Recording that
-- the merchant ACCEPTED it does not change what they were offered -- and
-- forcing a new version for it would mean inventing a version nobody wrote,
-- identical to the last but for one word, which makes the history less true
-- rather than more.
create policy "update own or admin" on quotes
  for update using ((agent_id = auth.uid() and is_active_agent()) or is_admin())
  with check ((agent_id = auth.uid() and is_active_agent()) or is_admin());

-- No DELETE policy and no DELETE grant, for either table. A quote is evidence
-- of what a merchant was offered; there is no archived_at here either, because
-- a superseded version is not retired -- it is history, and the group's
-- highest version is what anybody is shown.

-- ---------------------------------------------------------------------
-- 2. QUOTE LINE ITEMS
-- ---------------------------------------------------------------------
create table quote_line_items (
  id serial primary key,

  -- CASCADE so the chain from leads holds all the way down. A line item
  -- belonging to no quote is not a lesser record, it is an unreadable one.
  quote_id int references quotes(id) on delete cascade not null,

  -- NO ACTION, like every other reference to the catalog: a product is
  -- archived rather than deleted precisely so this reference stays whole.
  product_id int references products(id) not null,

  quantity int not null check (quantity > 0),

  -- THE SNAPSHOT, and the reason this table exists rather than the quote
  -- joining products live. Catalog prices change after a quote is sent;
  -- re-deriving a total from today's list price would silently restate what a
  -- merchant was offered last month, and the restatement would look exactly
  -- like the original.
  --
  -- `check >= 0` for the reason products.list_price is unsigned: a negative
  -- line is a typo, not a clawback.
  unit_price numeric(12,2) not null check (unit_price >= 0),

  -- The rest of the snapshot, and these are not padding. The price argument
  -- above is true word for word of the name and the model number: a product
  -- renamed "Clover Flex (discontinued)" would retroactively rewrite every
  -- quote that ever offered a Clover Flex. Copied at quote time so a
  -- historical version renders as it was sent, and `not null` because every
  -- product has a name -- a blank line on a document handed to a merchant is
  -- worse than a stale one.
  product_name text not null,
  product_sku text,

  -- STORED GENERATED, like rep_payout_rows.rep_payout and for the same reason:
  -- a total computed in the browser and written as data is a figure that can
  -- disagree with its own inputs. Both operands are `not null`, so unlike
  -- rep_payout this is never null.
  line_total numeric(12,2)
    generated always as (round(quantity * unit_price, 2)) stored,

  -- Display order within the quote, so a document does not reshuffle itself
  -- between renders because two lines were inserted in the same millisecond.
  -- Not unique: a duplicate rank is a cosmetic tie, and a constraint that
  -- rejects a quote over it would be worse than the tie.
  --
  -- NOT called `position`. That is a Postgres keyword (the `position(x in y)`
  -- function), legal as a column name but needing quoting in enough places
  -- that it is a standing invitation to a syntax error in whatever query
  -- someone writes next.
  sort_order int not null default 0
);

create index idx_quote_line_items_quote
  on quote_line_items(quote_id, sort_order, id);

alter table quote_line_items enable row level security;

-- NO agent_id, so ownership is reached through the parent, exactly as the
-- pre_apps child tables do it -- and note is_active_agent() wraps the `exists`
-- rather than sitting inside it, which is the form those three established.
create policy "select via own quote" on quote_line_items
  for select using (
    (
      is_active_agent()
      and exists (
        select 1 from quotes
         where quotes.id = quote_id and quotes.agent_id = auth.uid()
      )
    )
    or is_admin()
  );

create policy "insert via own quote" on quote_line_items
  for insert with check (
    (
      is_active_agent()
      and exists (
        select 1 from quotes
         where quotes.id = quote_id and quotes.agent_id = auth.uid()
      )
    )
    or is_admin()
  );

-- No UPDATE and no DELETE, in policy or in grant -- stricter than the quotes
-- table above, which allows the one status column. A line item belongs to a
-- version, and a version is what it said when it was sent. Changing one is the
-- edit that is supposed to produce a new version, so allowing it here would
-- route around the entire design.

-- ---------------------------------------------------------------------
-- 3. enforce_quote_version() -- assigns the version, and refuses a write
--    into another rep's quote group.
--
-- `security definer`, and it owes a reason, because the default here is
-- invoker (see the note on convert_ghost_sheet_to_lead). The reason is that
-- BOTH of its jobs are about rows the caller cannot see:
--
--   * The group's current max version. An invoker function reading
--     max(version) through RLS sees only the caller's own rows -- fine until
--     an ADMIN edits a rep's quote, at which point the admin sees everything
--     and the rep sees their own, and the two compute different next versions
--     for the same group.
--
--   * Whether the group belongs to somebody else. This cannot be expressed in
--     the insert policy at all: an `exists` subquery there is itself filtered
--     by the select policy, so a foreign group reads as an ABSENT group and
--     the forged insert is admitted as a brand-new quote. The check has to see
--     past RLS to mean anything, which is the stated criterion for reaching
--     for `definer` -- and it pays for it the way the others do, by refusing
--     rather than returning data.
--
-- ASSIGNING rather than validating is the other half. A client that computes
-- its own version number is racing every other tab the rep has open; the
-- unique constraint would catch the collision, but it would surface as a
-- constraint violation on an ordinary second edit. Computing it here means the
-- only way to lose is a genuine simultaneous write, which is what the
-- constraint is actually for.
-- ---------------------------------------------------------------------
create or replace function enforce_quote_version()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  group_agent_id uuid;
  max_version int;
begin
  -- One scan for both facts. An empty group yields NULLs in both, which is the
  -- brand-new-quote case.
  select q.agent_id, max(q.version)
    into group_agent_id, max_version
    from quotes q
   where q.quote_group_id = NEW.quote_group_id
   group by q.agent_id;

  if group_agent_id is not null and group_agent_id <> NEW.agent_id then
    -- Deliberately not naming the owner. "Not yours" and "does not exist" are
    -- already indistinguishable everywhere else here, and an error message is
    -- as good an id oracle as a status code.
    raise exception 'quote group belongs to another agent';
  end if;

  NEW.version := coalesce(max_version, 0) + 1;
  return NEW;
end;
$$;

revoke all on function enforce_quote_version() from public;
-- Trigger function: revoked and deliberately NOT granted, like
-- log_cross_agent_change() and set_updated_at(). A trigger fires whether or
-- not the querying role holds EXECUTE on it, so a grant would widen the
-- surface for no benefit.
revoke all on function enforce_quote_version() from anon, authenticated;

create trigger quotes_enforce_version
  before insert on quotes
  for each row execute function enforce_quote_version();

-- ---------------------------------------------------------------------
-- 4. create_quote_version() -- writes a quote and its lines in ONE
--    transaction.
--
-- SECURITY INVOKER, like convert_ghost_sheet_to_lead and for the same reason:
-- every insert inside it is scoped by the caller's own policies, so a rep gets
-- their own lead checked by the `exists` in the insert policy and an admin
-- gets the admin branch, with no role test in this body and no agent_id filter
-- here to fall out of step with the policy. The only thing it adds is
-- atomicity.
--
-- Which is the whole point. supabase-js has no client-side transaction, so the
-- browser alternative is "insert the quote, then insert its lines" -- two
-- round trips with a real window in between, and a failure there leaves a
-- quote with no line items. On a table where the lines ARE the document, that
-- is not a lesser version of the record: it is a $0.00 quote against a lead,
-- indistinguishable from one a rep meant to send. marketing_materials
-- tolerates the equivalent window because a row with no file is recognisable
-- as unfinished and re-uploadable; an empty quote is neither.
--
-- `agent_id_input` rather than auth.uid(): an admin building a quote on a
-- rep's behalf must not move it into their own book, which is the same call
-- convert_ghost_sheet_to_lead makes when it takes agent_id from the sheet. A
-- rep passing anybody else's id is refused by the insert policy, not by code
-- here.
-- ---------------------------------------------------------------------
create or replace function create_quote_version(
  lead_id_input int,
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
  -- A quote with no lines is the state this function exists to make
  -- unreachable, so it is refused here rather than written and reported.
  if line_items_input is null
     or jsonb_typeof(line_items_input) <> 'array'
     or jsonb_array_length(line_items_input) = 0 then
    raise exception 'a quote needs at least one line item';
  end if;

  -- Three refusals, each with its own message, rather than one count
  -- comparison at the end. A count tells the rep that SOMETHING in their quote
  -- is wrong; these tell them which thing, and the three causes need three
  -- different actions (pick a different product, ask an admin to price it, fix
  -- the quantity).

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

  -- A null list_price means "not priced yet", never zero -- so an unpriced
  -- product cannot go on a document a merchant reads. Coalescing it to 0.00
  -- here is the exact failure products.list_price is nullable to prevent: it
  -- would put a free terminal on a quote and raise nothing.
  if exists (
    select 1 from jsonb_array_elements(line_items_input) as elem
      join products p on p.id = (elem.value ->> 'product_id')::int
     where p.list_price is null
  ) then
    raise exception 'every line item must name a product that has a list price';
  end if;

  -- Caught here so the message names the quantity. The column's own
  -- `check (quantity > 0)` and `not null` would both reject these too, but as
  -- a constraint violation naming neither the line nor the fix.
  if exists (
    select 1 from jsonb_array_elements(line_items_input) as elem
     where coalesce((elem.value ->> 'quantity')::int, 0) <= 0
  ) then
    raise exception 'every line item needs a quantity of at least 1';
  end if;

  -- version is omitted: quotes_enforce_version assigns it, and a value passed
  -- here would be overwritten anyway.
  --
  -- coalesce on the group id so a brand-new quote can pass NULL and take the
  -- column default rather than needing the caller to generate a uuid.
  insert into quotes (
    quote_group_id, lead_id, agent_id, status, title, notes
  )
  values (
    coalesce(quote_group_id_input, gen_random_uuid()),
    lead_id_input,
    agent_id_input,
    coalesce(status_input, 'draft'),
    nullif(btrim(coalesce(title_input, '')), ''),
    nullif(btrim(coalesce(notes_input, '')), '')
  )
  returning id into new_quote_id;

  -- THE SNAPSHOT IS TAKEN HERE, from products, rather than trusted from the
  -- caller. The browser sends product_id and quantity and nothing else that
  -- reaches a column; name, sku and unit_price are read off the catalog inside
  -- the same transaction that writes the quote.
  --
  -- That split is the point. A client-supplied unit_price would be the
  -- documents.file_key shape one more time -- a figure no policy reads, on a
  -- document handed to a merchant -- and it would also make the snapshot a
  -- claim about the catalog rather than a copy of it. The three guards above
  -- have already established that every product_id resolves to a live, priced
  -- row, so this join cannot drop a line.
  --
  -- `with ordinality` supplies sort_order from the array's own order, so the
  -- document renders in the order the rep built it rather than in whatever
  -- order the ids happen to sort.
  insert into quote_line_items (
    quote_id, product_id, quantity, unit_price,
    product_name, product_sku, sort_order
  )
  select
    new_quote_id,
    p.id,
    (elem.value ->> 'quantity')::int,
    p.list_price,
    p.name,
    p.sku,
    (elem.ord - 1)::int
  from jsonb_array_elements(line_items_input) with ordinality as elem(value, ord)
  join products p
    on p.id = (elem.value ->> 'product_id')::int
   and p.archived_at is null;

  return new_quote_id;
end;
$$;

revoke all on function create_quote_version(int, uuid, uuid, text, text, text, jsonb)
  from public;
grant execute on function create_quote_version(int, uuid, uuid, text, text, text, jsonb)
  to authenticated, service_role;

-- ---------------------------------------------------------------------
-- 5. CROSS-AGENT AUDIT -- attached to quotes, NOT to quote_line_items.
--
-- quotes gets the trigger. It carries agent_id, it is written through Tier 1
-- by reps on their own leads, and the ordinary case is therefore actor =
-- agent_id, which logs nothing. An ADMIN building or revising a quote on a
-- rep's lead is exactly the privileged act the trail exists for -- and under
-- the append-only design that lands as a cross_agent_insert on the new
-- version, which is the right granularity: the quote that was added is named,
-- and the one it supersedes is still there to compare against.
--
-- This is NOT the rep_payout_rows case, which is the one worth ruling out
-- explicitly. Those tables are excluded because nobody except an admin can
-- write them at all, so `actor is distinct from row_agent_id` is true for
-- EVERY write and one forty-row import would produce forty audit rows. Here
-- the common writer is the owning rep, so the trigger is quiet by default and
-- only speaks when something unusual happened.
--
-- quote_line_items does NOT get it, for two reasons that both stand alone:
--
--   * It has no agent_id, so log_cross_agent_change() would read NULL out of
--     to_jsonb(NEW) and log every write -- the support_ticket_replies trap.
--     (That table's answer was a sibling function resolving the parent's
--     owner; this one does not need the equivalent, per the next point.)
--
--   * Even with a working variant it would be pure duplication at a worse
--     granularity. One admin edit is one quote row plus N line rows, so the
--     trail would carry N+1 entries describing a single act, N of which name
--     a table nobody looks up by id. The parent row already records the event.
--
-- And the hole that forced documents into the trigger list after it was first
-- excluded does not exist here. documents was added because its DELETE fell
-- through all three audit mechanisms -- it is the one table whose delete
-- policy is own-row-or-admin, and a delete mints no signed URL, so nothing
-- fired. quote_line_items has no UPDATE and no DELETE in either layer, so
-- there is no verb that could go unrecorded.
-- ---------------------------------------------------------------------
create trigger quotes_audit_cross_agent
  after insert or update or delete on quotes
  for each row execute function log_cross_agent_change();

-- ---------------------------------------------------------------------
-- 6. GRANTS
-- ---------------------------------------------------------------------

-- SELECT and INSERT in full, and UPDATE ON ONE COLUMN.
--
-- The column list is the entire append-only mechanism, and it is a grant
-- rather than a policy because a policy cannot say it: RLS decides which ROWS
-- an UPDATE may touch, and only a column-level grant decides which COLUMNS.
--
-- Spelled as its own statement rather than folded into the line above: a
-- table-level `grant update` and a column-level one are different privileges,
-- and `grant select, insert, update (status)` would read as if the restriction
-- applied to all three.
grant select, insert on quotes to authenticated;
grant update (status) on quotes to authenticated;

-- SELECT and INSERT only -- stricter than quotes, which has the one mutable
-- column. A line item is what the quote said when it was sent.
grant select, insert on quote_line_items to authenticated;

-- USAGE only, never SELECT. Granted at all (unlike the four rep_payout
-- sequences) because both tables grant INSERT to authenticated -- and note
-- that create_quote_version() is security INVOKER, so it consumes nextval()
-- as the CALLER rather than as the owner. An invoker RPC is exactly the case
-- where a forgotten sequence grant produces `permission denied for sequence`
-- from inside a function whose own EXECUTE grant looks correct.
grant usage on quotes_id_seq to authenticated;
grant usage on quote_line_items_id_seq to authenticated;

grant all on quotes to service_role;
grant all on quote_line_items to service_role;
grant usage on quotes_id_seq to service_role;
grant usage on quote_line_items_id_seq to service_role;

-- Never anon.
revoke all on quotes from anon;
revoke all on quote_line_items from anon;
revoke all on quotes_id_seq from anon;
revoke all on quote_line_items_id_seq from anon;
