# Grants inventory: tables created after `20261023120000`

Supabase stopped auto-granting Data API access to new tables on 30 Oct 2026. Since then, a table a
migration creates has exactly the grants that migration writes, and nothing else. This repo never
relied on the automatic grants: `20260805210000_revoke_legacy_anon_grants.sql` removed the old
default privileges (CLAUDE.md, "RLS and grants are two separate layers"). This file lists, for every
table a migration created after `20261023120000`, the exact table grants each Data API role should
hold, which migration sets them, and one read-only query that compares a project against the list.

Written in phase 13 of `docs/design/intake-and-reports.md` (4 Nov 2026). Pinned by
`tests/rls/grants-inventory.test.ts` (PGlite) and `tests/live/grants-inventory.test.ts` (the local
stack). Both run the query below **as written here**, and both fail on any table created after the
cutoff that is not in it.

## The six tables

"none" means no privilege at all. "ALL" is `grant all`, which `information_schema` lists as the
seven privileges DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE and UPDATE.

| Table | Migration that sets the grants | `anon` | `authenticated` | `service_role` | Why |
| --- | --- | --- | --- | --- | --- |
| `merchant_import_batches` | `20261106120000_merchant_import.sql` | none | SELECT (+ column UPDATE on `status`, which `role_table_grants` does not list) | INSERT, SELECT, UPDATE | The merchant import's batches. Admin SELECT and Abandon by policy; `stage-merchant-import` writes as the service role; `commit_merchant_import()` (definer) commits. |
| `merchant_import_rows` | `20261106120000_merchant_import.sql` | none | SELECT | DELETE, INSERT, SELECT | The staged rows. Admin SELECT by policy; the service role stages them and clears them before a re-read. |
| `processors` | `20261023130000_processors.sql` | none | SELECT | SELECT | Reference list, changed only by migration. The service role reads it to check a chosen processor. |
| `pre_app_tax_secrets` | `20261026140000_pre_app_tax_secrets.sql` | none | none | ALL | The fourth secrets table: zero policies, no client grant, Edge Function only (CLAUDE.md, "Three tiers"). |
| `payout_period_closures` | `20261030120000_import_schema.sql` | none | SELECT | SELECT | Mark paid. Admin SELECT by policy; written only by `close_payout_period()` / `reopen_payout_period()` (definer). |
| `merchant_overrides` | `20261102120000_merchant_overrides.sql` | none | SELECT | DELETE, SELECT | Admin SELECT by policy; written only by its definer RPCs (set, end, cancel, and since `20261116120000` `set_merchant_override_funding`, which adds no grant). The service role reads and deletes for the teardowns. |

Each migration starts with `revoke all … from` the Data API roles (and `public` on the two tables
that have a sequence), then grants. That first revoke is load-bearing on the local stack: there,
the default ACL for tables `postgres` creates in `public` still hands `service_role` TRUNCATE,
REFERENCES, TRIGGER and MAINTAIN (`pg_default_acl`, checked 4 Nov 2026). A table that left out the
revoke would show those extra privileges for `service_role` here, and the tests would fail.

Sequences are not in `role_table_grants`, so they are not in the query.

- `pre_app_tax_secrets_id_seq`: `service_role` only (`grant all on sequence`).
- `merchant_overrides_id_seq`: no Data API role. Its inserts run as the owner inside definer
  functions.
- `merchant_import_batches_id_seq`, `merchant_import_rows_id_seq`: USAGE for `service_role` only
  (`stage-merchant-import` inserts).
- `processors` and `payout_period_closures` have no sequence (natural keys).

The tests check the four sequences too.

## Does any table rely on an automatic grant?

**No.** Checked 4 Nov 2026 in three ways:
- Each of the four migrations above writes every grant the table needs. (Phase 14 added
  `20261106120000`, which does the same for its two tables.)
- The local stack's catalog matched this list before phase 13 changed anything.
- No migration since the cutoff creates a table any other way (no `create table … as`, and no
  `like … including all`, which would copy a privilege).

So no fix migration was needed.

## The query

Read-only, one result table. Run it in the SQL Editor on dev or prod. Every row should say
`matches = true`. On a project that has not had the migration yet, `table_exists` is false and the
row does not match. (As of 4 Nov 2026 that is all four tables on prod, which has no migration
from `20261014120000` on.)

<!-- grants-inventory-query:start -->
```sql
with expected (table_name, grantee, privileges, set_by) as (
  values
    ('merchant_import_batches', 'anon',         '',                                                              '20261106120000'),
    ('merchant_import_batches', 'authenticated', 'SELECT',                                                       '20261106120000'),
    ('merchant_import_batches', 'service_role',  'INSERT, SELECT, UPDATE',                                       '20261106120000'),
    ('merchant_import_rows',    'anon',          '',                                                              '20261106120000'),
    ('merchant_import_rows',    'authenticated', 'SELECT',                                                        '20261106120000'),
    ('merchant_import_rows',    'service_role',  'DELETE, INSERT, SELECT',                                        '20261106120000'),
    ('merchant_overrides',     'anon',          '',                                                              '20261102120000'),
    ('merchant_overrides',     'authenticated', 'SELECT',                                                        '20261102120000'),
    ('merchant_overrides',     'service_role',  'DELETE, SELECT',                                                '20261102120000'),
    ('payout_period_closures', 'anon',          '',                                                              '20261030120000'),
    ('payout_period_closures', 'authenticated', 'SELECT',                                                        '20261030120000'),
    ('payout_period_closures', 'service_role',  'SELECT',                                                        '20261030120000'),
    ('pre_app_tax_secrets',    'anon',          '',                                                              '20261026140000'),
    ('pre_app_tax_secrets',    'authenticated', '',                                                              '20261026140000'),
    ('pre_app_tax_secrets',    'service_role',  'DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE', '20261026140000'),
    ('processors',             'anon',          '',                                                              '20261023130000'),
    ('processors',             'authenticated', 'SELECT',                                                        '20261023130000'),
    ('processors',             'service_role',  'SELECT',                                                        '20261023130000')
),
actual as (
  select g.table_name::text as table_name,
         g.grantee::text as grantee,
         string_agg(g.privilege_type::text, ', ' order by g.privilege_type::text) as privileges
    from information_schema.role_table_grants g
   where g.table_schema = 'public'
     and g.grantee in ('anon', 'authenticated', 'service_role')
   group by g.table_name, g.grantee
)
select e.table_name,
       e.grantee,
       e.set_by,
       to_regclass('public.' || e.table_name) is not null as table_exists,
       coalesce(nullif(e.privileges, ''), 'none') as expected,
       coalesce(a.privileges, 'none') as actual,
       to_regclass('public.' || e.table_name) is not null
         and coalesce(a.privileges, '') = e.privileges as matches
  from expected e
  left join actual a on a.table_name = e.table_name and a.grantee = e.grantee
 order by e.table_name, e.grantee;
```
<!-- grants-inventory-query:end -->

## Adding a table

A migration that creates a table in `public` after the cutoff has to do four things:
- write its own `revoke all` and `grant` lines (the four-step checklist in CLAUDE.md);
- add the table to the table above;
- add a row per Data API role to the query's `expected` list;
- add the same rows to `EXPECTED` in `tests/helpers/grants-inventory.ts`.

The tests compare the tables the migrations create since the cutoff with the query's list, so a
missing table fails them. If you change the query, keep it one statement with one result table:
the tests run it exactly as it appears between the two markers.
