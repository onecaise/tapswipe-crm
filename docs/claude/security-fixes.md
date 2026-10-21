# Security fixes from the October 2026 outside review

Branch `security-fixes`. **Local work only**: nothing here has been pushed, linked, or applied to a hosted project. Owen applies the migrations himself — dev first, then prod — after a dry run and a backup.

Every finding was treated as a claim: reproduced as a failing test on the local stack first, and fixed only if it reproduced. These are binding rules, like the rest of `docs/claude/`.

## Phase 1 (High): merchants are admin-only to change

**Rule (Owen): merchant information is changed by admins only.** A rep reads their own merchants (`select own or admin`, unchanged) and keeps adding notes and tasks to them — those are other tables. A rep cannot insert, update or delete a merchant, their own included.

### The finding, reproduced

`20260805103000`'s `insert own` / `update own or admin` let a rep write every column of their own merchant, `mid` included, and `20260811143000` grants `authenticated` table-wide `insert, update`. `commit_residual_import_v2` (as re-created by `20261016160000_import_merge_key.sql`) finds the share covering a staged row with `left join merchants m on m.mid = r.mid_raw` — the merchant's **current** MID.

`tests/rls/merchants-admin-only-writes.test.ts` runs the attack end to end against the schema **before** the fix (`migrationsBefore(20261021120000)`) and it succeeds in every step:

1. A share exists on `MID-AGENT-2`: signer `AGENT` 40%, partner 10%. A July row for it is staged in review.
2. The signer runs `update merchants set mid = 'MID-AGENT-2 '` — 1 row.
3. An admin commits the month: the row matches no merchant, so the plan is `ordinary`, and the ledger gets **one unshared line** for the signer. The partner gets nothing.
4. The signer restores the MID — 1 row. The merchant looks untouched.
5. `audit_log` holds **nothing** for `merchants`: `log_cross_agent_change()` only logs edits by someone other than the owner.

The same test file, against the current schema, asserts both edits touch 0 rows and the month commits as the pair (`primary` + `secondary`, both carrying `rep_share_id`).

### The fix — `20261021120000_merchants_admin_only_writes.sql`

- **Policies.** `insert own` → `admin insert only` (`with check (is_admin())`); `update own or admin` → `admin update only` (`using (is_admin()) with check (is_admin())`). SELECT and DELETE were already right.
- **Grants: unchanged, deliberately.** Admins and reps are both `authenticated`, so a grant cannot tell them apart, and the admin's form and the missing-location screen need `insert`/`update`. The policies are the only layer that can express "admins only". (The brief asked for both layers to change; this is why only one did. A grant-level split would need admin writes to move behind a `security definer` RPC — not proposed.)
- **`merchants_mid_audit`** — `BEFORE UPDATE OF mid`, `audit_merchant_mid_change()`: one `audit_log` row (`action = 'merchant_mid_changed'`, `row_id` = merchant id, `actor_id = auth.uid()`) for **every** actual MID change, by anyone — admins, a service-role script (NULL actor), and anyone a future policy lets in by mistake. No ownership test, which is the case that hid the attack. Only real changes (`is distinct from`), so a form re-sending the same MID logs nothing. Fails closed: no exception handler. `security definer`, `set search_path = public, pg_temp`, `revoke all … from public` and from `anon, authenticated` (a trigger function needs no EXECUTE). The row records who, when and which merchant, **not the old and new values** — `audit_log` has no column for them. Two rows for one merchant inside one review window is the shape of a pad-and-restore.

Mutation checks in the test file: with the two old rep branches restored on a throwaway database, the rep's update lands and their insert succeeds; with the trigger dropped, an admin's MID change leaves no row. Each was confirmed red.

### Every writer of `merchants`, checked

| Writer | How it writes | Affected? |
| --- | --- | --- |
| `approve_pre_app()` | `security definer`, `is_admin()` first | No — runs as owner. Asserted: it still creates the rep's merchant. |
| Ghost sheet → lead → pre-app flow | `convert_ghost_sheet` writes `leads`/`notes`; merchants come only from `approve_pre_app()` | No |
| Share RPCs (`set/end/cancel_merchant_rep_share`, share card, corrections) | write `merchant_rep_shares` / `rep_payout_rows`; only **read** `merchants` | No |
| `parse-residual-import`, `_shared/residuals.ts` | service role, reads only | No |
| Triggers on `merchants` (`set_updated_at`, `merchants_location_guard`, cross-agent audit, new MID audit) | fire on the writer's statement; none write `merchants` | No |
| `/admin/merchants/missing-location` | `requireAdmin()`, reads only | No |
| `scripts/backfill-merchant-location*.sql`, `recon-…`, `preview-…` | hand-run as `postgres` | No (RLS does not apply) — but see the owner fix below |
| Bulk user import / provision | do not touch `merchants` | No |
| e2e seed, live fixtures, `seed-local-users.mjs` | service role | No |
| **Merchant form** (`components/merchant-form.tsx`) | browser `update` / `insert` | **Yes** — admin-only now |

**What relied on a rep updating a merchant**, all now admin-only:

1. The Edit page and form for a rep's own merchant.
2. **New merchant** for reps (manual creation). Confirmed with Owen's rule: reps lose it. No flow in the app depends on it — every rep merchant path goes through `approve_pre_app()`.
3. Filling in a legacy merchant's location: the detail page said "Not recorded — edit to add". A rep now sees "Not recorded"; admins fill it from `/admin/merchants/missing-location` or the edit form.
4. `merchants.pre_app_id` was rep-writable, so a rep could point their merchant at **another rep's** pre-app — which is what made the backfill fix below necessary.

### App

- `/merchants/[id]/edit` and `/merchants/new` call `requireAdmin()` (a rep is redirected to `/dashboard`).
- The detail page hides **Edit** from reps and shows "To change this merchant, contact an admin." No request workflow.
- The list page renders **New merchant** only for an admin (its own `<Suspense>`, the `payouts` `HeaderActions` shape).
- Form copy no longer says "you can only edit merchants in your book".

### Backfill scripts: same owner only

`scripts/backfill-merchant-location.sql` (and, to keep the "identical rules" promise, `backfill-merchant-location-editor.sql`, `recon-merchant-location.sql` and `preview-merchant-location-backfill.sql`) now require `p.agent_id = m.agent_id` on the pre-app join. The preview reports such merchants as `linked pre-app belongs to another rep`. `tests/rls/merchant-location-backfill.test.ts` gained a merchant linked to `OTHER_AGENT`'s approved pre-app with a usable address; all four scripts filled it (8 tests red) before the change, none do after.

### Tradeoff, reported not built: storing the MID on `merchant_rep_shares`

Snapshotting `mid` onto the share at `set_merchant_rep_share()` and matching staged rows on `share.mid` would make the commit independent of the merchant's mutable MID.

- **For:** no later MID edit, by anyone, can detach a share during review; the ledger is keyed by MID text anyway.
- **Against:** a *legitimate* MID change (a typo fix, a processor re-boarding the account) silently detaches the share the other way — the share keeps matching the old MID, and next month's file, carrying the new one, commits unshared. That is the same failure from an honest edit. Avoiding it needs either a sync trigger (which re-couples them) or a block on MID changes while a share is active. It also means two sources of truth, a backfill of existing shares, and lockstep changes to `commit_residual_import_v2`, `previewSharedRow()` in `_shared/residuals.ts`, and the three share RPCs' "latest committed month" reads.
- **Recommendation:** not now (Owen agreed, 21 Oct 2026). With rep writes closed and every MID change audited, the remaining exposure is an admin. A cheaper guard if wanted later: staged rows already carry `merchant_id`; the commit could block a row whose `merchant_id`'s current MID differs from `mid_raw` ("this merchant's MID changed since the file was read").

### Ownership: an admin creates a merchant for a rep, and moves one between books

Decision (Owen, 21 Oct 2026). The admin's New merchant and Edit forms have a required **Owner** select (`lib/merchant-owners.ts`, `ownerOptions()`): every active rep by name with their Agent #, then the admin themself as "(you)". There is **no default** on New — the admin picks, themself included. On Edit it starts on the current owner; a current owner who would not otherwise be offered (a deactivated rep, another admin) is listed first and labelled, so saving the form never silently moves the merchant.

- **No schema change was needed.** "admin insert only" / "admin update only" already admit any owner for an admin and nobody else.
- **Audited by the existing trigger.** `log_cross_agent_change()` writes `cross_agent_insert` when an admin creates a merchant in another rep's book and `record_reassigned` on any owner change — including out of the admin's own book, which its reassignment branch checks before ownership. Creating a merchant in the admin's own book is not an ownership change and logs nothing.
- **Payouts do not follow the owner.** `parse-residual-import` resolves the payee from the file's Agent # (`profiles.agent_number`), and `commit_residual_import_v2` never reads `merchants.agent_id`. Asserted: after reassigning `MID-AGENT-1` to another rep, a row naming the old rep's number is paid to the old rep; after reassigning a shared merchant, the signer's row still commits as the signer/partner pair.
- **`merchant_rep_shares` is untouched.** No trigger on `merchants` writes it; asserted by snapshotting the table and the ledger across a reassignment. The share card's *default* signer for a new share is still the merchant's current owner.
- **Visibility moves with it.** Asserted: the previous owner's `select` returns 0 rows and the new owner's returns 1. A rep cannot give a merchant away or take one (0 rows each, no audit row).

**What a reassignment does not move** (reported, not changed): notes, tasks and proposals on the merchant keep their author's `agent_id`, so the new owner does not see the old owner's notes/tasks/quotes, and the old owner still sees their own notes and tasks on a merchant they can no longer open; the merchant's `pre_app_id` still points at the old owner's pre-app. Owen to decide whether a reassignment should carry any of these.

Tests: 7 in `tests/rls/merchants-admin-only-writes.test.ts` ("an admin decides who owns a merchant", one of them the mutation check with `merchants_audit_cross_agent` dropped), 5 in `tests/unit/merchant-owners.test.ts`, 3 in `e2e/merchant-owner.spec.ts`. Revert experiment: with the form put back to inserting into the caller's own book, "creates the merchant in the chosen rep's book" goes red (the serial reassign spec after it was skipped, so it was not independently proven that way; its RLS twin was).

The cheaper "block a staged row when the merchant's current MID no longer matches the file" idea is recorded in `docs/claude/security-followups.md`.

### Not verified

- Nothing ran against a hosted project. The policy change and trigger are verified on PGlite (`npm test`) and on the local stack (`migration up --local`, then `test:live` and `test:e2e`).
- `audit_merchant_mid_change()` is not in `tests/rls/grants.test.ts`'s function inventory by name; its privileges are asserted in its own file.
