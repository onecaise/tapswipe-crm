# Merchant bulk import

Written in phase 14 of `docs/design/intake-and-reports.md` (6 Nov 2026). **Binding rules**, like the
other files here; CLAUDE.md's security summary points at this file.

## The shape

An admin uploads the ISO Hub merchants export (CSV or XLSX) at `/admin/merchants/import` (linked from
Merchants). `stage-merchant-import` parses it into `merchant_import_rows`, marking every problem; the
review page `/admin/merchants/import/[id]` shows them grouped; "Read again" re-stages the file kept on
the batch; Commit calls `commit_merchant_import(batch_id)`. It is the user bulk import's shape
(`user-accounts.md`) with the residual commit's all-or-nothing, because every write is Postgres.

- **The file.** Columns `Type`, `Merchant ID`, `Merchant Name`, `Split`, `Agent`, `Processor`,
  `Status`, all required; `#`, `Added By` and `Override Agent` are ignored (overrides are added per
  merchant afterwards). Headers and text cells are normalised by one rule, `normText()` /
  `merchant_import_norm()`: the mojibake pair (`U+00C2 U+00A0`), a non-breaking space and a BOM become
  spaces, ASCII whitespace collapses, trimmed; compared case-insensitively. At most 2,000 rows and
  2 MiB. The first non-blank row is the header; blank rows are skipped without renumbering.
- **Merchant ID is text.** A CSV cell is never a number. In an XLSX, a numeric cell that is a float,
  over 15 digits, or displayed in exponent form is refused (`mid_precision`: use the original CSV); a
  whole number of 15 digits or fewer is accepted with a note that leading zeros are lost. A MID is 6-20
  letters and digits (Square's are alphanumeric). Duplicates and "already a merchant" compare
  case-insensitively.
- **Owner** = the one profile whose `llc_legal_name` matches Agent (A16: a rep with no LLC has their own
  legal name there). None, several, deactivated, or an admin each refuse.
- **Rate.** Split 0-1 is a fraction (0.5 → 50), `N%` a percentage; anything else, a rate not in
  hundredths, or above 50 refuses. Blank → the owner's profile rate (A31). A rate different from the
  profile rate is a note, never a refusal.
- **Processor** matches `processors` by code or label; blank stays NULL (A6). **Status** `Active` /
  `Inactive` only.
- **One merchant per MID.** A repeat with the same owner, rate and status merges (first non-blank
  processor, first name, notes); a different owner, rate or status, or two different processors,
  refuses every row involved.

## Rules

- **The commit is the only writer, and it re-derives every check.** `commit_merchant_import()` is
  `security definer`, `search_path = public, pg_temp`, `is_admin()` first (PT403), takes an advisory
  lock (`tapswipe.merchant_import`, so two batches naming one MID cannot both pass), locks the batch,
  and refuses (PT409, each code with its rows) on anything `merchant_import_findings()` derives from the
  staged **raw cells** or any blocker the parser staged. Never make it trust the parsed columns.
- **Two derivations, one rule set.** `_shared/merchant-imports.ts` (`validateMerchantRows`, staging) and
  `merchant_import_findings()` (SQL, commit) must change together; `tests/rls/merchant-import.test.ts`
  pins them against each other on a file that raises every code. No browser twin: `lib/merchant-imports.ts`
  only labels and groups.
- **The rate rides on the INSERT.** An explicit rate is carried by the insert (the split guard watches
  UPDATE only; `merchants_split_zero_to_fifty` still applies); a blank one arrives NULL/NULL for
  `default_merchant_split()`. The commit never sets `tapswipe.merchant_split_write` and never updates a
  merchant (a test reads its source).
- **The location exception is the import's alone.** `enforce_merchant_location()` admits an insert with
  NEITHER city nor state only while `tapswipe.merchant_import_write` is `'on'`, which only the commit
  sets (transaction-local, cleared before it returns). Imported merchants are the legacy shape: listed on
  `/admin/merchants/missing-location`. No address is invented. The flag also lets the commit move a
  batch to `committed`; a client can only abandon one.
- **Every merchant trigger still fires**: one `cross_agent_insert` audit row per merchant the admin does
  not own, plus ONE `commit_merchant_import` row (`detail`: file name and counts). Fails closed.
- **The tables** (`merchant_import_batches`, `merchant_import_rows`): RLS on, admin SELECT only; the one
  client write is a batch's `status` (Abandon); the service role stages; nothing references `profiles`
  (so no 27th FK and no teardown list changes; who committed is the audit row). Staging rows are kept
  after the commit as the record of the file. Both are cleared by `scripts/reset-business-data.sql`.
- **Not imported**: overrides, addresses, inactive/closed merchants beyond `Inactive` (a later file).
  The residual import reads digit-only MIDs (`parseMidCell`), so an alphanumeric Square MID imported here
  is not yet matchable by a residual file.
