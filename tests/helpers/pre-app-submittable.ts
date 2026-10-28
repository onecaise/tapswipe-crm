import { asPlatform, type TestDb } from "./db";

/**
 * Makes a pre-app pass pre_app_missing_fields() (20261028120000) completely:
 * every business field, one controlling owner with every owner field and an
 * SSN row, banking, a tax ID of the chosen kind, a valid card mix, and the
 * rep's legal names on the pre-app's rep's profile.
 *
 * Run as the platform owner with the state-machine flag on, because one
 * caller fills the seeded SUBMITTED pre-app, whose row and children are frozen
 * for everyone but an admin or the state machine (pre_apps_guard_transitions,
 * pre_app_children_guard). The flag is session-scoped here (is_local false)
 * and always cleared.
 *
 * Tests remove ONE item afterwards with REQUIRED_ITEM_REMOVALS to prove that
 * item alone blocks a submit.
 *
 * By default the pre-app's owners are replaced by one controlling owner.
 * `keepOwners` instead completes every existing owner's fields and gives each
 * an SSN row, for suites that address the seeded owners by name.
 */
export async function makeSubmittable(
  db: TestDb,
  id: number,
  { keepOwners = false }: { keepOwners?: boolean } = {},
): Promise<void> {
  await asPlatform(db);
  await db.exec(`select set_config('tapswipe.pre_app_transition', 'on', false)`);
  try {
    await db.exec(`
      update pre_apps set
        dba_name = coalesce(nullif(dba_name, ''), 'Submittable Co'),
        legal_business_name = coalesce(nullif(legal_business_name, ''), 'Submittable Co LLC'),
        contact_phone = '615-555-0100',
        physical_address = '100 Main St',
        city = 'Nashville',
        state = 'TN',
        zip = '37201',
        legal_entity_type = 'LLC',
        state_incorporated = 'TN',
        business_type = 'Retail',
        bank_name = 'First Bank',
        est_annual_volume = 1200000.00,
        est_monthly_volume = 100000.00,
        est_average_ticket = 45.00,
        est_high_ticket = 900.00,
        ein_type = 'EIN'
       where id = ${id};
    `);
    if (keepOwners) {
      await db.exec(`
        update pre_app_owners set
          owner_name = coalesce(nullif(owner_name, ''), 'Owner ' || id),
          title = 'Owner', percent_owned = coalesce(percent_owned, 1),
          dob = '1980-01-02', home_phone = '615-555-0101',
          id_type = 'Driver license', id_number = 'D' || id, id_state = 'TN',
          id_issue_date = '2020-01-01', id_expiration_date = '2030-01-01',
          home_address = '1 Home Rd', home_city = 'Nashville', home_state = 'TN',
          home_zip = '37203', length_of_ownership = '5 years'
         where pre_app_id = ${id};
        insert into pre_app_owner_secrets (pre_app_owner_id, ssn_encrypted)
        select o.id, decode('0011','hex') from pre_app_owners o
         where o.pre_app_id = ${id}
           and not exists (select 1 from pre_app_owner_secrets s where s.pre_app_owner_id = o.id);
      `);
    } else {
      await db.exec(`
        delete from pre_app_owners where pre_app_id = ${id};
        insert into pre_app_owners (
          pre_app_id, owner_name, title, percent_owned, dob, home_phone,
          id_type, id_number, id_state, id_issue_date, id_expiration_date,
          home_address, home_city, home_state, home_zip, length_of_ownership)
        values (
          ${id}, 'Control Owner', 'Owner', 100.00, '1980-01-02', '615-555-0101',
          'Driver license', 'D1234567', 'TN', '2020-01-01', '2030-01-01',
          '1 Home Rd', 'Nashville', 'TN', '37203', '5 years');
      `);
      await db.exec(`
        insert into pre_app_owner_secrets (pre_app_owner_id, ssn_encrypted)
        values ((select id from pre_app_owners where pre_app_id = ${id}), decode('0011','hex'));
      `);
    }
    await db.exec(`
      insert into pre_app_banking_secrets (pre_app_id, aba_routing_encrypted, account_number_encrypted)
      values (${id}, decode('0022','hex'), decode('0033','hex'))
      on conflict (pre_app_id) do nothing;
      insert into pre_app_tax_secrets (pre_app_id, tax_id_type, tax_id_encrypted)
      values (${id}, 'EIN', decode('0055','hex'))
      on conflict (pre_app_id) do update set tax_id_type = excluded.tax_id_type;
    `);
    await db.exec(`
      delete from pre_app_business_profile where pre_app_id = ${id};
      insert into pre_app_business_profile
        (pre_app_id, card_swiped_pct, card_keyed_pct, card_present_pct, card_not_present_pct)
      values (${id}, 60.00, 40.00, 70.00, 30.00);
    `);
    await db.exec(`
      update profiles set legal_name = 'Rep Legal Name', llc_legal_name = 'Rep Payments LLC'
       where id = (select agent_id from pre_apps where id = ${id})
         and (legal_name is null or llc_legal_name is null);
    `);
  } finally {
    await db.exec(`select set_config('tapswipe.pre_app_transition', '', false)`);
  }
}

/**
 * One SQL statement per code of pre_app_missing_fields(), each removing
 * exactly that item from a pre-app makeSubmittable() filled. `$ID` is the
 * pre-app id. Run as the platform owner with the flag on (see
 * removeRequiredItem).
 *
 * `country` and `owner_home_country` cannot be broken while their CHECKs
 * stand, so their removal drops the CHECK first -- proving the function
 * still carries the rule if a CHECK is ever relaxed.
 */
export const REQUIRED_ITEM_REMOVALS: Record<string, string> = {
  dba_name: `update pre_apps set dba_name = '  ' where id = $ID`,
  legal_business_name: `update pre_apps set legal_business_name = '' where id = $ID`,
  contact_phone: `update pre_apps set contact_phone = null where id = $ID`,
  physical_address: `update pre_apps set physical_address = ' ' where id = $ID`,
  city: `update pre_apps set city = '..' where id = $ID`,
  state: `update pre_apps set state = 'Tennessee' where id = $ID`,
  zip: `update pre_apps set zip = '372' where id = $ID`,
  country: `alter table pre_apps drop constraint pre_apps_country_us;
            update pre_apps set country = 'CA' where id = $ID`,
  legal_entity_type: `update pre_apps set legal_entity_type = null where id = $ID`,
  state_incorporated: `update pre_apps set state_incorporated = null where id = $ID`,
  business_type: `update pre_apps set business_type = '' where id = $ID`,
  bank_name: `update pre_apps set bank_name = null where id = $ID`,
  est_annual_volume: `update pre_apps set est_annual_volume = 0 where id = $ID`,
  est_monthly_volume: `update pre_apps set est_monthly_volume = null where id = $ID`,
  est_average_ticket: `update pre_apps set est_average_ticket = 0 where id = $ID`,
  est_high_ticket: `update pre_apps set est_high_ticket = null where id = $ID`,
  tax_id: `delete from pre_app_tax_secrets where pre_app_id = $ID`,
  owner_required: `delete from pre_app_owners where pre_app_id = $ID`,
  owner_control: `update pre_app_owners set percent_owned = 50 where pre_app_id = $ID`,
  owner_name: `update pre_app_owners set owner_name = null where pre_app_id = $ID`,
  owner_title: `update pre_app_owners set title = '' where pre_app_id = $ID`,
  owner_percent_owned: `insert into pre_app_owners (pre_app_id, owner_name, title, percent_owned, dob, home_phone,
      id_type, id_number, id_state, id_issue_date, id_expiration_date,
      home_address, home_city, home_state, home_zip, length_of_ownership)
    values ($ID, 'Second Owner', 'Partner', null, '1981-01-02', '615-555-0102',
      'Passport', 'P1', 'TN', '2020-01-01', '2030-01-01',
      '2 Home Rd', 'Nashville', 'TN', '37203', '2 years');
    insert into pre_app_owner_secrets (pre_app_owner_id, ssn_encrypted)
    values ((select id from pre_app_owners where owner_name = 'Second Owner' and pre_app_id = $ID), decode('0012','hex'))`,
  owner_dob: `update pre_app_owners set dob = null where pre_app_id = $ID`,
  owner_home_phone: `update pre_app_owners set home_phone = null where pre_app_id = $ID`,
  owner_id_type: `update pre_app_owners set id_type = null where pre_app_id = $ID`,
  owner_id_number: `update pre_app_owners set id_number = ' ' where pre_app_id = $ID`,
  owner_id_state: `update pre_app_owners set id_state = 'XYZ' where pre_app_id = $ID`,
  owner_id_issue_date: `update pre_app_owners set id_issue_date = null where pre_app_id = $ID`,
  owner_id_expiration_date: `update pre_app_owners set id_expiration_date = null where pre_app_id = $ID`,
  owner_home_address: `update pre_app_owners set home_address = null where pre_app_id = $ID`,
  owner_home_city: `update pre_app_owners set home_city = '' where pre_app_id = $ID`,
  owner_home_state: `update pre_app_owners set home_state = null where pre_app_id = $ID`,
  owner_home_zip: `update pre_app_owners set home_zip = 'abcde' where pre_app_id = $ID`,
  owner_home_country: `alter table pre_app_owners drop constraint pre_app_owners_home_country_us;
                       update pre_app_owners set home_country = 'MX' where pre_app_id = $ID`,
  owner_length_of_ownership: `update pre_app_owners set length_of_ownership = null where pre_app_id = $ID`,
  owner_ssn: `delete from pre_app_owner_secrets
               where pre_app_owner_id in (select id from pre_app_owners where pre_app_id = $ID)`,
  card_swiped_keyed_total: `update pre_app_business_profile set card_keyed_pct = 30 where pre_app_id = $ID`,
  card_present_total: `update pre_app_business_profile set card_not_present_pct = null where pre_app_id = $ID`,
  banking: `delete from pre_app_banking_secrets where pre_app_id = $ID`,
  rep_identity: `update profiles set llc_legal_name = null
                  where id = (select agent_id from pre_apps where id = $ID)`,
};

/** Applies one REQUIRED_ITEM_REMOVALS entry to pre-app `id`. */
export async function removeRequiredItem(
  db: TestDb,
  id: number,
  code: string,
): Promise<void> {
  const sql = REQUIRED_ITEM_REMOVALS[code];
  if (!sql) throw new Error(`no removal for ${code}`);
  await asPlatform(db);
  await db.exec(`select set_config('tapswipe.pre_app_transition', 'on', false)`);
  try {
    await db.exec(sql.replaceAll("$ID", String(id)));
  } finally {
    await db.exec(`select set_config('tapswipe.pre_app_transition', '', false)`);
  }
}
