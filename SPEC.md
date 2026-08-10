# Pre-App Submission Flow — Specification

Status: **built, as of 2026-08-10.** All six commits in §11 have landed; the sections below
are kept as the design record, so where the code and this document disagree the code is now
the fact. Read it alongside `docs/tapswipe_crm_master_plan.md` §3/§6/§14.5/§14.6 and
`docs/tapswipe_crm_schema.sql`, which remains the authoritative data-model spec.

Four places where what shipped deviates from what is written below, each deliberate:

1. **Filenames drifted.** `20260806141000_pre_app_rpcs.sql` shipped as
   `..._pre_app_state_machine.sql`; `tests/rls/pre-app-rpcs.test.ts` as
   `tests/rls/pre-app-state-machine.test.ts`; `pre-app-submit-button.tsx` as
   `pre-app-steps/review-step.tsx` (§11 commit 6's submit button became the wizard's last
   step); `pre-app-admin-actions.tsx` as `pre-app-decision.tsx`; and §8's
   `start-pre-app-button.tsx` is a plain `<Link>` on `/leads/[id]` rather than a component.
   Search for the behaviour, not the filename.
2. **No shared validation file, so no `tests/rls/validation-copy.test.ts`** — see §6. The
   validators are duplicated and pinned by behaviour in `tests/live/pre-app-secrets.test.ts`
   instead. Not debt.
3. **§9's `tests/live/helpers/stack.ts` extension did not happen.** `provisionFixtures()`
   gained no `preAppIds`/`preAppOwnerIds`; `tests/live/pre-app-secrets.test.ts` provisions and
   tears down its own personas, including deleting their `audit_log` rows before
   `deleteUser()` — the FK trap §9 predicted, handled where the rows are written.
4. **One migration §5 did not anticipate**, added while building the review step:
   `20260810152129_pre_app_secrets_presence.sql`. The client-side blocker list needs two facts
   that live in tables the browser may not read (banking ciphertext exists; how many owners
   lack an SSN). `read-pre-app-secrets` was the wrong source — it decrypts, and it audits, so
   rendering a checklist would have written an `audit_log` row claiming a full SSN read that
   no human performed. `pre_app_secrets_presence` answers with `exists`/`count` and names no
   ciphertext column.

Not in this spec's scope, and repeatedly mistaken for a gap: **there is no Documents step.**
Decision 1's wizard is `business|owners|terminal|profile|secrets` (plus `review`); pre-app
document uploads are part of the **detail page** per §8, via the existing `DocumentsPanel`
and the two signed-URL functions, which already accept `owner_type = 'pre_app'`.

## 1. Why

The pre-app is the full merchant application — business info, ownership, banking, card
mix, terminal/POS setup, document uploads. Roughly 80 fields across four tables plus
three encrypted-secrets tables. It is the workflow the business runs on: a rep submits,
an admin approves, a `merchants` row appears.

Everything it depends on now exists — auth + profiles, merchants, leads, ghost sheets,
and document storage (17/17 live tests green against the local stack as of 2026-08-06).
Pre-Apps is the last unbuilt core feature.

## 2. Findings that shaped this spec

Established by reading the code, not assumed:

1. **The form stack the master plan assumes is not installed.** No `react-hook-form`,
   `zod`, `@hookform/resolvers`, or `@tanstack/react-query`. Every existing form is
   `useState` + a hand-written `toPayload()` + a client-side `supabase-js` call, and
   there are zero Server Actions in the repo.
2. **The schema cannot support the intended UI yet.**
   - The three `pre_app` child tables have **no DELETE policy** → "remove this owner" is
     impossible client-side.
   - `pre_app_terminal` and `pre_app_business_profile` have **no `unique (pre_app_id)`**
     → a 2-second autosave would silently create duplicate rows. Neither do the three
     secrets tables, so nothing defines "the current SSN."
   - No child FK declares `ON DELETE` behaviour → an admin deleting a populated pre-app
     **fails on the FK**, and the children have no delete policy to clear first. Pre-apps
     are effectively undeletable through PostgREST today.
   - `pre_apps.status` is **nullable**, and a `CHECK` that evaluates to NULL passes — so
     `set status = null` currently defeats the state machine.
3. **Encryption does not exist.** No crypto code, no key, no secret name;
   `[edge_runtime.secrets]` is commented out in `config.toml`; and
   `submit-pre-app-secrets` is still the 46-line `Hello ${name}` stub.
4. **`approve_pre_app` has four defects.** Calling it twice creates **two** merchant rows;
   any status can be approved; a nonexistent id returns NULL while still writing an
   `audit_log` row claiming an approval happened; and it has no pinned `search_path`.

Two risks checked and closed:

- **The deployed grant surface is converged.** All six migrations are applied to the
  linked project (`supabase migration list --linked`), so the schema doc's warning that
  production may still carry legacy blanket grants on the secrets tables is stale. Correct
  that note as part of this work.
- **CORS needs no work.** The Deno runtime returns `access-control-allow-origin: *` on
  real responses and Kong answers preflight (verified against the local stack), so browser
  `functions.invoke` works. The existing document-upload flow is not secretly broken.

## 3. Decisions

| # | Area | Decision |
|---|---|---|
| 1 | Form shape | URL-driven wizard: `/pre-apps/[id]/edit?step=business\|owners\|terminal\|profile\|secrets`. Steps map 1:1 onto tables. Follows the `filter-tabs.tsx` precedent — navigation as links, shareable, survives back/forward. |
| 2 | Form stack | Add `react-hook-form`, `zod`, `@hookform/resolvers`. **No** TanStack Query — all reads are Server Components. |
| 3 | Draft creation | First save needs only `dba_name` + `legal_business_name` (the two NOT NULL columns). No placeholder rows. |
| 4 | Write path | Client `supabase-js` per section for drafts; a `submit_pre_app(int)` RPC for draft→submitted. |
| 5 | Autosave | Debounced 2s after last keystroke, dirty fields only, forced flush on step navigation. |
| 6 | Duplicate rows | `unique (pre_app_id)` on terminal + business_profile; autosave uses `.upsert(..., { onConflict })`. |
| 7 | Owner removal | DELETE policies on the three child tables, mirroring the parent rule. |
| 8 | Edit lock | Agents edit `draft` only; admins always. **Amended during design:** UI + RPC checks are *not* sufficient — see §5.3. A `before update` guard trigger on `pre_apps` is required, because an agent can otherwise set `status` directly through PostgREST and walk past both RPCs. |
| 9 | Secrets entry | Own step, no autosave, explicit "Encrypt & save". Values cleared from component state after success. Shows "on file / not on file", never a stored value. |
| 10 | Secret rewrites | Unique constraints on the three secrets tables; the Edge Function upserts, so a correction replaces rather than accumulates. |
| 11 | Secret reads | Admins get full plaintext; the **owning agent gets last-4 only**. Every read writes `audit_log`. |
| 12 | Encryption | `PRE_APP_SECRETS_KEY`, base64 32-byte key, AES-256-GCM. Stored `bytea` = 12-byte IV ‖ ciphertext ‖ 16-byte tag. Refuses to operate on a missing or wrong-length key. |
| 13 | Validation gate | Drafts accept anything — autosave must never lose a half-typed value. `submit_pre_app` is the real gate. |
| 14 | Format masks | Auto-insert separators while typing; an invalid value shows an inline error and **disables Next**, but autosave still persists what was typed. |
| 15 | Masked fields | Phones `xxx-xxx-xxxx`; EIN `xx-xxxxxxx`; SSN `xxx-xx-xxxx`; zip `xxxxx` or `xxxxx-xxxx`; ABA routing 9 digits + mod-10 checksum; account 4–17 digits; percentages 0–100. **Amended during design:** dates use native `type="date"` pickers rather than an `MM/DD/YYYY` mask — see §6.1, a partial value cannot be written to a `date` column, so masking dates and always-autosaving are mutually exclusive. |
| 16 | Commission split | `split_agent_pct`/`split_company_pct` on `pre_apps`, default 50/50, 100/0 when the CEO is the seller, check that they sum to 100. `approve_pre_app` copies them into `merchants` (it leaves them NULL today). |
| 17 | Owner % rule | At least one owner with `percent_owned >= 51` must be listed. Blocks submit. |
| 18 | `approve_pre_app` | Fix all four defects, copy the split, and record the new merchant id in `audit_log`. |
| 19 | Conflicts | Last-write-wins, no version check. Reps cannot edit submitted pre-apps, so rep-vs-admin overlap cannot occur. |
| 20 | Lead linkage | "Start pre-app" on `/leads/[id]` creates a draft with `lead_id` set and business fields prefilled. |
| 21 | Decline | New `decline_reason` column + `decline_pre_app(id, reason)` RPC. The rep sees the reason and can reopen to draft. |
| 22 | Booleans | Plain checkboxes; unchecked writes `false`. |
| 23 | State input | Typeahead combobox — 50 states + DC, sorted by code, matching code prefix then name prefix, **rejecting any value not in the list**. Typing `T` highlights `TN`. |
| 24 | Review queue | One `/pre-apps` list with status FilterTabs; admins default to `submitted`. |
| 25 | Scope | Full flow, sequenced into six independently-working commits. |

## 4. Rules this work must not break

- `docs/tapswipe_crm_schema.sql` changes **first**, then migrations match it.
- Never grant `anon`. **Never grant or add a policy to the three `*_secrets` tables** —
  RLS-with-zero-policies plus the absent grant are two independent locks, and
  `tests/rls/grants.test.ts` pins both.
- Every new function carries `revoke all on function <sig> from public;` and
  `grant execute on function <sig> to authenticated, service_role;` in the same migration.
  Postgres grants EXECUTE to PUBLIC (which includes `anon`) on every new function and
  there is no declarative backstop.
- Edge Function order: `withSupabase({ auth: "user" })` → `callerIsActive(ctx.supabase)`
  → authorize through the **caller-scoped** client → only then `ctx.supabaseAdmin`.
  Return 404, not 403, for "not yours".
- Never run `npx supabase config push`.

## 5. Schema changes

### 5.1 `20260806140000_pre_app_constraints_and_policies.sql`

```sql
-- status must not be nullable: a CHECK that evaluates to NULL passes, so
-- `set status = null` currently defeats the whole state machine.
update pre_apps set status = 'draft' where status is null;
alter table pre_apps alter column status set not null;

-- Commission split, carried into merchants at approval.
alter table pre_apps
  add column split_agent_pct   numeric(5,2) not null default 50,
  add column split_company_pct numeric(5,2) not null default 50,
  add constraint pre_apps_split_sums_to_100
    check (split_agent_pct + split_company_pct = 100),
  add column decline_reason text;

-- One row per pre-app, so autosave can upsert instead of accumulating rows.
alter table pre_app_terminal         add constraint pre_app_terminal_pre_app_id_key         unique (pre_app_id);
alter table pre_app_business_profile add constraint pre_app_business_profile_pre_app_id_key unique (pre_app_id);
alter table pre_app_owner_secrets    add constraint pre_app_owner_secrets_owner_id_key      unique (pre_app_owner_id);
alter table pre_app_banking_secrets  add constraint pre_app_banking_secrets_pre_app_id_key  unique (pre_app_id);
alter table pre_app_terminal_secrets add constraint pre_app_terminal_secrets_pre_app_id_key unique (pre_app_id);

-- Child FKs get ON DELETE CASCADE. Without this an admin delete of a populated
-- pre-app fails on the FK, and the children have no delete policy to clear first.
-- Same fix shape as ghost_sheets.lead_id in 20260805161500.
alter table pre_app_owners drop constraint pre_app_owners_pre_app_id_fkey;
alter table pre_app_owners add  constraint pre_app_owners_pre_app_id_fkey
  foreign key (pre_app_id) references pre_apps(id) on delete cascade;
-- ...repeat for pre_app_terminal, pre_app_business_profile,
--    pre_app_banking_secrets and pre_app_terminal_secrets (pre_app_id),
--    and pre_app_owner_secrets (pre_app_owner_id -> pre_app_owners).

-- The secrets tables have no index on their FK column, so the read path seq-scans.
create index idx_pre_app_owner_secrets_owner_id     on pre_app_owner_secrets(pre_app_owner_id);
create index idx_pre_app_banking_secrets_pre_app_id on pre_app_banking_secrets(pre_app_id);
create index idx_pre_app_terminal_secrets_pre_app_id on pre_app_terminal_secrets(pre_app_id);

-- DELETE policies on the three non-secret children, mirroring the parent rule.
create policy "delete via parent pre_app" on pre_app_owners
  for delete using (
    is_admin() or (is_active_agent() and exists (
      select 1 from pre_apps
      where pre_apps.id = pre_app_id and pre_apps.agent_id = auth.uid()))
  );
-- ...same for pre_app_terminal and pre_app_business_profile.

-- Also make the children's UPDATE `with check` explicit rather than relying on
-- Postgres reusing the USING expression — the parent tables spell it out, these don't.
```

No new grants: the four non-secret pre-app tables and their sequences are already
granted in `20260805200000`, and `service_role` holds `grant all`. **The secrets tables
gain no grant and no policy.**

### 5.2 `20260806141000_pre_app_rpcs.sql`

Four `security definer` functions, each with `set search_path = public` and its own
revoke/grant pair.

**`submit_pre_app(pre_app_id_input int) returns void`** — the real validation gate:

- caller must own it (`agent_id = auth.uid() and is_active_agent()`) or be admin
- `status` must be `'draft'`
- `dba_name` and `legal_business_name` non-empty
- **at least one owner with `percent_owned >= 51`**
- if a `pre_app_business_profile` row exists with any percentage set, the six card-mix
  percentages must sum to 100
- **a banking secrets row must exist**, and **every owner row must have an SSN row**
- on success: `status = 'submitted'`, `date_submitted = current_date`, clear
  `decline_reason`, write `audit_log`

### 5.2.1 The card-mix rule — settled

A single six-column sum of 100 was wrong and would have rejected every honestly-filled
form: `card_swiped_pct` + `card_keyed_pct` is one 100% split of *how* the card is read,
`card_present_pct` + `card_not_present_pct` is a second, independent one, and `moto_pct` /
`internet_pct` are subsets of card-not-present rather than peers of it.

The rule is **two independent pair checks, and nothing else**:

- `card_swiped_pct + card_keyed_pct = 100`
- `card_present_pct + card_not_present_pct = 100`

Each pair is checked only if at least one of its two columns is non-null, so a draft that
has filled in one pair and not the other still submits. `moto_pct` and `internet_pct` are
**informational** — captured, displayed, never constrained, and in particular **not**
summed against `card_not_present_pct`. That relationship may well hold in reality, but it
isn't being enforced now.

The wizard's client-side `submitBlockers()` must implement exactly these two rules and no
others. Any rule the RPC enforces that the client doesn't mirror becomes an error a rep
cannot act on; any rule the client enforces that the RPC doesn't becomes a field they can't
submit for no visible reason.

> **Reading a secrets table from SQL.** `submit_pre_app` runs
> `select exists (select 1 from pre_app_banking_secrets where ...)`. This does not violate
> the never-grant rule — a `security definer` function runs as its owner, so it needs no
> grant to `authenticated` and adds no policy. It tests **existence only**; it must never
> select, return, or log a ciphertext column. Say so in a comment so a later edit doesn't
> quietly widen it.

**`approve_pre_app(pre_app_id_input int) returns int`** — replaces the current body:

- keep the `is_admin()` guard; add `set search_path = public`
- `select ... into`; `if not found then raise`
- raise if `status = 'approved'` (today a second call creates a second merchant)
- require `status = 'submitted'`
- insert `merchants` including `split_agent_pct` and `split_company_pct`
- two `audit_log` rows: the `pre_apps` status change, and one recording the **new merchant
  id** (today the audit row names only the pre-app, so what was created isn't recorded)

**`decline_pre_app(pre_app_id_input int, reason_input text) returns void`** — admin only,
requires `status='submitted'` and a non-empty reason; sets `status='declined'` and
`decline_reason`; writes `audit_log`.

**`reopen_pre_app(pre_app_id_input int) returns void`** — owner or admin, requires
`status='declined'`, returns it to `'draft'`, keeping `decline_reason` visible until the
next successful submit clears it.

### 5.3 A status guard trigger — required, and not in the original decision list

Decision 8 assumed "UI plus RPC checks" was enough to keep an agent out of a submitted
pre-app. **It isn't.** The `pre_apps` update policy is
`(agent_id = auth.uid() and is_active_agent()) or is_admin()` and says nothing about
*which columns* may change, so an agent can send

```
PATCH /rest/v1/pre_apps?id=eq.7   {"status": "approved"}
```

straight through PostgREST and skip `submit_pre_app` and `approve_pre_app` entirely —
`approve_pre_app`'s `is_admin()` guard is irrelevant if the column is directly writable.
They can also bump `split_agent_pct` after submitting but before approval, which
`approve_pre_app` then copies into `merchants`.

RLS cannot express this: a `with check` expression sees only `NEW`, never `OLD`, so
"status unchanged" is not statable as a policy. A row trigger can.

**Why the trigger cannot tell the two apart by role.** `SECURITY DEFINER` changes
`current_user`, not the session's JWT claims — `auth.uid()` reads the
`request.jwt.claims` GUC, so inside `submit_pre_app` it still returns the *caller*, and
`is_admin()` still evaluates against the caller's profile. That produces an asymmetry that
rules out an `is_admin()`-based test:

- `approve_pre_app` — the caller is an admin by the function's own guard, so `is_admin()`
  is true and a role test would let its UPDATE through.
- `submit_pre_app` — the caller is normally the **agent** submitting their own draft, so
  `is_admin()` is false. A role-based trigger would block the primary path outright.

**Mechanism: a session-local flag the RPC sets immediately before its own write and clears
immediately after.**

```sql
if coalesce(current_setting('tapswipe.pre_app_transition', true), '') = 'on' then
  return new;   -- an RPC's own write
end if;
```

```sql
perform set_config('tapswipe.pre_app_transition', 'on', true);
update pre_apps set status = 'submitted', date_submitted = current_date where id = pa.id;
perform set_config('tapswipe.pre_app_transition', '', true);
```

Three details that matter:

- `set_config(..., true)` is **transaction**-local, not statement-local: it survives to the
  end of the transaction and is discarded on commit or rollback. PostgREST runs one
  transaction per request, so it cannot outlive the call — but the explicit clear is what
  keeps it from covering any *later* statement in the same transaction, which is what a
  future plpgsql caller invoking the RPC and then updating would hit. Clear it, don't rely
  on the request boundary.
- The GUC is named under a `tapswipe.` prefix, deliberately **not** under `request.`, which
  PostgREST populates from client-controlled headers. A client cannot set a `tapswipe.*`
  GUC: `set_config` lives in `pg_catalog`, so it is not reachable as `/rpc/set_config`.
- **No `is_admin()` early return** (a correction to the first draft of this section). With
  one, an admin could PATCH `status = 'approved'` directly and reach the approved state with
  **no merchant row and no `audit_log` entry** — a data-integrity hole, not merely an
  authorization one. Status moves only through an RPC, for everyone. `is_admin()` appears in
  the trigger only to relax the separate rule that non-draft rows are frozen, per decision 8.
- **The trigger fires for the table owner too, so `service_role` is not exempt** — and a
  service-role connection has no `auth.uid()`, so `is_admin()` is false there as well.
  Privileged server code therefore cannot `UPDATE pre_apps.status` or touch a non-draft
  pre-app at all; it has to call these RPCs. Intended, and pinned by a test: it keeps the
  `audit_log` write and the merchant creation on the only path that exists. A future function
  that genuinely needs to bypass it should set the transition flag around its own write
  rather than weaken the trigger. **Consequence for tests:** fixture setup cannot mutate a
  submitted pre-app via `asPlatform` — drive the real path (edit as a draft, then submit
  through the RPC) instead.

Column-level privileges (`grant update (col, …)`) are the declarative alternative and were
rejected: Postgres checks the table-level privilege first, so this would mean replacing the
table-level `grant update on pre_apps` with an explicit ~30-column list that every future
migration has to remember to extend. That fails closed rather than open, but it fails
often, and a forgotten column shows up as a mystery `permission denied` in autosave.

**Verified as a prototype over the real migrations before committing to it** — agent direct
`status` PATCH rejected; agent `submit_pre_app` **succeeds**; a direct PATCH immediately
after the RPC returned still rejected (no flag leak); agent edit of a submitted pre-app
rejected; admin edit allowed; admin direct `status` PATCH rejected; admin
`approve_pre_app` succeeds and creates the merchant with the split; second approve rejected.

**Required tests, in `tests/rls/pre-app-rpcs.test.ts` (commit 6).** Both directions, because
either alone is misleading — a suite that only proves a direct PATCH is refused would pass
just as happily against a trigger that blocks the RPCs too:

1. agent direct `status` PATCH raises, and `status` is unchanged when read back as platform
2. agent direct `date_submitted` PATCH raises
3. **`submit_pre_app` succeeds for the owning agent under the trigger**, and `status` is
   `submitted` with `date_submitted` set
4. **`approve_pre_app` succeeds for an admin under the trigger**, and the merchant row
   exists with both split columns copied
5. a direct `status` PATCH immediately after an RPC call still raises — the flag was cleared
6. agent edit of a non-status column on a submitted pre-app raises; the same edit as admin
   succeeds
7. admin direct `status` PATCH raises, and no merchant row appears
8. load-bearing: with the trigger dropped, case 1 stops raising

This lands with the RPCs in commit 6, not with the schema — the flag mechanism only makes
sense once there is an RPC to set it.

## 6. Validation contract

Canonical Zod schemas in `lib/pre-app-validation.ts` — one per step, plus a
`submitReadySchema` mirroring the RPC's rules so the client can name the failing rule
before the round-trip.

**Sharing with Deno.** Only the **secrets** validators need to exist on both sides —
`submit-pre-app-secrets` never sees business/owners/terminal/profile fields, so the shared
surface is four rules: `isSsn`, `isRouting` (incl. mod-10), `isAccount`, and a length cap on
`rp_password`.

Genuinely sharing one file would require three things to hold at once: the file imports
nothing but `zod` (so schemas must leave `lib/pre-apps.ts`, which imports a React type);
each `deno.json` maps both `zod` and a relative specifier reaching *above*
`supabase/functions/`; and `supabase functions deploy` bundles files from above that
directory. The third is not worth betting a deploy on, and the repo has already answered
this question twice — `_shared/documents.ts` is "deliberately dependency-free… so it doesn't
need its own deno.json import map," and `lib/documents.ts` says its constant is "duplicated
in `supabase/functions/_shared/documents.ts` because Deno Edge Functions can't import from
here."

**So: duplicate, following that precedent — and hand-write the Deno side dependency-free
rather than copying zod into it.** A new `supabase/functions/_shared/pre-app-secrets.ts`
holds `isSsn` / `isRouting` / `isAccount` / `isRpPassword` plus a `parseSecretsBody()`
returning 400 on anything malformed. No zod in Deno, no import map change, no bundling
question.

Trade-off, stated plainly: the rule now exists in two places and TypeScript cannot see the
pair, so changing the routing checksum in `lib/masks.ts` could silently leave the function
accepting values the UI rejects — or worse, rejecting values the UI accepts, producing a 400
the rep can't explain. Two mitigations: a cross-reference comment in **both** files (the
`lib/documents.ts` style), and — the only mechanism that actually catches drift — **pin the
pair by behaviour, not by types**: `tests/live/pre-app-secrets.test.ts` POSTs every value the
client validator rejects (8-digit routing, checksum-failing 9-digit routing, 3-digit account,
18-digit account, malformed SSN) and asserts 400, plus one valid round-trip asserting 200.
That's the technique `document-urls.test.ts` already uses for its ownership branches.

Rejected alternative: send secrets unvalidated and let only the Edge Function check them.
That would make an inline "checksum failed" as the rep types impossible, which is the point
of decision 14.

Masks live in `lib/masks.ts`, no mask library — eight formats, all "strip to a character
class, cap the length, splice separators in at fixed offsets," which is ~60 lines of pure
functions. Every `mask*` is **idempotent**, so it's safe to run on every keystroke, on
paste, and on the value loaded from the database.

```ts
maskPhone(v)   // xxx-xxx-xxxx      maskEin(v)     // xx-xxxxxxx
maskSsn(v)     // xxx-xx-xxxx       maskZip(v)     // xxxxx or xxxxx-xxxx
maskRouting(v) // 9 digits          maskAccount(v) // 4–17 digits
maskState(v)   // 2 letters, upper  maskPercent(v) // 0–100, max 2dp
isRouting(v)   // 9 digits AND 3(d1+d4+d7)+7(d2+d5+d8)+(d3+d6+d9) ≡ 0 (mod 10)
```

### 6.1 Masks apply only to `text` columns — this narrows decision 15

**A typed column cannot receive a partially typed value.** `business_start_date`,
`id_issue_date`, `id_expiration_date` and `dob` are `date`; `batch_out_time` is `time`;
`tax_rate`, `percent_owned` and the six card-mix columns are `numeric`. PATCHing
`business_start_date: "12/3"` returns PostgREST `22007`, the indicator sticks on "Save
failed", and the rep can't tell which field broke it. So "always autosave whatever is
typed" and "mask dates as MM/DD/YYYY" are mutually exclusive.

Resolution, which **replaces the MM/DD/YYYY mask** in decision 15:

- **Typed columns get native inputs** — `type="date"`, `type="time"`, `type="number"` with
  `step`/`min`/`max`. The repo already does this (`lead-form.tsx:103`,
  `merchant-form.tsx:203`). A native date input emits `""` or a complete `YYYY-MM-DD`, so a
  half-typed date is impossible and nothing can be lost. Free calendar picker and
  locale-correct display as a bonus.
- **Masks apply to the `text` columns only** — the four phones, `ein_number`, `zip`,
  `home_zip`, the four state fields, `id_number`, and the three secrets. All `text`, so a
  half-typed `"12-3"` EIN persists exactly as decision 14 requires and the inline error plus
  disabled Next is the only consequence.
- Belt-and-braces: `save` **omits an unparseable numeric key entirely** rather than sending
  `null`, so a transient `"1e"` can't wipe a previously saved good value.

### 6.2 Caret position

The rule: the caret means "N significant characters precede me," not "I am at index N."
Reformat, then re-derive the index from N — `countSignificant()` / `caretForSignificant()`.

With a controlled input you **cannot** set `selectionStart` inside `onChange`: React
re-renders afterwards and writing `input.value` moves the caret to the end. So `onChange`
stashes the target caret in a ref and a **`useLayoutEffect` keyed on `value`** restores it
after the DOM write (not `requestAnimationFrame`, which paints the wrong caret first).

One special case needs the `inputType` from the native event: backspacing onto a separator
leaves every digit in the raw string, so a naive reformat re-inserts the separator and the
key appears dead. Detect `deleteContentBackward` over a separator and drop the preceding
significant character instead.

This buys three behaviours the naive version gets wrong: typing mid-string (`555-1234`,
caret after `555`, type `9` → `555-912-34` with the caret after the `9`, not at the end);
paste (`(555) 123-4567` → `555-123-4567`, no special case); and separator deletion.

### 6.3 State fields use a combobox, with `maskState` retained

Per decision 23 the four state fields (`state`, `home_state`, `id_state`,
`state_incorporated`) are a typeahead over `US_STATES`, which makes the value unfalsifiable
and removes four validators from the error surface. Keep `maskState` anyway — it normalizes
whatever free text arrives from a lead prefill (`leads.state` is unconstrained).

Radix constraint: **`""` is not a legal `<SelectItem value>`**, so "no state" needs an
`UNSET` sentinel that the coercion layer maps back to `null`.

## 7. Edge Functions

`supabase/functions/_shared/crypto.ts`:

```ts
loadKey(): Promise<CryptoKey>                  // PRE_APP_SECRETS_KEY, base64 → 32 bytes; throws otherwise
encrypt(key, plaintext): Promise<Uint8Array>   // 12-byte IV ‖ ciphertext ‖ 16-byte tag
decrypt(key, payload): Promise<string>
toBytea(bytes): string                         // "\x" + hex, the PostgREST bytea wire form
fromBytea(value): Uint8Array
last4(value): string
```

**`submit-pre-app-secrets`** — body
`{ pre_app_id, banking?, terminal?, owners?: [{ pre_app_owner_id, ssn }] }`.
Order: `withSupabase({auth:"user"})` → POST-only → `ctx.userClaims?.id` → JSON parse →
shared Zod validation, so a malformed SSN never reaches the encryption step →
`callerIsActive(ctx.supabase)` → resolve `pre_apps.agent_id` **and** `status` through the
caller-scoped client (404 if absent or not yours; reject if not `draft` unless admin) →
verify every `pre_app_owner_id` belongs to that pre-app → **then** `ctx.supabaseAdmin`
upserts the ciphertext and writes `audit_log` with an explicit `actor_id` (a service-role
connection has no `auth.uid()`). The response reports `"on_file"` per field and **never
echoes a value**.

**`read-pre-app-secrets`** — same preamble, then branches on an `is_admin()` RPC through
the caller-scoped client: admin gets plaintext, the owning agent gets `last4` only.
Determine the tier from `is_admin()`, **never** by comparing the caller to `agent_id` — an
admin can also be the owning agent, and that inference would silently downgrade them.

Write the `audit_log` row **before decrypting**; if the insert fails, return 500 and
decrypt nothing. An audit outage blocking reads is the right trade for this data; plaintext
returned with no trail is not.

**Refinement to decision 11: `rp_password` returns presence only, never a suffix.** Last-4
is a reasonable disclosure for an identifier like an account number, and a real leak for a
password — four characters removes most of its entropy for anyone who also knows the
vendor's password rules. Non-admins get `{ present: true }`.

**Bind each ciphertext to its row (AAD).** Pass
`aad = "<table>:<column>:<parent id>"` to AES-GCM. Without it, anyone who can write to the
database can copy agent A's `account_number_encrypted` onto agent B's row and read the
plaintext back through this function, because the ciphertext carries no statement about
where it belongs. With it, that swap fails the tag check. It costs nothing at write time and
**cannot be retrofitted** once ciphertext exists, so it goes in from the first write.

Local wiring: uncomment `[edge_runtime.secrets]` in `config.toml` with
`PRE_APP_SECRETS_KEY = "env(PRE_APP_SECRETS_KEY)"` and add the **name** (not a value) to
`.env.example`. Production uses `npx supabase secrets set`. Do not `config push`.

## 8. Frontend

```
app/pre-apps/page.tsx                  list + FilterTabs (admins default to submitted)
app/pre-apps/new/page.tsx              two-field create
app/pre-apps/[id]/page.tsx             detail: summary, status, documents, actions
app/pre-apps/[id]/edit/page.tsx        wizard shell, reads ?step
components/pre-app-create-form.tsx
components/pre-app-wizard.tsx          step nav + autosave indicator
components/pre-app-steps/{business,owners,terminal,profile,secrets}-step.tsx
components/pre-app-submit-button.tsx   calls submit_pre_app, renders the failing rules
components/pre-app-admin-actions.tsx   approve / decline
components/start-pre-app-button.tsx    on /leads/[id]
components/state-combobox.tsx
hooks/use-autosave.ts
lib/pre-apps.ts                        types, PRE_APP_LIST_COLUMNS, filters, badge variants
lib/pre-app-validation.ts              canonical Zod (copied into _shared)
lib/masks.ts
components/ui/{form,select,popover,command,textarea}.tsx   via npx shadcn@latest add
```

Pages follow the repo's existing shape exactly: **synchronous default export** with
unawaited `params`/`searchParams` forwarded into `<Suspense>` (required by
`cacheComponents: true`), `requireUser()` inside the async inner component, **no
`agent_id` filter in queries** (RLS scopes them — duplicating the policy in application
code is how the two drift apart), `notFound()` for both missing and not-yours so the route
isn't an id oracle, container widths list `max-w-6xl` / detail `max-w-5xl` / edit
`max-w-3xl`, and local `Field`/`Section` helpers re-declared per page.

New dependencies: `react-hook-form`, `zod`, `@hookform/resolvers`, plus `cmdk` and
`@radix-ui/react-popover` / `@radix-ui/react-select` pulled in by the shadcn components.
A native `<datalist>` (as `documents-panel.tsx` uses for doc types) is cheaper but cannot
restrict input to list values, which decision 23 requires.

### 8.1 `useAutosave`

```ts
useAutosave<T>({ form, save, enabled, delayMs = 2000 })
  : { state: "idle" | "saving" | "saved" | "error"; savedAt: Date | null; error: string | null; flush(): Promise<void> }
```

- subscribes via `form.watch(callback)` — **not** `useWatch`, so a rep typing doesn't
  re-render the step form on every keystroke
- **the payload comes from a hook-owned `pendingKeys: Set<string>` fed by `info.name`,
  not from `dirtyFields`.** This is load-bearing, not a style choice. The obvious design —
  send `dirtyFields`, then `form.reset(getValues())` on success to clear them — **loses
  data**: type in `city` at t=0, PATCH goes out at t=2s, type in `zip` at t=2.1s, response
  lands at t=2.3s and `reset()` marks *everything* clean including `zip`. `zip` still holds
  its value in form state but is now invisible to every later diff, so it is never written.
  RHF has no API to clear one field's dirty flag, so `reset()` is all-or-nothing and the
  race is structural. `pendingKeys` is cleared **before** awaiting, so a keystroke mid-flight
  re-adds its own key.
- `info.name` is `undefined` for mount and for programmatic `reset()`, and set for a user
  keystroke *and* for `setValue` — which is exactly the asymmetry needed: a server-driven
  reset never saves, but the mask's programmatic write does. (Corollary: masks must route
  through `field.onChange`/`setValue`, never `reset()`.)
- four distinct races, four distinct guards: a `generation` counter drops stale responses;
  a `cancelled` ref blocks `setState` after unmount; a `saving`/`queued` pair serializes
  writes (two overlapping PATCHes to one row have no defined ordering, and with
  last-write-wins the older can win); and a failed save **re-queues its keys** so Retry works.
- **do not save from the effect cleanup.** React 19 StrictMode double-invokes effects in
  dev, so every mount would issue a duplicate write, and by cleanup time there's nowhere to
  render a failure. Navigation awaits `flush()` explicitly; hard tab-close is covered by a
  `beforeunload` warning gated on `hasPendingChanges`. No `sendBeacon` — it can't carry the
  auth header reliably and its result is unobservable, so it would produce a silent maybe-saved.
- `clearTimeout` on unmount; `flush()` is awaited by step navigation before `router.push`
- writes use `count: "exact"` and treat `count === 0` as a failure — RLS filters rather
  than errors, so without this the UI reports a save that never happened. **Note what this
  does *not* catch:** the update policy ignores `status`, so after an admin flips a pre-app
  to `submitted` the rep's PATCH still matches the policy. `count === 0` catches only
  not-yours; the lock surfaces on the next `router.refresh()`. Comment that, because the
  reflex is to assume it covers both.
- **no `router.refresh()` on autosave** (it would re-render the server tree mid-typing, and
  `useForm` reads `defaultValues` once anyway) — only after create, step navigation, owner
  add/remove, submit, approve, and decline

### 8.2 Read-only is a separate surface, not a mode

`/pre-apps/[id]` is **always** read-only; `/pre-apps/[id]/edit` is **always** editable. The
wizard computes `canEdit = status === "draft" || role === "admin"` and `redirect()`s to the
detail page when false. This mirrors merchants and leads, and it avoids a form component
that must be correct in two modes — the mode with less traffic is the one that eventually
leaks an editable input.

An admin opening the wizard on a `submitted` pre-app gets a persistent banner: autosave plus
an audit-relevant record deserves an explicit signal, not a silent unlock.

**`requireAdmin()` is used nowhere in this flow.** It redirects to `/dashboard`, so placing
it on any `/pre-apps/*` route would lock agents out of their own applications. Admin-only
behaviour is `profile.role === "admin"` conditionals, which per the existing comment in
`app/dashboard/page.tsx` are a UX nicety only. The real boundaries stay where they're
enforceable: `approve_pre_app`'s own `is_admin()` guard, `submit_pre_app`'s server-side
re-validation, `read-pre-app-secrets` deciding masked-vs-full from `is_admin()` through the
caller-scoped client (never from a `reveal: true` flag the browser sends — the flag says what
was *asked for*, the function says what is *allowed*), and RLS for everything in Tier 1.

**Secrets: server-read the status, client-read the reveal.** The on-file/last-4 status is
fetched server-side inside the existing `<Suspense>`. The **reveal** must be a browser-side
`functions.invoke` into component state, cleared on unmount and never written to
`sessionStorage` — a server-rendered secret lands in the RSC payload, which means it's in the
HTML, in browser memory for the life of the page, and in anything that logs response bodies.
Two call sites for one function, deliberately.

### 8.3 Wizard mechanics — four traps

1. **Don't key the `<Suspense>` on `step`.** A keyed boundary is a new boundary, forcing the
   fallback on every step change. Unkeyed, navigation is a React transition and the mounted
   boundary keeps showing the current step until the new payload lands. Use `useLinkStatus()`
   for the pending affordance, with `prefetch={false}` on the step links.
2. **No `useSearchParams()`.** `step` is read server-side and passed as a prop. Under
   `cacheComponents`, `useSearchParams()` in a client component forces client-side rendering
   up to the nearest boundary during prerender.
3. **`useFieldArray` shadows `id`.** RHF appends its own `id` to each `fields` entry, and
   `pre_app_owners.id` is also `id` — so `fields[i].id` is RHF's key, and `.eq("id", …)` with
   it would target a UUID-shaped string. Form state names the primary key **`rowId`**; render
   with `key={field.id}` (RHF's), update with `.eq("id", rowId)`.
4. **"Add owner" INSERTs immediately** rather than appending an unsaved row. Every row
   therefore always has a `rowId`, autosave is pure UPDATE, and two debounced saves can't
   insert the same owner twice. It also means the secrets step can address the owner the
   moment it exists — `pre_app_owner_secrets.pre_app_owner_id` is an FK, so an SSN has
   nowhere to go until the owner row is persisted. `pre_app_owners` has no NOT NULL column
   besides `pre_app_id`, so the empty insert is legal.

Owners autosave parses `info.name` paths (`owners.2.home_city`), groups by row index, and
issues one `.update(patch, { count: "exact" }).eq("id", rowId)` per touched row. The step
shows a live "Total ownership: 85%" footer and warns when no owner reaches 51% — a **submit**
blocker, not a step blocker, so Next stays enabled.

Terminal and profile upsert with `{ onConflict: "pre_app_id" }`. PostgREST derives the
`ON CONFLICT DO UPDATE SET` list from the payload keys, so a partial upsert leaves untouched
columns alone — exactly what dirty-only saving needs, and the eleven checkboxes never touched
stay `NULL` rather than becoming `false`. **This depends on §5.1's unique constraint**;
without it `onConflict` fails with `42P10`. Fallback if that migration slips: have the draft
form insert one empty `pre_app_terminal` and one empty `pre_app_business_profile` row after
the parent, making autosave a plain UPDATE.

## 9. Changes to existing files

- `lib/documents.ts` — `ownerHref()` returns `null` for `pre_app` today; return
  `/pre-apps/${ownerId}` so the Document Center links out.
- `app/dashboard/page.tsx` — add a Pre-Apps tile to the "Book of business" row.
- `app/leads/[id]/page.tsx` — add `<StartPreAppButton>`.
- `docs/tapswipe_crm_schema.sql` — all schema changes, **first**; plus correct the stale
  note claiming production may still carry legacy grants on the secrets tables.
- `CLAUDE.md` — move Pre-Apps from "Not built yet" to "Built"; record the
  `PRE_APP_SECRETS_KEY` secret and the duplicated-validation-file rule.
- `tests/helpers/db.ts` — `seed()` gains pre-app fixtures; the `resetData()` truncate list
  gains the pre-app tables explicitly (today they're cleared only incidentally by cascade,
  and their sequences aren't reset).
- `tests/live/helpers/stack.ts` — `provisionFixtures()` gains `preAppIds` and
  `preAppOwnerIds` per persona; `teardownFixtures()` deletes them in FK order. **This
  feature breaks teardown:** `audit_log.actor_id references profiles(id)` with no `ON
  DELETE`, and `profiles` cascades from `auth.users`, so as soon as these tests write audit
  rows, `auth.admin.deleteUser()` fails on that FK. Delete the caller's `audit_log` rows
  first. (Whether `actor_id` should become `on delete set null`, preserving the trail rather
  than blocking or deleting it, is a real question and deliberately out of scope.)

## 10. Tests

| File | Suite | Asserts |
|---|---|---|
| `tests/rls/pre-apps.test.ts` | PGlite | parent + child scoping (own / admin / other agent / unauthenticated / **deactivated**); the new delete policies; unique constraints reject a duplicate child; `status` NOT NULL; the split check. Include a load-bearing case that mutates a policy to prove the test isn't vacuous, per `documents.test.ts`. |
| `tests/rls/pre-app-rpcs.test.ts` | PGlite | every `submit_pre_app` rejection branch; `approve_pre_app` — **double approve raises**, wrong status raises, missing id raises, split copied, both audit rows written; decline; reopen. |
| `tests/rls/grants.test.ts` | PGlite | additions — the four new functions are not executable by `anon`; the three secrets tables still have **zero** privileges for `anon` and `authenticated`. |
| `tests/rls/validation-copy.test.ts` | PGlite | `lib/pre-app-validation.ts` and `_shared/pre-app-validation.ts` are identical. |
| `tests/live/pre-app-secrets.test.ts` | live | 401 without a token; 403 deactivated; 404 another agent's pre-app; 404 missing id; 400 malformed SSN/routing; **encryption round-trip** (submit → read as admin returns plaintext, as owning agent returns last-4 only); `audit_log` row written; the function refuses a wrong-length key. |

## 11. Build order

Six commits, each independently working and verified:

1. **Schema hardening** — doc, migration 1, `tests/rls/pre-apps.test.ts`, fixtures.
2. **Read-only surface** — deps, `lib/pre-apps.ts`, validation, masks, list + new + detail
   pages, dashboard tile, `ownerHref` fix.
3. **Wizard + business step** — shell, `useAutosave`, state combobox, masks wired.
4. **Remaining steps** — owners (`useFieldArray` + delete), terminal (checkboxes), profile.
5. **Secrets** — `_shared/crypto.ts`, both Edge Functions, secrets step, config/env
   wiring, `tests/live/pre-app-secrets.test.ts`.
6. **State machine** — migration 2, submit button, admin approve/decline, reopen,
   "Start pre-app" on the lead page, RPC tests.

## 12. Verification

`npm test` after commits 1, 4 and 6; `npm run test:live` after 5 (needs Docker,
`supabase start`, `functions serve`). `npm run build`, `npm run lint` and
`npx tsc --noEmit` before every commit.

Manual pass, as two real users:

- **As an agent** — create a pre-app from a lead; confirm `lead_id` is set and business
  fields are prefilled. Type a partial EIN; confirm Next is disabled **and** the partial
  value survives a reload. Add two owners, remove one. Submit with no 51% owner; confirm
  the RPC rejects and the UI names the rule. Add the owner, submit; confirm status
  `submitted` and the form turns read-only.
- **As an admin** — find it under the `submitted` filter, reveal a full SSN and confirm an
  `audit_log` row appeared, approve and confirm the merchant is created with the 50/50
  split, then approve again and confirm it **raises** instead of creating a second merchant.
- **As the agent again** — confirm a decline shows the reason and reopen returns it to draft.

## 13. Open items — to confirm, not assume

- **Retention (§14.11) is unanswered and now matters concretely.** `ON DELETE CASCADE`
  means deleting a pre-app destroys its ciphertext. If merchant-application and banking
  data carries a retention requirement, admin delete should become archive instead.
- **Is an RP password ever mandatory?** `submit_pre_app` requires banking secrets but not
  terminal secrets. If some deals can't be submitted without it, that rule changes.
- **No notification on approve or decline.** §14.7 defers Realtime, so a rep finds out by
  visiting the page.
