-- Fixture for scripts/reset-business-data.sql: at least one row in EVERY table
-- that script clears, plus three accounts in auth.users + profiles that it must
-- leave byte-for-byte alone. processors, the other kept table, already holds
-- its five rows from 20261023130000; merchant 1 points at one of them, so the
-- reset truncates a table with a foreign key INTO a kept table. Used by both
-- harnesses:
--
--   tests/rls/reset-business-data.test.ts   PGlite (auth.users is the shim)
--   tests/live/reset-business-data.test.ts  the local stack, inside a
--                                           transaction that always rolls back
--
-- Fake data only. Every insert goes through the real triggers and constraints;
-- the one escape hatch used is tapswipe.pre_app_transition, which seed() in
-- tests/helpers/db.ts documents, and only so a 'submitted' pre-app can exist.
--
-- The accounts carry role, territory, manager_id and agent_number so a reset
-- that touched any profile column would change its md5.
--
-- No backslash escapes anywhere in this file: the PGlite test loads it into a
-- JS string, and bytea goes through decode(..., 'hex') for the same reason.

insert into auth.users (id, email) values
  ('a0000000-0000-4000-8000-000000000001', 'reset-admin@tapswipe.test'),
  ('a0000000-0000-4000-8000-000000000002', 'reset-agent@tapswipe.test'),
  ('a0000000-0000-4000-8000-000000000003', 'reset-agent2@tapswipe.test');

insert into profiles (id, full_name, email, role, is_active, agent_number, territory, manager_id) values
  ('a0000000-0000-4000-8000-000000000001', 'Reset Admin',  'reset-admin@tapswipe.test',  'admin', true,  null,     'HQ',   null),
  ('a0000000-0000-4000-8000-000000000002', 'Reset Agent',  'reset-agent@tapswipe.test',  'agent', true,  'RST-01', 'East', 'a0000000-0000-4000-8000-000000000001'),
  ('a0000000-0000-4000-8000-000000000003', 'Reset Agent2', 'reset-agent2@tapswipe.test', 'agent', false, 'RST-02', 'West', 'a0000000-0000-4000-8000-000000000001');

-- Sales pipeline.
insert into leads (agent_id, dba) values
  ('a0000000-0000-4000-8000-000000000002', 'Reset Lead A'),
  ('a0000000-0000-4000-8000-000000000003', 'Reset Lead B');

insert into ghost_sheets (agent_id, lead_id, dba, status) values
  ('a0000000-0000-4000-8000-000000000002',
   (select id from leads where dba = 'Reset Lead A'), 'Reset Sheet', 'converted');

select set_config('tapswipe.pre_app_transition', 'on', true);
insert into pre_apps (agent_id, status, dba_name, legal_business_name, city, state, lead_id) values
  ('a0000000-0000-4000-8000-000000000002', 'draft',     'Reset App 1', 'Reset App 1 LLC', 'Nashville', 'TN',
   (select id from leads where dba = 'Reset Lead A')),
  ('a0000000-0000-4000-8000-000000000003', 'submitted', 'Reset App 2', 'Reset App 2 LLC', 'Memphis',   'TN', null);
select set_config('tapswipe.pre_app_transition', '', true);

insert into pre_app_owners (pre_app_id, owner_name, percent_owned) values
  ((select id from pre_apps where dba_name = 'Reset App 1'), 'Fake Owner', 100.00);
insert into pre_app_terminal (pre_app_id, terminal_type) values
  ((select id from pre_apps where dba_name = 'Reset App 1'), 'Fake Terminal');
insert into pre_app_business_profile (pre_app_id, card_swiped_pct, card_keyed_pct) values
  ((select id from pre_apps where dba_name = 'Reset App 1'), 50.00, 50.00);
insert into pre_app_owner_secrets (pre_app_owner_id, ssn_encrypted) values
  ((select id from pre_app_owners where owner_name = 'Fake Owner'), decode('00aa', 'hex'));
insert into pre_app_banking_secrets (pre_app_id, aba_routing_encrypted, account_number_encrypted) values
  ((select id from pre_apps where dba_name = 'Reset App 1'), decode('00bb', 'hex'), decode('00cc', 'hex'));
insert into pre_app_terminal_secrets (pre_app_id, rp_password_encrypted) values
  ((select id from pre_apps where dba_name = 'Reset App 1'), decode('00dd', 'hex'));
insert into pre_app_tax_secrets (pre_app_id, tax_id_type, tax_id_encrypted) values
  ((select id from pre_apps where dba_name = 'Reset App 1'), 'EIN', decode('00ee', 'hex'));

insert into merchants (agent_id, mid, dba, status, city, state, pre_app_id, processor) values
  ('a0000000-0000-4000-8000-000000000002', 'RST-MID-1', 'Reset Merchant 1', 'active', 'Nashville', 'TN',
   (select id from pre_apps where dba_name = 'Reset App 1'), 'TSYS'),
  ('a0000000-0000-4000-8000-000000000003', 'RST-MID-2', 'Reset Merchant 2', 'active', 'Memphis',   'TN', null, null);

-- Legacy documents: the key must match agent/owner_type/owner_id/<name>.
insert into documents (agent_id, owner_type, owner_id, doc_type, file_key, file_name)
select 'a0000000-0000-4000-8000-000000000002', 'merchant', m.id, 'Fake doc',
       'a0000000-0000-4000-8000-000000000002/merchant/' || m.id || '/fake-object', 'fake.pdf'
  from merchants m where m.dba = 'Reset Merchant 1';

-- Support, notes, tasks, bug reports.
insert into support_tickets (agent_id, merchant_id, subject) values
  ('a0000000-0000-4000-8000-000000000002',
   (select id from merchants where dba = 'Reset Merchant 1'), 'Reset ticket');
insert into support_ticket_replies (ticket_id, author_id, body) values
  ((select id from support_tickets where subject = 'Reset ticket'),
   'a0000000-0000-4000-8000-000000000001', 'Fake reply');
insert into notes (agent_id, owner_type, owner_id, body) values
  ('a0000000-0000-4000-8000-000000000002', 'lead',
   (select id from leads where dba = 'Reset Lead A'), 'Fake note');
insert into tasks (agent_id, owner_type, owner_id, title) values
  ('a0000000-0000-4000-8000-000000000002', 'merchant',
   (select id from merchants where dba = 'Reset Merchant 1'), 'Fake task');
insert into bug_reports (agent_id, page, description) values
  ('a0000000-0000-4000-8000-000000000002', '/dashboard', 'Fake bug');

-- Residuals: a batch, a staged row, a share, a shared ledger line (which holds
-- merchant_rep_shares through its RESTRICT key), a history row and a paid
-- month. The batch and the closure carry a processor (20261030120000), so the
-- reset truncates two more tables with a foreign key INTO a kept table. Their
-- month is last month, computed, because both refuse a month outside the
-- import window and a fixed date would expire.
insert into rep_payout_batches (imported_by, file_key, file_name, processor, period) values
  ('a0000000-0000-4000-8000-000000000001', 'reset/fake.xlsx', 'fake.xlsx', 'TSYS',
   (date_trunc('month', now() at time zone 'UTC') - interval '1 month')::date);
insert into payout_period_closures (period, processor) values
  ((date_trunc('month', now() at time zone 'UTC') - interval '1 month')::date, 'TSYS');
insert into rep_payout_import_rows (batch_id, row_number) values
  ((select id from rep_payout_batches where file_key = 'reset/fake.xlsx'), 1);
insert into merchant_rep_shares (merchant_id, primary_agent_id, secondary_agent_id,
                                 primary_rep_pct, secondary_rep_pct, effective_from) values
  ((select id from merchants where dba = 'Reset Merchant 1'),
   'a0000000-0000-4000-8000-000000000002', 'a0000000-0000-4000-8000-000000000003',
   25, 25, '2026-08-01');
insert into rep_payout_rows (agent_id, period, mid, merchant_id, batch_id,
                             rep_share_id, share_role, primary_rep_pct, secondary_rep_pct) values
  ('a0000000-0000-4000-8000-000000000002', '2026-08-01', 'RST-MID-1',
   (select id from merchants where dba = 'Reset Merchant 1'),
   (select id from rep_payout_batches where file_key = 'reset/fake.xlsx'),
   (select id from merchant_rep_shares limit 1), 'primary', 25, 25);
insert into rep_payout_row_history (row_id, period, agent_id, mid, field) values
  ((select id from rep_payout_rows where mid = 'RST-MID-1'), '2026-08-01',
   'a0000000-0000-4000-8000-000000000002', 'RST-MID-1', 'residual_income');
-- An override (20261102120000) and the credit line it paid, which holds
-- merchant_overrides through its RESTRICT key as the shared line holds the share.
insert into merchant_overrides (merchant_id, recipient_id, override_pct, effective_from) values
  ((select id from merchants where dba = 'Reset Merchant 1'),
   'a0000000-0000-4000-8000-000000000001', 10, '2026-08-01');
insert into rep_payout_rows (agent_id, period, processor, mid, merchant_id, batch_id,
                             line_kind, override_id, override_role, override_amount) values
  ('a0000000-0000-4000-8000-000000000001', '2026-08-01', 'TSYS', 'RST-MID-1',
   (select id from merchants where dba = 'Reset Merchant 1'),
   (select id from rep_payout_batches where file_key = 'reset/fake.xlsx'),
   'override', (select id from merchant_overrides limit 1), 'credit', 1.00);

-- Bulk user import staging.
insert into user_import_batches (imported_by, file_name, source_text) values
  ('a0000000-0000-4000-8000-000000000001', 'fake.csv', 'name,email');
insert into user_import_rows (batch_id, row_number) values
  ((select id from user_import_batches where file_name = 'fake.csv'), 1);

-- Reference data: catalog, marketing library, company documents.
insert into brands (name) values ('Reset Brand');
insert into products (name, category, brand, kind, list_price) values
  ('Reset Device', 'Terminals',   'Reset Brand', 'device', 100.00),
  ('Reset Addon',  'Accessories', 'Reset Brand', 'addon',  10.00);
insert into product_compatibility (addon_product_id, device_product_id) values
  ((select id from products where name = 'Reset Addon'),
   (select id from products where name = 'Reset Device'));

insert into quotes (agent_id, lead_id, customer_name) values
  ('a0000000-0000-4000-8000-000000000002',
   (select id from leads where dba = 'Reset Lead A'), 'ignored');
insert into quote_line_items (quote_id, product_id, quantity) values
  ((select id from quotes limit 1), (select id from products where name = 'Reset Device'), 2);

insert into marketing_materials (category, title, uploaded_by) values
  ('Flyers', 'Reset Flyer', 'a0000000-0000-4000-8000-000000000001');
insert into marketing_material_events (material_id, agent_id, event_type, lead_id) values
  ((select id from marketing_materials where title = 'Reset Flyer'),
   'a0000000-0000-4000-8000-000000000002', 'viewed',
   (select id from leads where dba = 'Reset Lead A'));
insert into business_documents (category, title, uploaded_by) values
  ('Policies', 'Reset Policy', 'a0000000-0000-4000-8000-000000000001');

-- audit_log already holds the cross_agent_insert rows the triggers wrote above
-- (actor NULL: the seed runs with no JWT). One more, explicitly, so it is never
-- empty even if those triggers change.
insert into audit_log (actor_id, action, table_name, row_id) values
  ('a0000000-0000-4000-8000-000000000001', 'fixture', 'profiles', 'a0000000-0000-4000-8000-000000000002');
