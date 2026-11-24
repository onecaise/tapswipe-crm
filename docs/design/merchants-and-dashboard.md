# Merchants list, merchant detail page, and the dashboard lead board

Design written 24 Nov 2026 on `master` (after `6d5bda6`). **Design only: no code, no migration, no
hosted project touched.** Build order, as the owner asked: (1) the merchants list, (2) the merchant
detail page, (3) the dashboard. The three are designed together so they share one set of functions,
one filter/URL style and one way of showing "who is paid" changes.

Read with: `CLAUDE.md` (security rules, the RLS + grants checklist, definer rules),
`docs/claude/payouts-and-teardown.md` (v3, replace, Mark paid, overrides, the teardown lists),
`docs/claude/rpcs-profiles-audit.md` (invoker vs definer, `log_cross_agent_change()`),
`docs/claude/security-fixes.md` phase 1 (merchants are admin-only to change),
`components/list-table.tsx` (the one responsive list), and `docs/design/override-funding.md` on the
unmerged `override-funding` branch.

---

## 0. What exists today (the facts this design rests on)

**Merchants.**

- `app/(app)/merchants/page.tsx` loads **every** merchant the caller can see in one query, ordered
  `date_added desc, id desc`, with a status `FilterTabs` row (`?status=`). Admins get an Agent column
  from a second `profiles` read. No sort, no paging, no search. Rendered with `ListTable`.
- Policies on `merchants` (since `20261021120000`): SELECT own-or-admin, INSERT/UPDATE/DELETE admin
  only. Grants are table-wide `insert, update` for `authenticated`; the policies alone keep reps out.
- **Owner, processor and status are changed today by the merchant form as a plain browser UPDATE**
  (`components/merchant-form.tsx`). No reason is asked for. The only trail is
  `log_cross_agent_change()` (`cross_agent_update`, which names who and which row but not what
  changed, and writes **nothing** when the admin happens to own the merchant) plus
  `merchants_mid_audit` for MID changes.
- The rate is written only by `set_merchant_split()` (definer, `is_admin()` first, audited,
  refused while a share is live or below a live override). `guard_merchant_split_and_owner()`
  refuses any other write of the rate, and refuses moving a merchant (`agent_id`) with a live share
  or a live override.
- `merchants.processor` is a foreign key to `processors(code)`.
- MIDs are text, 6-20 letters or digits since `20261106140000` (alphanumeric), unique on
  `mid_key(mid)`.
- Indexes on `merchants`: `agent_id`, `status`, `pre_app_id`, `norm_city(city)`,
  `mid_key(mid)` (unique). None on `date_added`, `dba`, `processor` or `split_agent_pct`.

**Merchant detail page** (`app/(app)/merchants/[id]/page.tsx`, 315 lines): one long page — a
13-field grid, the share notice (party) or share card (admin), the override card (admin), tasks,
notes, proposals. Sibling routes `edit/` and `print/` exist.

**Dashboard** (`app/(app)/dashboard/page.tsx`): greeting; the "Company overview" / "Your overview"
filter bar (`components/dashboard-filters.tsx`: Rep, Manager, Territory, Created from/to, a Lead
stage chip row) driving five `StatCard`s from the invoker `dashboard_counts()` (plus a sixth,
"Leads at <stage>", when a stage is picked); the user's own task digest; the admin's
missing-location callout; the city accounts search.

**Leads.status** (`20261002120000`): `not null default 'new'`, vocabulary CHECK
`leads_status_vocabulary` (**NOT VALID** — older rows may hold rep-typed strings), and
`leads_lost_reason_required` (lost needs a non-blank `lost_reason`, also NOT VALID). **No state
machine on purpose** (sales moves backwards). Changed by a plain client UPDATE under
`update own or admin` (`(agent_id = auth.uid() and is_active_agent()) or is_admin()`); the lead form
clears `lost_reason` when leaving `lost`. **Audit: only `log_cross_agent_change()`** — an admin
moving a rep's lead writes a `cross_agent_update` row; **a rep moving their own lead writes
nothing**, and no table records the old stage. `audit_log` is admin-SELECT-only.

**The unmerged `override-funding` branch** (`a6c61b9` … `6d31255`, migration `20261116120000`)
changes, among 45 files: `app/(app)/merchants/[id]/page.tsx` (the override card's loader gains
`loadOverrideMonths()` → `overrideMonthsById`), `components/merchant-override-card.tsx`,
`lib/overrides.ts`, `e2e/merchant-override.spec.ts`, `e2e/fixtures/seed.ts`,
`docs/tapswipe_crm_schema.sql`, `CLAUDE.md`, and `guard_merchant_split_and_owner()` (the move
refusal is kept for **any** live override, owner- or company-funded; only its wording changes).
See §5 for every collision.

---

## 1. Merchants list

### 1.1 What it looks like

```
Merchants                                        [Import merchants] [New merchant]
┌ Filters ─────────────────────────────────────────────────────────────────────┐
│ Status [All ▾]  Processor [All ▾]  Agent [All reps ▾]*  Split [ 0 ]–[ 50 ]     │
│ Added from [    ]  to [    ]     [Apply]   Clear filters                       │
└──────────────────────────────────────────────────────────────────────────────┘
312 merchants · showing 26–50                    Per page [25 ▾]   ‹ Prev  Next ›
┌──┬───────────────┬────────────┬────────┬──────────┬───────┬──────────┬───────────┐
│☐*│ DBA ▲         │ MID        │ Status │ Processor│ Split │ Agent*   │ Added     │
├──┼───────────────┼────────────┼────────┼──────────┼───────┼──────────┼───────────┤
│☐ │ Acme Pizza    │ 0004417…   │ active │ TSYS     │ 40%   │ J. Ortiz │ 12 Oct 26 │
…
[ 3 selected · Select all 312 matching ]  Assign agent · Change status · Processor · Export
(* admin only)
```

Below `lg` the same columns become `ListTable`'s cards; the checkbox is the card's `leading`
control; sort is a "Sort by" select above the cards (column headers do not exist on a card);
the bulk bar is a sticky bar at the bottom of the viewport.

### 1.2 Filters (all in the URL)

| Param | Meaning | Who | Parse rule (falls back to "no filter", as `parseDashboardFilters` does) |
| --- | --- | --- | --- |
| `status` | `active` / `inactive` / `other` | all | `MERCHANT_STATUSES`; kept as `?status=` so today's links still work |
| `processor` | a `processors.code`, or `none` for "Not set" | all | must be in the loaded processor list |
| `agent` | owner uuid | **admin** | uuid shape; a rep's value is ANDed with RLS and can only return their own rows or none, so the control is hidden for reps (the dashboard's reasoning) |
| `split_min`, `split_max` | inclusive range 0–50; `split=none` for "no rate" | all | numbers 0–50, at most 2 dp; a backwards range is dropped |
| `from`, `to` | `date_added` inclusive | all | ISO date; backwards dropped |
| `sort`, `dir` | see 1.3 | all (`agent` sort admin only) | whitelist |
| `size` | 25 / 50 / 100 | all | default 25 |
| `page` | 1-based | all | integer ≥ 1; past the last page shows the last page |

Rendered as a **plain GET form** (server component, works without JavaScript), exactly the shape of
today's dashboard filter bar, which this design retires from the dashboard (§3) — the
`FilterSelect` helper moves from `components/dashboard-filters.tsx` to a shared
`components/filter-select.tsx` rather than being copied. Changing a filter resets `page` to 1;
`sort`, `dir` and `size` ride along as hidden inputs. A one-click "Clear filters" link appears only
when something is narrowed.

### 1.3 Sorting

Clickable headers on `DBA`, `MID`, `Split`, `Agent` (admin) and `Added`.
Each header is a **link** to the same URL with `sort`/`dir` changed and `page=1`; clicking the active
column flips direction. The `<th>` carries `aria-sort="ascending" | "descending"` on the active
column only (and nothing on the others, which is what ARIA asks for), and an icon (`ArrowUp` /
`ArrowDown` from lucide; `ArrowUpDown` muted on inactive sortable headers). The link's accessible
name is "Sort by DBA, A to Z" / "… Z to A".

| `sort` | Order by | Default `dir` | Note |
| --- | --- | --- | --- |
| `added` (default) | `date_added`, nulls last | desc (newest) | today's order |
| `dba` | `lower(dba)` | asc | case-insensitive: the database collation would otherwise put "Zeta" before "acme" |
| `mid` | `mid_key(mid)`, nulls last | asc | **Lexicographic, decided.** MIDs are alphanumeric since `20261106140000`, so a numeric order does not exist for them; text order also keeps leading zeros meaningful (`0004417` sorts with other `000…`). Same key the unique index and v3 match on. |
| `split` | `split_agent_pct`, nulls last | desc (high first) | |
| `agent` | `lower(owner name)` | asc | admin only; a rep's book has one owner |

**Stable tiebreak: every order ends with `id` in the same direction as the primary key's default
(`id desc`)**, so two merchants added on the same day, or with the same rate, never swap between
page loads, and offset pages never repeat or skip a row on an unchanged table. Status is not
sortable (three values; the filter does that job).

### 1.4 How the page is read: a `security_invoker` view, server-side `range` and `count`

Sorting by owner name is the one thing the current two-query shape cannot do server-side. Options:

1. **A view `merchant_list` with `security_invoker = true`** (recommended):
   ```sql
   create view merchant_list with (security_invoker = true) as
   select m.id, m.agent_id, m.mid, m.dba, m.legal_business_name, m.status, m.processor,
          m.split_agent_pct, m.date_added, m.city, m.state,
          p.full_name            as agent_name,
          lower(m.dba)           as dba_sort,
          mid_key(m.mid)         as mid_sort,
          lower(p.full_name)     as agent_sort
     from merchants m
     left join profiles p on p.id = m.agent_id;
   ```
   Invoker means **both tables' own RLS applies to the caller**: an admin sees every merchant and
   every owner name; a rep sees their own merchants and their own profile (the only profile row
   their policy admits), so nothing new is visible. PostgREST then gives filters, `order`,
   `range()` and `count` with no hand-written SQL. Grants: `grant select on merchant_list to
   authenticated`; nothing to `anon`; nothing else (a view is not writable here).
2. An invoker RPC `merchant_list_page(filters…, sort, dir, limit, offset)` returning `{total, rows}`.
   Equivalent security, but the sort whitelist becomes dynamic SQL (`format('%I')`) — more to get
   wrong for no gain.

**The danger of option 1 is a view created without `security_invoker`**: Postgres views run as
their owner by default, which bypasses RLS and would hand every rep the whole company's merchants.
So the migration states it, and `tests/rls/merchant-list-view.test.ts` asserts
`pg_class.reloptions` contains `security_invoker=true` **and** a rep reads only their own rows
through it (with a mutation proof: recreated without the option, the rep test goes red).

**The count.** `select(..., { count: "exact" })` with `.range(offset, offset + size - 1)`: one
request returns the page and the total of the *filtered* set. Cost: Postgres counts every row
matching the filters (and the RLS predicate) on **every page load** — linear in the matching rows,
not in the page size. Today's table is in the low thousands, where that is a few milliseconds.
It stays fine to roughly 50–100k merchants; past that, switch to `count: "planned"` (the planner's
estimate, shown as "about 120,000") — a one-word change in `lib/merchants-data.ts`. Paging is
**offset**, not keyset, because the owner asked for a total and page numbers; offset's cost
(skipping rows) is irrelevant at this size.

**Indexes added** (same migration): `(date_added desc, id desc)` for the default page, and
`(processor)`. Not added: `lower(dba)`, `split_agent_pct` — at this size a sort of the filtered set
in memory is cheaper than the write cost of more indexes; revisit with the count switch.

### 1.5 Bulk actions (admin only)

#### Selection

- A checkbox per row (`leading` column — the `/tasks` pattern) and a header checkbox for "this page".
- When the whole page is selected, the bar offers **"Select all 312 matching the filters"**. That
  selects the **filter**, not 312 ids in the browser: the action sends the current filter params,
  and the server resolves them to ids **at preview time** (§1.5.3). The preview then lists exactly
  those merchants, and the apply step sends **the previewed ids**, never the filter again — so a
  merchant that starts matching between preview and apply is not silently included.
- **Maximum batch: 200 merchants per request** (decision 4). "Select all N matching" with N > 200
  is shown disabled: "312 match. Narrow the filters to 200 or fewer to act on them together."
  No automatic chunking: chunks would make one admin action several partly-applied requests,
  which is exactly what all-or-nothing forbids.
- Selection is page state (a client context around the list); it clears on a filter or page change,
  and the bar says so.

#### The four actions

| Action | Changes who is paid? | Confirmation | Function |
| --- | --- | --- | --- |
| **Assign agent** (move to another rep's book) | **Yes** | preview + written reason | new `move_merchants()` |
| **Update processor** | Yes, indirectly (which file the MID is expected on) | preview + written reason | new `set_merchants_processor()` |
| **Change status** | No | a confirm ("Set 14 merchants to inactive?") | new `set_merchants_status()` |
| **Export selected** | No | a confirm | new `export_merchants()` |

#### 1.5.3 The preview-and-apply shape (assign agent, processor)

One function per action, called twice: `apply => false` (preview: decides, writes nothing) then
`apply => true` (re-decides everything under locks, then writes all or nothing). **The rules exist
once**, inside the function — the `share_correction_posting_period()` lesson — so the preview can
never disagree with the apply.

```
move_merchants(merchant_ids int[], to_agent_id uuid, reason text,
               expected jsonb default null, apply boolean default false) returns jsonb
set_merchants_processor(merchant_ids int[], processor_code text, reason text,
                        expected jsonb default null, apply boolean default false) returns jsonb
```

- `security definer`, `set search_path = public, pg_temp`, **`is_admin()` first** (PT403), then
  `revoke all … from public; grant execute … to authenticated, service_role;` in the same migration.
  Definer because both must call `merchant_has_live_share()` / `merchant_has_live_override()`
  (no client EXECUTE) and write `audit_log` (no insert policy).
- Arguments: 1–200 distinct ids (22023 otherwise); `reason` 10–500 characters after trim (the
  Reopen rule; 22023). `expected` is required when `apply` is true: `{"<merchant id>": "<owner
  uuid or processor code at preview>"}` from the preview's result.
- **Locks, in this order** (the order every money function already uses): the share advisory lock
  `hashtext('tapswipe.merchant_rep_shares')`, then `select … from merchants where id = any(ids)
  order by id for update`.
- **Result** (`jsonb`): one entry per merchant, in id order:
  `{merchant_id, dba, mid, from, to, outcome: "changes" | "unchanged" | "refused", code, message,
  awaiting_commit}`, plus totals `{changes, unchanged, refused}`.
- **Apply is all or nothing.** If any merchant is `refused`, or any `expected` value no longer
  matches (`code = "changed_since_preview"`), it raises **PT409** with the refused list in the
  message/DETAIL and writes nothing. The dialog then offers **"Continue with the 12 that can
  change"**, which re-runs the preview on just those ids. `unchanged` merchants are skipped, not
  refused, and write nothing.
- **Audit, fail closed, no exception handler:** one `audit_log` row per changed merchant —
  `action = 'move_merchant'` / `'set_merchant_processor'`, `table_name = 'merchants'`,
  `row_id = merchant id`, `detail` = `from → to · reason` (the `detail` column exists since
  `20261030190000`, ≤ 1000 characters, which the 500-character reason plus two codes fits). The
  owner change also fires `log_cross_agent_change()` (a second, coarser row — the documented
  "deliberate duplication"; tests assert on `action`, not row counts).
- **Refusals — assign agent** (`code`): `live_share` ("has a shared-account split; end it first"),
  `live_override` ("has an override; end it first" — **any** override, owner- or company-funded,
  matching the override-funding branch's guard), `target_inactive` / `target_not_found`
  (`to_agent_id` must be an active profile; the house profile is allowed), `not_found`. The
  `guard_merchant_split_and_owner()` trigger still runs underneath and refuses the same two cases,
  so the function's check is the courtesy that names them all at once and the trigger is the
  backstop.
- **Refusals — processor**: `unknown_processor` (the FK would refuse; the function says so first),
  `not_found`. Setting "Not set" (NULL) is allowed.
- **`awaiting_commit` (a warning, not a refusal):** the merchant's `mid_key` appears in
  `rep_payout_import_rows` of a batch still in `review`. For a move: v3 refuses a row whose
  owner changed after the read ("Read it again"), so that file must be read again. For a
  processor change: v3 will raise `processor_mismatch` and ask for confirmation.

**The dialog** (one component, `components/merchant-bulk-dialog.tsx`, used by the list and by the
detail page's Admin menu with a single id):

```
Move 14 merchants to Jordan Ortiz
  12 will move · 2 refused
  ✓ Acme Pizza   0004417…   from Sam Lee
  …
  ✕ Bob's Deli   7781…      Has an override. End it before moving the merchant.
  ✕ Cafe Uno     9910…      Has a shared-account split. End it before moving the merchant.
  ⚠ 3 of these are in a residual file waiting to be committed (TSYS October 2026); that file
    must be read again before it can be committed.

  What this changes
  • From the next residual month committed, these merchants' residuals are paid to Jordan Ortiz
    at each merchant's own rate (unchanged).
  • Months already committed do not change. A committed month changes only if it is replaced,
    and a replace pays the WHOLE month again from the owners and rates at that moment — so
    replacing September after this move pays September to Jordan Ortiz.
  • Months marked paid never change; a correction there is an adjustment line.

  Reason (required, 10–500 characters)  [______________________________]
                     [Cancel]   [Continue with the 12 that can move]
```

The processor dialog reads the same, with its own effect text: "Residual files are matched to
merchants by MID, not by processor. Changing the processor changes which processor's file is
expected to carry this MID: a file from another processor will ask you to confirm a processor
mismatch. It does not change the rate or who is paid. Committed months are unchanged until
replaced." (It is still treated as a payroll change, as the owner asked: preview, reason, audit.)

#### Status and export

- `set_merchants_status(merchant_ids int[], status_input text) returns int` — definer,
  `is_admin()` first, ≤ 200 ids, one UPDATE (atomic), one `set_merchant_status` audit row per
  changed merchant with `detail = 'old → new'`, returns the count changed. Why a function rather
  than a client `update().in('id', ids)`: the client update is atomic too, but it cannot write an
  audit row when the admin owns the merchant, and a count mismatch after the fact cannot be rolled
  back from the browser.
- `export_merchants(merchant_ids int[]) returns setof jsonb` — definer, `is_admin()` first,
  ≤ 1000 ids (an export reads, it does not move money; decision 4), writes **one** audit row
  (`export_merchants`, `detail` = the count) **before** returning rows, failing closed — the
  `export-report` rule. Columns: DBA, legal name, MID (text), status, processor, rate, company
  rate, owner name, owner agent code, city, state, street, ZIP, date added. Nothing secret lives on
  `merchants`. The browser builds a **CSV** (decision 6) with the formula-injection guard from
  `supabase/functions/_shared/report-sheets.ts` (a text starting `= + - @`, tab or CR gets a
  leading `'`) — reused through a small exported helper, not copied, the way `lib/reports.ts`
  re-exports from `_shared`. No SheetJS in the browser bundle.

#### Other single-merchant admin actions that could be offered in bulk

| Exists today for one merchant | In bulk? | Why |
| --- | --- | --- |
| Edit details (DBA, legal name, MID, location) | **No** | Per-record by nature; a bulk MID edit is the pad-and-restore attack shape |
| Owner (merchant form) | **Yes** — "Assign agent" | asked for |
| Processor (merchant form) | **Yes** | asked for |
| Status (merchant form) | **Yes** | asked for |
| Rate (`set_merchant_split`) | **Not in this build; offer later** (decision 5) | It is an existing power, but a bulk rate change is a payroll change across many books at once; if wanted, it is a fifth preview-and-apply function calling the same rules (refused under a live share, or below a live override) |
| Shared account (`set_/end_/cancel_merchant_rep_share`) | **No** | Each share names two people and a split that totals that merchant's rate; not a list action |
| Override (`set_/end_/cancel_merchant_override`, funding switch on the branch) | **No** | Same reason, and the override-funding rules are per override |
| Print | **No** | |
| Delete (an admin DELETE policy exists; no UI offers it) | **No** | Not offered anywhere today; a merchant has payroll history (`RESTRICT` FKs) |

No new financial power is introduced: every bulk action is an existing single-merchant power with
an audit row and a reason added.

### 1.6 Schema, RLS, grants, teardown — merchants list

- **Migration A (phase 1a):** view `merchant_list` (`security_invoker = true`), `grant select …
  to authenticated`, two indexes. **No table, so no RLS, no `profiles` FK, teardown lists
  unchanged.**
- **Migration B (phase 1b):** `set_merchants_status()`, `export_merchants()` with their
  revoke/grant lines.
- **Migration C (phase 1c):** `move_merchants()`, `set_merchants_processor()` with their
  revoke/grant lines.
- `docs/tapswipe_crm_schema.sql` first, then the migrations (the standing rule).
- No policy changes. No grant changes on `merchants`. **Recommended follow-up (decision 7, phase
  2d):** once the Admin menu and bulk bar are the only owner/processor writers, take `agent_id`
  and `processor` out of the merchant form and make them a **grant**, not a policy: revoke
  table-wide UPDATE on `merchants` from `authenticated` and grant UPDATE on the remaining form
  columns only (`dba, legal_business_name, mid, status, street, city, state, zip`). Then a moved
  merchant always has a reason in the trail. `approve_pre_app`, `commit_merchant_import` and
  `set_merchant_split` are definer and unaffected; the missing-location screen writes only
  location columns.

---

## 2. Merchant detail page

### 2.1 Tabs as routes

Each tab is a **route segment** under a shared layout, so a link opens a tab, Back works, and each
tab loads only its own data (today the page loads notes, tasks, proposals, shares, overrides and
the ledger on every visit):

```
app/(app)/merchants/[id]/layout.tsx       header + tab bar (reads the merchant once; 404 if RLS hides it)
app/(app)/merchants/[id]/page.tsx          Overview
app/(app)/merchants/[id]/pricing/page.tsx  Pricing and split
app/(app)/merchants/[id]/overrides/page.tsx  Overrides          (admin; 404 for anyone else)
app/(app)/merchants/[id]/residuals/page.tsx  Residuals and payouts
app/(app)/merchants/[id]/tickets/page.tsx    Support tickets
app/(app)/merchants/[id]/notes/page.tsx      Notes and tasks
app/(app)/merchants/[id]/proposals/page.tsx  Proposals
app/(app)/merchants/[id]/activity/page.tsx   Activity          (admin; 404 for anyone else)
app/(app)/merchants/[id]/edit/   print/      unchanged — print renders outside the tab layout
                                             (it needs its own route group or the layout skips
                                             the tab bar for it; checked at build time)
```

The tab bar is a `<nav aria-label="Merchant sections">` of **links** with `aria-current="page"` on
the active one — not an ARIA `tablist`, because each tab is a navigation, and a `tablist` promises
arrow-key behaviour and in-page panels that a link bar does not have. On a phone it scrolls
horizontally (snap, the active tab scrolled into view, 44px tall); on `lg` it is a row under the
header. Tabs a role cannot use are **absent**, not disabled, and their routes 404 (never 403) for
that role, by the same rule as print routes.

`cacheComponents: true` means the layout's merchant read and each tab's reads sit inside
`<Suspense>`; `params` is passed down unawaited as the current page does. Read
`node_modules/next/dist/docs/` on layouts and `params` before building (CLAUDE.md's Next 16 note).

### 2.2 What each tab shows

**Header (every tab):** DBA, status badge, MID, processor, the merchant's rate ("Rep 40% ·
Company 60%"), owner name (admin) — plus, for admins, the **Admin** menu (§2.3) and Print.

| Tab | Rep sees (exactly what RLS shows today) | Admin sees |
| --- | --- | --- |
| **Overview** | Legal name, MID, location (street, city/state, ZIP), processor, date added, last updated, "Approved from Pre-app #n" link, the share notice when they are a party (`my_share_partners()`, unchanged), "To change this merchant, contact an admin." | Same + owner; "Not recorded — edit to add" for a missing location |
| **Pricing and split** | Agent split and company split, read-only; the share notice | `MerchantSplitCell` (unchanged write path, `set_merchant_split`) with the effect text (§2.4); the share card (`MerchantShareCard`, unchanged) |
| **Overrides** | — (tab absent; route 404s). Unchanged rule: a rep's page says nothing about overrides; they read their own debit, and who receives it, on their statement | `MerchantOverrideCard`, **as it is** (§2.5) |
| **Residuals and payouts** | Their **own** ledger lines for this MID — committed import lines, and their own override debit lines labelled exactly as the statement labels them (`overrideLineLabel()`, via `my_override_recipients()`). A company-funded override has no debit line, so the owner sees nothing of it, as on the statement. No paid/unpaid state (that table is admin-only). (Decision 8.) | Every line for the MID, committed batches only, with month, processor, line kind, volume, residual, rate, payout, override and adjustment lines, the share pair, and each processor-month's paid state; links to `/payouts/[period]` |
| **Support tickets** | Their own tickets with `merchant_id` = this merchant, and "New ticket for this merchant" (the ticket form already has a merchant select; prefilled via a query param) | All tickets for the merchant |
| **Notes and tasks** | `TasksPanel` + `NotesPanel`, unchanged | Same |
| **Proposals** | `RecordProposals`, unchanged | Same |
| **Activity** | — (tab absent: `audit_log` is admin-only, so a rep's tab would always be empty — a broken control) | `audit_log` rows for `('merchants', id)` (moves, processor and status changes with their reasons, rate changes, MID changes, cross-agent edits) plus the merchant's share and override audit rows, matched on the `(table_name, row_id)` **pair** (the lead-timeline rule), in a total order (instant, then id) |
| **Documents** | **Not proposed.** There are no per-merchant documents: the Document Center is a company library and the legacy `documents` table is closed and must stay closed. Revisit if per-merchant files are ever designed. | — |

The override **recipient** still sees only the merchant's name, as text, on their statement: they
cannot open this page (RLS → 404), and nothing here changes that.

### 2.3 The Admin menu

A `DropdownMenu` (`components/ui/dropdown-menu.tsx` exists) labelled **Admin** in the header:

| Item | Does | Write path |
| --- | --- | --- |
| Edit details | → `/merchants/[id]/edit` (existing form) | existing |
| Change status | confirm dialog | new `set_merchants_status([id], …)` |
| Change processor | preview + reason dialog (§1.5.3), one merchant | new `set_merchants_processor([id], …)` |
| Move to another rep | preview + reason dialog, one merchant | new `move_merchants([id], …)` |
| Set rate | → Pricing tab, focuses the Split control | existing `set_merchant_split()` |
| Shared account | → Pricing tab | existing share RPCs |
| Overrides | → Overrides tab | existing override RPCs (and, after the branch, `set_merchant_override_funding()`) |

**No new functions beyond §1's four.** The single-merchant actions are the bulk functions with one
id, so there is one rule set and one audit vocabulary.

### 2.4 Every financial edit shows its effect

- **Rate** (Pricing tab, around the unchanged `MerchantSplitCell`): "On a $100 residual: the rep
  side gets $40.00, the company $60.00. Applies from the next month committed. Committed months
  are unchanged until replaced; a replace pays the whole month again at the rate at that moment.
  Months marked paid never change." Plus, when a live override exists, its percent ("an override
  of 5% comes out of this rate" / "…out of the company's share" once funding lands).
- **Move / processor:** the dialog text in §1.5.3.
- **Share and override:** their cards already show worked examples and posting months; unchanged.

### 2.5 Hosting the override card as it is

`components/merchant-override-card.tsx` is **not edited**. The Overrides tab's `page.tsx` builds
exactly the props today's `loadShareCard()` builds for it (`merchantId, mid, rate, ownerId,
defaultRecipientId, overrides, reps, latestCommitted, currentPeriod`) — and, once
`override-funding` is merged, also `overrideMonthsById` from `loadOverrideMonths()`, as the
branch's three-line change to the detail page does. To keep that a move rather than a rewrite,
`loadShareCard()` moves **verbatim** from `app/(app)/merchants/[id]/page.tsx` to
`lib/merchant-detail-data.ts`, called by both the Pricing tab (share props) and the Overrides tab
(override props). **Build phase 2 after `override-funding` is merged** (decision 1); if it is not,
the phase must re-apply the branch's `loadOverrideMonths` lines by hand at merge time.

### 2.6 Schema, RLS, grants, teardown — detail page

**None** for 2a–2c: every read is through existing policies (`rep_payout_rows` own-or-admin,
`support_tickets` own-or-admin, `audit_log` admin, `payout_period_closures` admin), and every write
through §1's functions or existing RPCs. Phase 2d (decision 7) is a grant change on `merchants`.

---

## 3. Dashboard: the lead board

### 3.1 What it looks like

```
Welcome back, Owen  [admin]
┌ Ghost sheets 41 ┬ Unconverted leads 118 ┬ Pre-apps 22 ┬ Active merchants 312 ┬ Open tickets 3 ┐  (compact strip)
Leads                                   Rep [All reps ▾]*     4 leads need a stage → review
┌ New (37) ──┬ Contacted (21) ┬ Qualified (9) ┬ Proposal sent (6) ┬ Application sent (4) ┬ Nurturing (12) ┬ Lost (29) ┐
│ Acme Pizza │ …              │               │                   │                      │                │           │
│ J. Smith   │                │               │                   │                      │                │           │
│ Follow up  │                │               │                   │                      │                │           │
│ 2 Dec  [⋯] │                │               │                   │                      │                │           │
│ …          │                │               │                   │                      │                │           │
│ Show 17 more│               │               │                   │                      │                │           │
└────────────┴────────────────┴───────────────┴───────────────────┴──────────────────────┴────────────────┴───────────┘
Your tasks …            (unchanged)
Missing-location callout (admin, unchanged) · City accounts search (unchanged)
```

Card: DBA (link to the lead), contact name, next follow-up (destructive text when overdue, the
`/tasks` treatment), rep name (admin, all-reps view only), and a **"Move to…"** menu button. No
colour on the card beyond that; stage colour stays on badges only (design system).

### 3.2 What is removed, and what is kept

- **Removed:** the filter bar (`components/dashboard-filters.tsx`: Manager, Territory, Created
  from/to, the stage chips) and the conditional "Leads at <stage>" card — the board's column counts
  replace it.
- **Kept as a compact strip:** the five `dashboard_counts()` figures (ghost sheets, unconverted
  leads, pre-apps, active merchants, open tickets — open tickets still the one accent), as a single
  row of small stat tiles (`StatCard` gains a `compact` size; five across from `sm`, a 2-column grid
  on a phone). For an admin they follow the board's rep filter (`agent_id_input`); the other four
  arguments are sent as NULL. **`dashboard_counts()` is unchanged** (its parameters stay; nothing
  sends them now), so `tests/rls/dashboard-filters.test.ts` stays green and must not be deleted.
- **Lost:** manager and territory slicing, and date-range counts, from the dashboard. If the owner
  still wants them, they belong on `/admin/reports` as a later item (decision 10).
- Kept unchanged: the task digest ("Your own work" note re-worded: "Not affected by the rep filter
  above"), the missing-location callout, the city accounts search.

### 3.3 Data: counts and cards, server-side

- **Column counts:** a new **invoker** function
  `lead_board_counts(agent_id_input uuid default null) returns table(status text, n bigint)` —
  `security invoker`, `set search_path = public, pg_temp`, revoke/grant lines, grouped by status
  with every out-of-vocabulary status folded into one `needs_review` bucket. Invoker, so the
  caller's RLS scopes it (a rep's `agent_id_input` naming someone else returns zeros — the
  `dashboard_counts()` property). `tests/rls/lead-board.test.ts` asserts `prosecdef` false.
  (PostgREST aggregate selects are off by default on Supabase, and seven `head: true` counts are seven snapshots
  that can disagree.)
- **Cards:** **20 per column** on first load (decision 11), seven parallel reads of `leads`
  (`id, agent_id, dba, contact_name, next_followup_date, status, updated_at`) — the same order the
  leads list uses: `next_followup_date asc nulls last, id desc`. "Show N more" fetches the next 20
  for that column only, offset-based, deduplicated by id (a move between fetches shifts offsets by
  one; dedupe makes that harmless).
- **Rep filter (admin):** `?rep=<uuid>` (the existing `parseDashboardFilters` uuid rule), a
  `FilterSelect` of active reps above the board, applied to the counts, the cards and the strip.
  Reps get no filter; RLS already makes it their own leads. No agent filter in application code for
  a rep (the standing rule).
- **Leads outside the vocabulary** (the NOT VALID rows) are not on the board: there is no column
  they could be dropped back into. A line above the board says "4 leads need a stage — review" and
  links to `/leads`, where the form already shows them as "needs review". Zero renders nothing.

### 3.4 How a stage change is stored, validated and audited

**Stored exactly as today: `leads.status` (and `lost_reason`) via the existing client UPDATE.** No
new write path, no new function (decision 9 covers history):

```ts
supabase.from("leads")
  .update({ status: to, lost_reason: to === "lost" ? reason : null }, { count: "exact" })
  .eq("id", leadId)
  .eq("status", from)            // optimistic concurrency: only if nobody moved it meanwhile
```

- **Validation stays in the database:** `leads_status_vocabulary` refuses an unknown stage,
  `leads_lost_reason_required` refuses Lost without a reason, `update own or admin` refuses
  someone else's lead and a deactivated rep. The board adds nothing the database does not enforce.
- **Lost asks for a reason first.** Dropping (or choosing) Lost opens a small dialog ("Why was it
  lost?", required, non-blank); Cancel puts the card back. Moving out of Lost clears `lost_reason`,
  as the lead form does today.
- **`count === 0`** means the lead changed or vanished since the board loaded: roll back and say
  "This lead was changed elsewhere. The board has been refreshed." then `router.refresh()`.
- **Audit:** unchanged — an admin moving a rep's lead gets the `cross_agent_update` row from
  `log_cross_agent_change()`; **a rep moving their own lead leaves no trail**, exactly as editing
  the stage in the lead form does today. Dragging makes stage changes easier, so the owner should
  decide whether that is still acceptable (decision 9): the alternative is a `lead_stage_changes`
  history table (see 3.7).
- **`application_sent` is only a stage.** Dropping a card there does not create a pre-app; the win
  is still derived from a pre-app or merchant, as `lib/leads.ts` insists.

### 3.5 Drag and drop: the approach

**Recommended: `@dnd-kit/core`** (one new dependency, pinned to an exact version at least two
weeks old, `npm audit` clean, decision 2). Native HTML5 drag-and-drop was considered and rejected:
it has **no touch support** on iOS/iPadOS Safari for this use (no `dragstart` from a finger in a
page like this), no keyboard model, and no screen-reader announcements — the three things the owner
named. `@dnd-kit/core` provides pointer, **touch** and **keyboard** sensors and live-region
announcements, works with React 19, and needs no DOM reordering (`@dnd-kit/sortable` is **not**
needed: there is no order within a column, because `leads` has no position column and the column is
sorted by follow-up date).

| Device | Behaviour |
| --- | --- |
| **Laptop** (≥ `lg`) | Seven columns in a row, horizontal scroll inside the board when they do not fit (240px columns); mouse drag (`PointerSensor`, 5px activation distance so a click on the DBA link still navigates); auto-scroll near the edges |
| **iPad** (`md`–`lg`, portrait content ≈ 464px with the pinned sidebar) | Same board, horizontal scroll-snap per column; **touch drag after a 250ms long-press** (`TouchSensor`, delay 250, tolerance 8) so a normal swipe still scrolls the board; "Move to…" on every card |
| **Phone** (< `md`) | **No dragging.** One column at a time: a scrolling row of stage chips with counts (`New 37 · Contacted 21 …`) selects the column (`?stage=` in the URL, so Back works); each card has "Move to…". Dragging across seven off-screen columns on a 343px screen is not usable, and a long-press drag fights page scroll |

**Keyboard and menu alternatives (everyone, every size):**

- **"Move to…"** — a `DropdownMenu` button on each card (accessible name "Move Acme Pizza to…"),
  listing the six other stages. This is the primary accessible path and the phone path.
- **Keyboard drag** (`KeyboardSensor`): focus a card's drag handle, Space to pick up, ←/→ to move
  between columns, Space to drop, Escape to cancel. Custom announcements: "Picked up Acme Pizza
  from Contacted. Use the arrow keys to choose a stage." / "Moved Acme Pizza to Qualified." /
  "Move cancelled; Acme Pizza is still in Contacted."
- Each column is a `<section aria-labelledby>` whose heading carries its count; the cards are a
  list. After a move, focus stays on the moved card in its new column.
- One polite `aria-live` region reports results and failures ("Could not move Acme Pizza: … It is
  back in Contacted."). `prefers-reduced-motion` turns off the drop animation.
- Touch targets 44px (the app's rule since phases 6–7).

### 3.6 Optimistic update and rollback

A small reducer (`lib/lead-board.ts`, pure, unit-tested) holds `{columns, counts}`:
`move(lead, from, to)` removes the card, inserts it in the target column at its sorted position,
and adjusts both counts; `rollback(snapshot)` restores. On drop: snapshot → apply → UPDATE (§3.4)
→ on error or `count === 0`, rollback + live-region message (using the supabase error's own text
for a PostgREST error; Edge Function errors are not involved) → on success, nothing (no refetch;
`router.refresh()` only on the stale case). One move in flight per card; a second drag of the same
card waits.

### 3.7 Optional: a stage history (decision 9)

If the owner wants every stage change recorded (who, from, to, when — reps included), add
`lead_stage_changes(id, lead_id → leads on delete cascade, agent_id → profiles not null, from_status,
to_status, changed_by → profiles, changed_at)` written by an AFTER UPDATE OF status trigger on
`leads` (definer, fail closed). That is a **new table** and therefore the full checklist: RLS on,
four policies (select own-or-admin; no client insert/update/delete — the trigger writes), grants
(`select` to `authenticated`, `all` to `service_role`), `log_cross_agent_change()` is not needed
(the table is itself the log), **two new `profiles` FKs → 28**, so `tests/rls/user-imports.test.ts`
and **all four teardown lists** (`scripts/seed-local-users.mjs`, `tests/live/helpers/stack.ts`,
`e2e/fixtures/seed.ts`, `seed-dev-local.mjs`) change together, and `scripts/reset-business-data.sql`
must list it in `clear_tables`. The lead timeline could then show stage changes to the rep too.
**Recommended: not in this build** — ship the board, then decide with real use.

### 3.8 Schema, RLS, grants, teardown — dashboard

- **Migration D (phase 3a):** `lead_board_counts()` (invoker) + revoke/grant. No table, no policy,
  no grant on a table; teardown lists unchanged.
- Optional migration E (3.7) as above.

---

## 4. Files, tests, and build phases

### 4.1 Files that change

**Phase 1a — list: paging, sorting, filters**
- `docs/tapswipe_crm_schema.sql` (the view, indexes) → `supabase/migrations/<ts>_merchant_list_view.sql`
- `app/(app)/merchants/page.tsx` (rewritten around the view, `range`, `count`)
- `lib/merchants.ts` (param parsing: `parseMerchantListParams`, `merchantListHref`, sort whitelist,
  page sizes) and new `lib/merchants-data.ts` (the query)
- `components/list-table.tsx` — **additive**: optional `sort?: { key, label, href, active?: "asc" |
  "desc" }` per column rendering the header link + `aria-sort` on the `<th>`; nothing else changes
  for the existing callers
- new `components/filter-select.tsx` (moved out of `dashboard-filters.tsx`), new
  `components/merchant-filters.tsx`, new `components/list-pagination.tsx` (count, prev/next, size)
- `docs/claude/grants-inventory.md` (the view's grant)

**Phase 1b — bulk status + export**: migration B; new `components/merchant-bulk-bar.tsx` (client:
selection context, sticky bar), `components/merchant-bulk-dialog.tsx` (status/export confirm),
`lib/csv.ts` (CSV writer using the `_shared/report-sheets.ts` injection helper — a small export
added there, which is a change to a `_shared` file; `report-sheets` tests must stay green).

**Phase 1c — bulk assign agent + processor**: migration C; `merchant-bulk-dialog.tsx` gains the
preview/reason mode; `lib/merchant-bulk.ts` (types, the effect texts, and the mapping of a PT409
DETAIL to per-merchant messages).

**Phase 2a — detail tabs** (after `override-funding` merges): new `app/(app)/merchants/[id]/layout.tsx`
and the seven tab `page.tsx` files; `app/(app)/merchants/[id]/page.tsx` shrinks to Overview; new
`lib/merchant-detail-data.ts` (the moved `loadShareCard()`); new `components/merchant-tabs.tsx`.
`components/merchant-override-card.tsx`, `merchant-share-card.tsx`, `notes-panel.tsx`,
`tasks-panel.tsx`, `record-proposals.tsx`: **unchanged**.

**Phase 2b — Admin menu + effect text**: new `components/merchant-admin-menu.tsx`; the Pricing tab
wraps `MerchantSplitCell` with the effect text (the cell itself unchanged).

**Phase 2c — Residuals and Activity tabs**: `lib/merchant-ledger.ts` (reads), the two pages.

**Phase 2d (decision 7)** — migration: column UPDATE grants on `merchants`;
`components/merchant-form.tsx` stops sending `agent_id` / `processor` on edit (it keeps the owner
picker on **create**, which is an INSERT); `tests/rls/merchants-admin-only-writes.test.ts`.

**Phase 3a — board, read-only + strip**: migration D; `app/(app)/dashboard/page.tsx`;
`components/dashboard-filters.tsx` → deleted (its `FilterSelect` already moved in 1a);
`lib/dashboard.ts` (only `rep` survives in the parser; `dashboardCountArgs` keeps its shape with
NULLs); new `components/lead-board.tsx` (server shell) and `lib/lead-board.ts`;
`components/stat-card.tsx` (`compact`).

**Phase 3b — moving cards**: `package.json` / lockfile (`@dnd-kit/core` exact pin);
`components/lead-board-client.tsx` (client: sensors, announcements, reducer wiring, Move to…,
Lost dialog).

**Docs, every phase:** the phase's lines in `docs/claude/project-state.md`; `CLAUDE.md` only where a
rule changes (the new definer functions in the security summary; test baselines; the docs index
line for this file).

### 4.2 Tests to add

| Suite | Phase | What |
| --- | --- | --- |
| **rls** `merchant-list-view.test.ts` | 1a | `security_invoker=true` in reloptions; rep sees only own rows and only own `agent_name`; admin sees all; `anon` has no grant; mutation proof (view without the option → rep test red) |
| **rls** `merchant-bulk.test.ts` | 1b, 1c | each function: PT403 for a rep; `prosecdef` true; `proacl` has no PUBLIC/anon; 0 and 201 ids refused; reason length; dry run writes nothing (no merchant change, no audit row); apply all-or-nothing (one refused → zero changed, zero audit rows); `changed_since_preview`; live share and live override (owner- **and** company-funded once the branch is in) refused; inactive target refused; `awaiting_commit` flagged for a review batch; one audit row per changed merchant with `detail`; unchanged writes nothing; export writes one audit row and fails closed (audit insert forced to fail → no rows returned) |
| **rls** `lead-board.test.ts` | 3a | `prosecdef` false; rep counts own only; `agent_id_input` = another rep → zeros; out-of-vocabulary rows counted in `needs_review`; lost without reason still refused by the constraint; conditional UPDATE with a stale `from` touches 0 rows |
| **rls** `grants.test.ts` | 1a–3a | the four new functions and the view appear in its pinned inventory |
| **unit** | 1a | `parseMerchantListParams` (bad values dropped, backwards ranges, page clamp, rep-only `agent` sort ignored), `merchantListHref` (defaults omitted, page reset), sort whitelist |
| **unit** | 1b | CSV writer: quoting, leading zeros, injection prefix |
| **unit** | 1c | effect texts; PT409 DETAIL → per-merchant messages |
| **unit** | 3a/3b | `lead-board.ts` reducer: move, counts, rollback, dedupe on show-more |
| **unit** `claude-md.test.ts` | each | stays green (index lines) |
| **live** | 1c | `move_merchants` through PostgREST as admin and as rep (403 via PT403 mapping), proving the RPC is reachable with the real grants on the stack (no Edge Function is involved, so this is the only live addition) |
| **e2e** `merchants-list.spec.ts` | 1a | sort by each header (order + `aria-sort`), page size 25/50/100, prev/next, total, URL round-trip (reload keeps filters/sort/page), rep sees no Agent filter/column, phone cards and "Sort by" select at 375px, axe |
| **e2e** `merchants-bulk.spec.ts` | 1b, 1c | select page / select all N (and the >200 disabled state), status confirm, export downloads a CSV whose rows match the selection, move preview lists a refused override merchant, reason required, "Continue with the N", the audit row visible on the Activity tab (2c), phone sticky bar |
| **e2e** `merchant-tabs.spec.ts` | 2a | deep link to each tab; rep has no Overrides/Activity tab and their URLs 404; Back/forward; phone tab bar scrolls and is usable; axe |
| **e2e** existing | 2a | `merchant-override.spec.ts`, `merchant-shares.spec.ts`, `merchant-split.spec.ts`, `merchant-owner.spec.ts`, `merchant-location.spec.ts` navigate to the right tab (and `merchant-owner` moves to the Admin menu in 2d) |
| **e2e** `lead-board.spec.ts` | 3a, 3b | rep sees only own cards; admin rep filter; mouse drag changes stage (reload proves it stored); keyboard drag; Move to…; Lost asks a reason and Cancel restores; a forced failure (route intercept returning an error) rolls back and announces; stale move (lead changed in a second session) refreshes; show more; phone: chips + Move to…, no drag; iPad viewport long-press drag; axe |
| **e2e** `dashboard-filters.spec.ts` | 3a | **retired** (the bar is gone); its strip assertions move into `lead-board.spec.ts` |

Each new spec is proved by reverting the fix it guards (testing.md), and durations read, not just
passes.

### 4.3 Build phases (each mergeable and deployable alone)

| Phase | Ships | Migration | Depends on |
| --- | --- | --- | --- |
| **1a** | Paged, sortable, filtered list (no bulk) | A (view, indexes) | — |
| **1b** | Selection, bulk status, export | B | 1a |
| **1c** | Bulk assign agent + processor with preview/reason | C | 1b |
| **2a** | Detail page as tabs (Overview, Pricing, Overrides, Notes, Proposals, Tickets) | none | `override-funding` merged (decision 1) |
| **2b** | Admin menu + effect text | none (uses C) | 1c, 2a |
| **2c** | Residuals and Activity tabs | none | 2a |
| **2d** | owner/processor only through the audited functions (column grants) | yes | 2b (decision 7) |
| **3a** | Board read-only (+ Move to… menu), compact strip, filter bar removed | D | — (independent of 1–2) |
| **3b** | Drag and drop (+ `@dnd-kit/core`) | none | 3a |
| 3c (optional) | Stage history | E | 3b, decision 9 |

**Deploying:** each migration is applied **before** the app that calls it (the app calls functions
that must exist), dev first, through the guarded wrappers; prod through
`scripts/push-prod-migration.ps1 -DryRun` first. Remember `db push` applies **every** pending
migration: if `override-funding`'s `20261116120000` is merged but not yet on a project, pushing 1a
would push override funding too — deploy override funding on its own plan
(`docs/claude/deploy-override-funding.md`) first, and give these migrations timestamps after it.

### 4.4 Phone, iPad, laptop — summary

| | Phone (< `md`) | iPad (`md`–`lg`) | Laptop (≥ `lg`) |
| --- | --- | --- | --- |
| Merchants list | cards, "Sort by" select, filters collapse under a "Filters" disclosure, sticky bulk bar | cards (`ListTable` holds cards until `lg`, by measurement) | table, header sort, inline bulk bar |
| Merchant detail | scrolling tab bar, single column fields, dialogs full-width | same, two-column fields | tab row, three-column fields |
| Dashboard | strip 2-up, one board column at a time with stage chips, Move to… only | full board scrolling horizontally, long-press drag, Move to… | full board, mouse/keyboard drag, Move to… |

### 4.5 Accessibility — summary

Sort headers are links with `aria-sort` on the `<th>`; checkboxes have row-specific names
("Select Acme Pizza"); the bulk bar announces the selection count politely; dialogs trap focus and
return it; the preview's refused rows are text, not colour alone (✕ + message); the tab bar is a
`nav` with `aria-current`; the board has keyboard drag, Move to…, announcements and a live region;
44px targets; reduced motion respected; axe in every new spec. The `ListTable` dual-render caveat
applies to the checkboxes: e2e must use `getByRole`, not `getByLabel`, on the list.

---

## 5. Conflicts and flags

1. **`override-funding` touches the detail page.** It edits `app/(app)/merchants/[id]/page.tsx`
   (`loadOverrideMonths`, `overrideMonthsById`), `components/merchant-override-card.tsx`,
   `lib/overrides.ts` and `e2e/merchant-override.spec.ts` — all on phase 2a's path. This design does
   not edit the card, and moves `loadShareCard()` verbatim. **Merge the branch before phase 2a**,
   or re-apply its three lines by hand.
2. **`guard_merchant_split_and_owner()` is redefined on the branch.** `move_merchants()` must
   refuse a move with **any** live override (the branch keeps that rule, only rewording it), and its
   messages should use the branch's wording ("This merchant has an override. End it before moving
   the merchant."), not master's "which comes out of its owner's side" — that phrase is false for a
   company-funded override.
3. **`docs/tapswipe_crm_schema.sql` and `CLAUDE.md` are edited on the branch** (+1366 lines in the
   spec). Every phase here edits both; build on top of the merge to avoid a large conflict.
4. **`e2e/fixtures/seed.ts` is edited on the branch**; the new e2e specs will add fixtures there.
5. **The pending deploy order** (`db push` applies all pending; §4.3).
6. **Owner/processor changes today have no reason and sometimes no audit row** (when an admin owns
   the merchant). Until phase 2d, the merchant form remains a second, unaudited-by-reason path; the
   design says so rather than hiding it.
7. **`dashboard_counts()` keeps unused parameters** after phase 3a. Deliberately not dropped: its
   RLS test is the proof that a filter argument is ANDed with the policy, and a later report may
   use them.
8. **Rep stage moves are not audited today**, and the board makes them one gesture. Decision 9.
9. **`list-table.tsx`'s doc comment** says the payouts ledger is not on it because of form controls;
   the merchants list will have checkboxes on it. That is the `/tasks` precedent (checkbox as
   `leading`), not the payouts problem (many labelled inputs per row), and e2e must use `getByRole`.

---

## 6. Summary for the owner

**Merchants list.** The list stops loading every merchant at once. You get 25, 50 or 100 per page
with the total ("312 merchants · showing 26–50") and Previous/Next. You can filter by status,
processor, agent (admins), split range and date added, and sort by clicking DBA, MID, Split, Agent
or Added — an arrow shows which way. Everything you pick is in the web address, so a link or a
reload shows the same page. On a phone each merchant is a card, with a "Sort by" menu. Admins can
tick merchants (or "all 312 matching", up to 200 at a time) and then: change status (one confirm),
export them to a spreadsheet file (one confirm, recorded), or — for the two changes that affect pay
— **move them to another rep** or **change their processor**. Those two always show a preview first:
which merchants will change, which cannot and why (for example "has an override, end it first"), a
plain warning that months already committed are not re-paid unless you replace them (and that a
replace pays the whole month to whoever owns the merchant at that moment), and a box where you must
type a reason. Then it all happens, or none of it does, and every change is recorded with your
reason.

**Merchant page.** Instead of one long page, a row of tabs: Overview, Pricing and split, Overrides
(admins), Residuals and payouts, Support tickets, Notes and tasks, Proposals, Activity (admins).
Each tab has its own link. Reps see what they see today, just organised — their own payout lines
for that merchant, their own tickets, notes and tasks; nothing new is revealed. Admins get an
**Admin** menu: edit details, change status, change processor, move to another rep, and shortcuts to
the rate, shared-account and override controls, which stay exactly as they are. Money changes say
what they will do ("on a $100 residual the rep gets $40…") and that committed months do not change.

**Dashboard.** The filter block goes. In its place: a slim row of the five headline numbers, and a
board of leads with one column per stage — New, Contacted, Qualified, Proposal sent, Application
sent, Nurturing, Lost. Drag a lead to another column to change its stage (on an iPad, press and hold
first). Every card also has a "Move to…" menu, which is how it works on a phone (one column at a
time there) and for keyboard users. Moving to Lost asks why. If saving fails, the card jumps back
and says so. Reps see their own leads; admins see everyone's with a rep picker. Each column shows 20
leads with "Show more".

**Risks.**
- The merchant page rebuild collides with the unmerged override-funding work; merge that first.
- Pushing any new database change also pushes override funding if it is merged but not yet deployed.
- Until the follow-up in decision 7, an admin can still move a merchant through the Edit form
  without a reason.
- A rep's own stage changes leave no history today; the board makes them easier (decision 9).
- One new library for drag and drop (decision 2).
- Losing the Manager, Territory and date filters from the dashboard (decision 10).

**Decisions for you** (my recommendation first):

1. **Merge override-funding before the merchant-page work?** — Yes; build the list (phase 1) and the
   board (phase 3) meanwhile, they do not touch it.
2. **Drag-and-drop library?** — Use `@dnd-kit/core` (touch, keyboard and screen-reader support);
   the browser's built-in dragging does not work on iPads or with a keyboard.
3. **MID sort order?** — Alphabetical (text), because MIDs contain letters now and leading zeros
   matter; numeric sorting is not possible for all of them.
4. **Bulk limits?** — 200 merchants per pay-affecting or status action, 1,000 per export; no
   automatic splitting into chunks.
5. **Bulk change of the merchant rate?** — Not now. Add later if you need it, under the same
   preview-and-reason rules.
6. **Export format?** — CSV (opens in Excel, no new code in the browser); Excel `.xlsx` only if you
   need formatting.
7. **Make "move" and "processor" possible only through the audited, reason-required path?**
   (remove them from the Edit form) — Yes, as phase 2d, once the Admin menu exists.
8. **Show a rep their own override deductions on the merchant's Residuals tab?** — Yes, worded
   exactly as on their statement (they already see it there); company-funded overrides stay
   invisible to them.
9. **Keep a full history of lead stage changes (who, from, to, when — reps included)?** — Not in
   the first build; decide after using the board. It adds a table and touches every teardown list.
10. **Where do Manager / Territory / date-range figures go?** — Drop them from the dashboard; add to
    the admin Reports page later only if you miss them.
11. **Cards per column?** — 20, with "Show more" loading 20 at a time.
12. **Phone board?** — One stage at a time with "Move to…", no dragging on phones.
13. **Documents tab on the merchant page?** — Not until per-merchant documents exist; the Document
    Center is company-wide and the old per-record documents stay closed.
