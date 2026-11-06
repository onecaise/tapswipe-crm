import { readdir, readFile } from "node:fs/promises";

/**
 * docs/claude/grants-inventory.md, as data: the tables a migration created
 * after CUTOFF, the exact table grants each Data API role should hold on them,
 * and the doc's read-only query, read out of the doc so the tests run the query
 * an admin will paste into the SQL Editor, not a copy of it.
 *
 * EXPECTED repeats the query's `expected` list on purpose: changing what a role
 * should hold means changing both, so neither the doc nor this file can drift
 * alone.
 */

export const CUTOFF = "20261023120000";

export type InventoryRow = {
  table_name: string;
  grantee: "anon" | "authenticated" | "service_role";
  set_by: string;
  /** Comma-separated, sorted; "none" for no privilege. */
  expected: string;
};

const ALL = "DELETE, INSERT, REFERENCES, SELECT, TRIGGER, TRUNCATE, UPDATE";

export const EXPECTED: InventoryRow[] = [
  { table_name: "merchant_import_batches", grantee: "anon", set_by: "20261106120000", expected: "none" },
  { table_name: "merchant_import_batches", grantee: "authenticated", set_by: "20261106120000", expected: "SELECT" },
  { table_name: "merchant_import_batches", grantee: "service_role", set_by: "20261106120000", expected: "INSERT, SELECT, UPDATE" },
  { table_name: "merchant_import_rows", grantee: "anon", set_by: "20261106120000", expected: "none" },
  { table_name: "merchant_import_rows", grantee: "authenticated", set_by: "20261106120000", expected: "SELECT" },
  { table_name: "merchant_import_rows", grantee: "service_role", set_by: "20261106120000", expected: "DELETE, INSERT, SELECT" },
  { table_name: "merchant_overrides", grantee: "anon", set_by: "20261102120000", expected: "none" },
  { table_name: "merchant_overrides", grantee: "authenticated", set_by: "20261102120000", expected: "SELECT" },
  { table_name: "merchant_overrides", grantee: "service_role", set_by: "20261102120000", expected: "DELETE, SELECT" },
  { table_name: "payout_period_closures", grantee: "anon", set_by: "20261030120000", expected: "none" },
  { table_name: "payout_period_closures", grantee: "authenticated", set_by: "20261030120000", expected: "SELECT" },
  { table_name: "payout_period_closures", grantee: "service_role", set_by: "20261030120000", expected: "SELECT" },
  { table_name: "pre_app_tax_secrets", grantee: "anon", set_by: "20261026140000", expected: "none" },
  { table_name: "pre_app_tax_secrets", grantee: "authenticated", set_by: "20261026140000", expected: "none" },
  { table_name: "pre_app_tax_secrets", grantee: "service_role", set_by: "20261026140000", expected: ALL },
  { table_name: "processors", grantee: "anon", set_by: "20261023130000", expected: "none" },
  { table_name: "processors", grantee: "authenticated", set_by: "20261023130000", expected: "SELECT" },
  { table_name: "processors", grantee: "service_role", set_by: "20261023130000", expected: "SELECT" },
];

/** Sequence privileges on the inventory's two sequences: [sequence, role, usage]. */
export const EXPECTED_SEQUENCES: [string, InventoryRow["grantee"], boolean][] = [
  ["pre_app_tax_secrets_id_seq", "anon", false],
  ["pre_app_tax_secrets_id_seq", "authenticated", false],
  ["pre_app_tax_secrets_id_seq", "service_role", true],
  ["merchant_overrides_id_seq", "anon", false],
  ["merchant_overrides_id_seq", "authenticated", false],
  ["merchant_overrides_id_seq", "service_role", false],
  ["merchant_import_batches_id_seq", "anon", false],
  ["merchant_import_batches_id_seq", "authenticated", false],
  ["merchant_import_batches_id_seq", "service_role", true],
  ["merchant_import_rows_id_seq", "anon", false],
  ["merchant_import_rows_id_seq", "authenticated", false],
  ["merchant_import_rows_id_seq", "service_role", true],
];

const DOC = new URL("../../docs/claude/grants-inventory.md", import.meta.url);
const MIGRATIONS = new URL("../../supabase/migrations/", import.meta.url);

/** The query between the doc's two markers, without its ```sql fence. */
export async function inventoryQuery(): Promise<string> {
  const doc = (await readFile(DOC, "utf8")).replace(/\r\n/g, "\n");
  const match = /<!-- grants-inventory-query:start -->\n```sql\n([\s\S]*?)\n```\n<!-- grants-inventory-query:end -->/.exec(doc);
  if (!match) throw new Error("docs/claude/grants-inventory.md: no query between the markers");
  return match[1];
}

/**
 * Every table a migration after CUTOFF creates in public and no later
 * migration drops, by name. Read from the migration text, so a new table
 * appears here whether or not anyone remembers the inventory.
 */
export async function tablesCreatedSinceCutoff(): Promise<string[]> {
  const files = (await readdir(MIGRATIONS)).filter((f) => f.endsWith(".sql") && f.slice(0, 14) > CUTOFF).sort();
  const live = new Set<string>();
  for (const file of files) {
    const sql = (await readFile(new URL(file, MIGRATIONS), "utf8"))
      .split(/\r?\n/)
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n");
    const events: [number, "create" | "drop", string][] = [];
    for (const m of sql.matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?([a-z_][a-z0-9_]*)/gi)) {
      events.push([m.index!, "create", m[1].toLowerCase()]);
    }
    for (const m of sql.matchAll(/drop\s+table\s+(?:if\s+exists\s+)?(?:public\.)?([a-z_][a-z0-9_]*)/gi)) {
      events.push([m.index!, "drop", m[1].toLowerCase()]);
    }
    for (const [, kind, name] of events.sort((a, b) => a[0] - b[0])) {
      if (kind === "create") live.add(name);
      else live.delete(name);
    }
  }
  return [...live].sort();
}
