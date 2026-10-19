# Quotes/proposals, the hardware catalog, store, brands and print

Moved verbatim from `CLAUDE.md` on 19 Oct 2026 to keep that file under the size limit. **These are binding rules, not history** — CLAUDE.md's "Security and safety rules" summary points here. Words like "above", "below" or "this file" refer to the original single CLAUDE.md; the docs index at the end of CLAUDE.md says where each section now lives.

### Quotes are append-only on EDIT, which is a different thing from `notes`

A quote is never updated in place. Each edit **inserts a new row** sharing the previous one's `quote_group_id` with `version + 1`, and the old row stays exactly as it was. `notes` is append-only because a note is a record of what somebody said; a quote is append-only because it is a record of **what a merchant was shown**, and "we never quoted that" is an argument a CRM should be able to settle.

**The current version is the highest `version` in the group.** There is no `is_current` flag, no partial unique index, and so no window where two rows both claim to be current. What the database enforces is that the rule is *well-defined*: `unique (quote_group_id, version)` means a group can never hold two rows at the same version. The rule itself lives in `currentVersion()` in `lib/quotes.ts` and nowhere else — spelling `Math.max` inline at two call sites is how a list page and a detail page come to disagree about which version a merchant was sent.

**A group id, not a self-reference to v1.** A parent pointer makes "every version of this quote" a recursive CTE and makes the chain breakable in the middle; a flat group id makes it `where quote_group_id = $1 order by version`. Same reasoning that keeps `profiles.manager_id` one hop deep.

**`status` is the one mutable column, and WHICH column is enforced by the GRANT rather than by a policy.** `grant update (status) on quotes to authenticated` is column-level, so an attempt on `title`, `version`, `lead_id` or `agent_id` fails with `permission denied for column` — loudly, before RLS is consulted. This is the `20260812143407` lesson applied one column at a time: a write the grant refuses is an error a rep can act on, where a write RLS filters is a save that silently did nothing. **RLS cannot express this** — it decides which *rows* an UPDATE may touch, never which columns — so if you are reaching for a policy to make a column immutable, the answer is a grant. `quote_line_items` is stricter still: no UPDATE or DELETE at either layer, because changing a line is the edit that is supposed to produce a new version.

Note what this means for a grants test: `has_table_privilege(…, 'UPDATE')` returns **false** when the privilege is held only on a column, so a column grant is invisible to the table-level check rather than indistinguishable from a table-level one. `tests/rls/grants.test.ts` asserts both — the table shape *and* a per-column loop — because each catches a different widening.

**`quote_line_items` snapshots `unit_price`, `product_name` and `product_sku`, and the snapshot is taken SERVER-SIDE.** Catalog prices change after a quote is sent; re-deriving a total from today's list price would silently restate what a merchant was offered last month, and the restatement would look exactly like the original. The browser sends `product_id` and `quantity` and nothing else that reaches a column — a client-supplied `unit_price` would be the `documents.file_key` shape one more time, a figure no policy reads on a document handed to a merchant.

**`create_quote_version()` is `security invoker`, like `convert_ghost_sheet_to_lead`, and exists for atomicity rather than privilege.** supabase-js has no client-side transaction, so the alternative is "insert the quote, then insert its lines" — two round trips with a real window, and a failure there leaves a **$0.00 quote against a lead, indistinguishable from one a rep meant to send**. `marketing_materials` tolerates the equivalent window because a row with no file is recognisable as unfinished and re-uploadable; an empty quote is neither. It refuses three things by name rather than by one count, because the causes need three different actions: a product not in the catalog, a product with **no list price** (null means "not priced yet", never zero — coalescing it to 0.00 would put a free terminal on the document), and a quantity below 1.

**`enforce_quote_version()` is `security definer`, and both of its jobs are the reason.** It assigns the version number — rather than validating a client's, so two tabs that both read "the latest is v2" cannot race into a constraint violation on an ordinary second edit — and it refuses an insert into **another rep's** quote group. That second check *cannot* be a policy: an `exists` subquery in the insert policy is itself filtered by the select policy, so a foreign group reads as an **absent** group and the forged row is admitted as a brand-new quote at version 1. It has to see past RLS to mean anything.

**The audit trigger is on `quotes` and deliberately not on `quote_line_items`.** `quotes` carries `agent_id` and the ordinary writer is the owning rep, so `log_cross_agent_change()` is quiet by default and speaks only when an admin acts on somebody else's deal — this is *not* the `rep_payout_rows` case, where no rep can write at all and the trigger would fire on every row of a forty-row import. The child table is excluded twice over: it has no `agent_id` (the `support_ticket_replies` trap), and even a working sibling function would write N+1 rows for one admin edit, N of them naming a table nobody looks up by id. The `documents` hole does not apply either — there is no UPDATE or DELETE on line items to go unrecorded.

**The catalog is loaded by a SCRIPT, and the staging-table pipeline this file once deferred is now cancelled rather than pending.** `data/hardware-catalog.csv` is the real lineup — 43 rows, 25 devices and 18 add-ons across five brands — and `scripts/load-hardware-catalog.mjs` loads it into `brands`, `products` and `product_compatibility` — brands first, because `products.brand` is a foreign key to `brands(name)`; it creates any brand the file names that is missing, never deletes one, and refuses a brand spelled differently only by case. A column-mapping and blocker pipeline of the `rep_payout_import_rows` / `user_import_rows` kind exists so a non-engineer can load a file nobody has seen before, repeatedly, and inspect the damage before committing. This file is 43 curated rows in version control that change a few times a year, and an admin maintains them on `/admin/products` afterwards — so the review screen is the script's **dry run** (the default; `--write` is opt-in), the staging table is the CSV's git history, and there is nothing to build. Don't build it later either: the thing that would justify it is an unseen file, and this one is in the repo.

Five things the script decides that are worth knowing before changing it:

- **Any validation problem stops the whole load**, with no skippable/blocking split. That split is right for the rep import because two hundred accounts are two hundred independent things; a catalog is one document, and loading forty-two of forty-three rows leaves a half-stocked store that looks complete. `tests/unit/hardware-catalog.test.ts` is where every rule lives, and it validates the **shipped file** as well as fixtures — a validator green on synthetic input while the real catalog is broken is the failure that would otherwise go unnoticed.
- **A blank `retail_price` stays NULL, never 0.00** — `list_price` is nullable precisely so "not priced yet" survives as a different fact from "free", `create_quote_version()` refuses the null outright, and `Number("")` is 0. One row ships unpriced today (`greta-bs1560-ns`) and `valor-virtual-terminal` ships at a real $0.00, so both sides are live cases rather than hypotheticals. No migration is needed for this: the column was nullable from `20261002193000`.
- **`active=no` is `archived_at`, and the `review` note goes into `specs`.** The CSV's `review` column is the only place that says *why* a row is parked, and an archived product on `/admin/products` with no stated reason is one an admin un-archives at the price nobody confirmed. `specs` owns exactly `connectivity` and `review`; every other key an admin adds there survives a re-run, because that column exists to be extended without a migration.
- **It never deletes.** Not a product (`products` has no DELETE policy *or* grant, because `quote_line_items` snapshots what a product said), and not a compatibility link (an admin adding one on `/admin/products` is the expected workflow). A row or link the CSV no longer names is **reported and left**. A re-run does, however, RESET a product an admin edited back to what the file says — which is what the field-by-field dry run is for.
- **`splitCsvRows()` is a verbatim copy of `parseDelimitedText()`** from `supabase/functions/_shared/user-imports.ts`, because a `.mjs` script run by plain `node` cannot import a TypeScript module under `supabase/`. Pinned by behaviour, the `isBlocking()` arrangement: the unit test imports both and asserts they agree, including on the two cases this catalog contains — a comma inside a quoted field, and the doubled quote standing for the inches mark in `Square KDS 15.6" touchscreen`.

**Targets are `local` and `dev`, and there is no prod path in the file at all.** The client is built from the thing that was *checked*: `--target dev` spawns `scripts/check-linked-project.mjs` and then derives the URL from the same `supabase/.temp/linked-project.json` the guard read, so the `npm run db:push -- --db-url <prod>` shape — guard prints "dev, ok" while the command underneath goes elsewhere — is unreachable. It refuses the prod ref outright and does not honour `ALLOW_PROD_SUPABASE`. The guard also runs before a **local** write, because a relink is global CLI state and "I was only working locally" is the belief the 2 Sep incident was held under. The dev service-role key comes from the logged-in CLI (`projects api-keys --reveal`) or `$SUPABASE_SERVICE_ROLE_KEY`, is never printed and never written to a file — `.env.deployed.local` stays publishable-keys-only.

### A proposal belongs to a REP, links to at most one lead or merchant, and a rep cannot price one

As of `20261009150000` a proposal is its own record. `quotes` carries `lead_id`
and `merchant_id`, both nullable, with `quotes_at_most_one_link`
(`check (num_nonnulls(lead_id, merchant_id) <= 1)`, which replaced
`quotes_exactly_one_owner`'s `= 1`). Linked to a lead to win a deal, to a
merchant to sell more to a business on the books, or to nothing for a business
not in the CRM yet — one table, one append-only version history, one printable
document.

**`agent_id` is the rep the proposal is FOR**, not "the owner of the parent
record" as it was while a quote could only be made from a lead or merchant
page. Same values for every existing row; a different rule for new ones. The
insert policy (`insert own, linked only to what the caller can see`) says a rep
creates for themselves and an admin for anyone, and that each link must be a
record **the caller can see** — its `exists` subqueries deliberately lean on
the leads/merchants select policies rather than spelling `agent_id` out, because
"visible to the caller" IS the rule. Consequence: an admin may file rep A's
proposal against rep B's lead; it is A's, and B sees it nowhere. A missing lead
and another rep's lead are refused with the **identical** message — the BEFORE
trigger runs first, so it must never raise on a missing record (measured: a
trigger that did turned the insert into an id oracle).

**`customer_name` is a per-version snapshot, NOT NULL and non-blank.** Linked:
`enforce_quote_version()` copies the record's name over whatever was sent (the
price lock's overwrite-don't-trust shape). Unlinked: the typed name, trimmed.
"Prepared for" on the sheet is the printed version's snapshot, so renaming a
lead does not readdress last month's proposal. The migration's backfill
**disables `quotes_audit_cross_agent`** around its UPDATE — a migration has no
`auth.uid()`, so the trigger would otherwise log a `cross_agent_update` for
every quote in the table.

**Not on any hosted project yet**, like `brands`: applied to the local stack
only. The app code depends on it, so dev and prod need the migration pushed
before this code is deployed there.

**Two real foreign keys, NOT the polymorphic `owner_type` + `owner_id`** that
`notes`, `tasks` and `documents` use. Those three point at four tables and
carry no FK at all, which costs them three documented problems (a row filed
against an invisible owner, orphans on delete, `owner_type` required in every
query or ids collide). With two targets, one extra column buys all three back.

**The constraint is ORDINARY, not `NOT VALID`,** and that is a decision rather
than a default. `NOT VALID` is for a constraint added over data that predates
it — `documents_file_key_matches_owner` and `merchants_split_totals_100` both
carry it. Here the rows can be *proven* clean: `lead_id` was `not null` until
that migration and `merchant_id` was added by it, so `num_nonnulls` is exactly
1 for every pre-existing row by construction. Reaching for `NOT VALID` anyway
gives up the guarantee for nothing, and silently — it looks identical in the
schema. A test asserts `convalidated`.

**THE PRICE LOCK is `snapshot_quote_line_item()`, a BEFORE INSERT trigger, and
the hole it closes was real.** `grant select, insert on quote_line_items to
authenticated` plus an insert policy that only asks whether the parent quote is
the caller's means **a rep's own session can POST a line item with any
`unit_price` it likes, on their own quote, and every policy agrees.** The three
more obvious answers each fail for a specific reason worth knowing:

- **Hiding the field in the UI** is not a boundary at all.
- **A column-level grant** (`grant insert (quote_id, product_id, quantity,
  sort_order)`) is the right instinct — it is exactly what makes
  `quotes.status` the only mutable column, and the standing rule is that an
  immutable column is a grant and not a policy. It fails *here* because
  `create_quote_version()` is `security INVOKER`, so it inserts as the caller
  and would be refused its own snapshot. Making it `definer` to work around
  that trades a narrow problem for the broad one invoker exists to avoid.
- **Revoking INSERT outright** fails identically.

So the trigger **overwrites** all five snapshot columns from `products`,
whatever the caller supplied — it sits below every path to the table.
Overwrite rather than raise, because nothing legitimate ever supplies a price:
`unit_price` is a **derived** column that merely cannot be `generated always
as`, since that cannot reach another table. It is `security definer`, and
**not for reach** (every active user already reads every product) — it is
definer so the figure on a document cannot be changed by changing a *policy*.
Contrast `enforce_compatibility_kinds()`, which is invoker precisely because it
has no such claim to make. The RPC also snapshots, independently: two layers
reading the same table in the same transaction, the
`documents_file_key_matches_owner` / `fileKeyMatchesOwner()` arrangement again.

`enforce_quote_version()` now also **pins who a group is about**, which a CHECK
cannot express (it is a fact about a row's siblings). Reachable without it: the
RPC takes a group id and an owner as separate arguments, so a rep passing their
own group id with a different — also their own — record would add a "version 2"
about another business. Nothing leaks, but the print route filters by owner, so
one page would read "version 2 of 1" and the other "version 1 of 1".

**`create_quote_version()`'s old signatures are DROPPED, not left beside the
new one** — the 7-argument one in `20261007150000`, the 8-argument one (no
`customer_name_input`) in `20261009150000`; it now takes nine. `create or replace function` with a different parameter count
creates a *second* function, so a default on `merchant_id_input` would leave a
7-argument call with two candidates — an ambiguity Postgres reports at call
time, from the browser, as a failed save. The `dashboard_counts()` trap, same
answer, same assertion that the name resolves exactly once.

### The store, and what hides an archived product

`products` gained `brand`, `kind` (`device` | `addon`) and `billing`
(`one_time` | `monthly`), plus `product_compatibility (addon_product_id,
device_product_id)` — the **third** client-readable table with no `agent_id`,
which it inherits from its parents rather than choosing: a fact about two
catalog rows cannot be owned by a rep. The checklist therefore applies with
step 1 struck out, and **step 4's sequence grant refers to nothing** — the
pair is the primary key, so there is no `_id_seq`. A test asserts that absence,
so a future surrogate key cannot arrive without the missing grant being noticed.

`brand` is free text like `category`; `kind` and `billing` are **closed
vocabularies**, and the difference is who reads them. Those are labels a person
reads; these are read by *code* — the compatibility trigger, the store's device
list, the proposal's two totals — so an invented value is not a new label but a
row all three silently skip. **The store's "device type" filter is `category`**;
a second column for it would be the same fact twice.

`product_compatibility` **allows DELETE where `products` withholds it**, and
that is the one deliberate difference: a product is archived because
`quote_line_items` snapshots what it said, so the row is history, while a
compatibility row is a current-state claim nothing snapshots.

**WHAT HIDES AN ARCHIVED PRODUCT FROM A REP IS THE QUERY, NOT RLS.** The select
policy stays `is_active_agent() or is_admin()` with no row filter;
`lib/quotes-data.ts` carries `.is("archived_at", null)` plus `isQuotable`.
Three reasons: an admin must still see everything on `/admin/products` (a
policy would need a role branch, which is two policies wearing one name);
archiving is a **lifecycle state, not an access boundary** — `profiles.territory`'s
lesson, where wiring a label into a policy means changing the label changes who
can see what; and **a quote outlives the product on it**, so a policy hiding
archived rows would make a future join from a historical line come back empty
while looking perfectly correct. `tests/rls/product-compatibility.test.ts`
asserts a rep can still *read* an archived row, and greps both tables' policies
for the word. The database still refuses one twice over, by name in the RPC and
again in the trigger — a hidden row is a courtesy, a refused write is the
boundary.

**The cart's ORDER is the saved proposal's structure.** `cartToPayload()` emits
device, then that device's add-ons, then the next device;
`create_quote_version()` writes `sort_order` from the array's order; and
`groupQuoteLines()` reads the grouping back off `(sort_order, product_kind)`
and nothing else. Deliberately **not** a live join against
`product_compatibility` — that would make a sent proposal re-group itself when
an admin unlinks an accessory, a document changing shape after it was handed
over. `quote_line_items` snapshots `product_kind` and `product_billing` for
exactly that, and **neither carries a CHECK**: these are a record of what was
true when the quote was sent, so a value retired from the catalog's vocabulary
is correct history, and a constraint would turn that migration into one that
has to rewrite documents.

**`components/quote-store.tsx` is deliberately NOT on `ListTable`,** the app's
responsive list pattern. `ListTable` renders both layouts and hides one, and
its own header records the cost: a locator that does not consult the
accessibility tree matches the hidden copy too, and converting the payouts
ledger reddened nine `getByLabel` specs. The store is almost entirely form
controls, so it follows the same discipline with **one** rendered copy —
`flex-col sm:flex-row`, `min-w-0` on every text child, nothing in a scrolling
container. `e2e/quote-store.spec.ts` asserts `scrollWidth <= clientWidth` at
375/768/1440 rather than trusting the classes.

**Two totals, never summed** — one-time and monthly, on screen and on paper.
$1,497 of terminals and $29 a month are not the same unit, so a combined figure
is a number that means nothing and reads as a price. `isMonthlyBilling()` tests
*for* `'monthly'` rather than against `'one_time'`, so an unrecognised value
lands in the one-time total: a figure wrongly counted once is an understatement
a rep can see, while one wrongly counted as recurring quietly multiplies by
twelve.

### Brands: a table so a box can exist before its products

`/admin/products` is a grid of brand boxes, and each opens
`/admin/products/<brand id>` — a compact list (devices first) with an Add
product form and a per-row Edit. Unbranded products have
`/admin/products/unbranded`, shown on the grid only while any exist.

`brands` (`20261009120000`) is the **fourth** client-readable table with no
`agent_id`, same policies as `products` plus an admin DELETE. **The FK is on the
NAME:** `products.brand` stays text and references `brands(name)` `ON UPDATE
CASCADE ON DELETE RESTRICT`. That was the smallest design that changed no
reader — the store, `lib/quotes-data.ts` and the loader read the same text, and
no quote snapshots the brand — where a `brand_id` would have rewritten all of
them to join for a label they already held. Rename cascades in one statement;
delete is refused while **any** product names the brand, archived included
(`set null` would silently move them to the store's "Other" bucket). The
surrogate `id` exists only so the page URL survives a rename.
`idx_brands_name_lower` refuses "Square" beside "square". `tests/rls/brands.test.ts`
pins all of it, each assertion checked by reverting what it guards.

**Any fixture that writes `products.brand` must create the brand first** — the
two RLS catalog seeders and `ensureStoreCatalog()` in `e2e/fixtures/seed.ts`
now do. `brands` has no profiles reference, so like `products` it survives
`resetData()`; insert with `on conflict (name) do nothing`.

The add-on picker (`components/device-multi-select.tsx`) offers only the brand's
**live** devices and saves with the form; chips still show a link to a device
outside that set, so a stale link stays visible and removable.

**Not on any hosted project yet.** Applied to the local stack only
(`migration up --local`); dev and prod need a deliberate push.

### The printed Hardware Proposal is ONE component on ONE route

`/proposals/[quoteGroupId]/print` renders `QuoteProposalDocument`, fed by
`loadProposal()` in `lib/quote-proposal.ts`. The old
`/leads/[id]/quotes/[quoteGroupId]/print` and
`/merchants/[id]/quotes/[quoteGroupId]/print` are `redirects()` in
`next.config.ts` (query string kept, so `?quote=` still pins a version) rather
than page files: under `cacheComponents` a page that calls `redirect()` paints
its shell first. The loader flattens the two record tables into one shape (a lead has `dba` / `merchant_legal_name` and three contact
columns; a merchant has `dba` / `legal_business_name` and **no contact columns
at all**), which means the document has one set of fields and cannot quietly
omit one on one route. This is a sheet somebody is handed, so two near-copies
is the worst place in the app for a wording drift. **Four printable routes,
four documents** — the counts in `print-document.tsx` and `globals.css` say so.

**Nothing is invented on it.** `PROPOSAL_TERMS` is one constant and is **empty
by default**, so no terms block renders at all — not an empty heading, not
placeholder wording. Nothing in this repo knows Tapswipe's hardware terms, and
a wrong price is obvious where wrong terms are not. "Prepared by" prints only
what `profiles` actually has (`full_name`, `email`, `agent_number`) — there is
no phone column, so no phone is printed; and a merchant's contact line is
omitted rather than filled from its originating pre-app, because a contact
pulled from a two-year-old application is worse than none since it looks
current. The preparer is the **quote's own** `agent_id`, so an admin printing a
rep's proposal prints the rep's name.

**404 on everything, never 403** — and it matters more on the merchant route:
merchant ids are sequential and a rep knows their own, so "does merchant 41
exist" is exactly the question a distinguishable response would answer. Note
the e2e assertions are on the **rendered** not-found copy, not the status code:
under `cacheComponents` the static shell is flushed before the Suspense
boundary streams, so `notFound()` lands as **200** with not-found content in
the body. That is existing behaviour of every record page here, written up in
`e2e/print.spec.ts`.
