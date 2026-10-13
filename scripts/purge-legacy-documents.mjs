#!/usr/bin/env node
/**
 * Purges the LEGACY per-record documents: every object in the `documents`
 * bucket, then every row in the `documents` table.
 *
 *   node scripts/purge-legacy-documents.mjs --target dev           # dry run
 *   node scripts/purge-legacy-documents.mjs --target dev --write   # delete
 *
 * Why it exists: the CRM stopped accepting merchant paperwork (voided checks,
 * driver's licences) on 13 Oct 2026. Migration 20261013121000 closed the path
 * -- no client can write the table, and the three functions that signed into
 * the bucket were removed -- but deliberately kept the table and the bucket,
 * because the files already uploaded are sensitive and their removal should be
 * a decision someone takes on purpose, with a dry run in front of them.
 *
 * WHAT IT DOES, in this order, and why the order:
 *
 *   1. Counts the rows per owner_type, and LISTS THE BUCKET ITSELF -- every
 *      object under every prefix, not just the keys the rows name. An upload
 *      whose row was never written (the one non-atomic window the old panel
 *      had), or a row deleted without its object, leaves a file no row points
 *      at. Working from the rows alone would leave exactly those behind.
 *   2. With --write: removes the objects through the Storage API's remove(),
 *      in batches. NOT by deleting storage.objects rows in SQL -- that removes
 *      the metadata and leaves the bytes in the underlying store, where they
 *      are invisible and still there.
 *   3. Then deletes the table rows -- only those whose object is gone (removed
 *      in step 2, or never in the bucket). A row whose object failed to remove
 *      is KEPT and reported, so a re-run finds it again rather than the file
 *      outliving the only record of it.
 *   4. Prints what it did.
 *
 * Each deleted row also leaves an audit_log row (cross_agent_delete, actor_id
 * null): documents_audit_cross_agent is kept on the table for exactly this.
 *
 * TARGET: dev, and nothing else. There is no local target and no prod target,
 * and ALLOW_PROD_SUPABASE is not honoured. The client is built from the thing
 * that was CHECKED -- the guard (scripts/check-linked-project.mjs) runs, and
 * the URL is then derived from the same link file it read -- so the
 * `npm run db:push -- --db-url <prod>` shape (guard says "dev, ok" while the
 * command goes elsewhere) is unreachable. The derived URL is then checked
 * against dev's host once more before anything connects. Running this against
 * production is a deliberate edit to this file, reviewed, not a flag.
 *
 * It never prints a key.
 */

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

export const DEV_REF = "vdjtosofrimipklbdjbi"; // tapswipe-crm-dev
export const PROD_REF = "zuvsdkjnfstrjahstsmg"; // tapwipe-crm-prod
export const DEV_URL = `https://${DEV_REF}.supabase.co`;
export const LEGACY_BUCKET = "documents";
export const REMOVE_BATCH_SIZE = 100;
const PAGE_SIZE = 1000;
const LINK_FILE = "supabase/.temp/linked-project.json";
const GUARD = "scripts/check-linked-project.mjs";

// ---------------------------------------------------------------------------
// Arguments and target -- pure, so the refusals are unit-tested.
// ---------------------------------------------------------------------------

/**
 * Reads the command line. --target is REQUIRED and must be `dev`: a purge with
 * no named target is exactly the kind of command that ends up aimed at the
 * wrong project.
 */
export function parseArgs(argv) {
  const write = argv.includes("--write");
  const i = argv.indexOf("--target");
  const target = i === -1 ? undefined : argv[i + 1];
  if (target === undefined) {
    throw new Error("--target dev is required. There is no default target.");
  }
  if (target !== "dev") {
    throw new Error(
      `--target must be dev, got "${target}". This script has no local or prod target.`,
    );
  }
  const unknown = argv.filter(
    (arg, idx) => arg.startsWith("--") && !["--write", "--target"].includes(arg) && argv[idx - 1] !== "--target",
  );
  if (unknown.length > 0) {
    throw new Error(`Unknown option(s): ${unknown.join(", ")}`);
  }
  return { write, target };
}

/**
 * Refuses any linked project but dev, and any URL but dev's. Called with what
 * the link file says, after the guard has run.
 */
export function assertDevTarget(linkedRef, url) {
  if (linkedRef === PROD_REF) {
    throw new Error(
      `Refusing PRODUCTION (${linkedRef}). This script has no prod path at all.`,
    );
  }
  if (linkedRef !== DEV_REF) {
    throw new Error(`Linked ref ${linkedRef} is not dev (${DEV_REF}).`);
  }
  let host;
  try {
    host = new URL(url).host;
  } catch {
    throw new Error(`Not a URL: ${url}`);
  }
  if (url !== DEV_URL || host !== `${DEV_REF}.supabase.co`) {
    throw new Error(`Refusing ${host}: the only host this script will touch is ${DEV_REF}.supabase.co.`);
  }
}

// ---------------------------------------------------------------------------
// Storage and table helpers -- take clients as arguments, so the live suite
// can drive them against the local stack on keys it created itself.
// ---------------------------------------------------------------------------

/**
 * Every object key in a bucket, at any depth.
 *
 * Storage's list() is one level deep: a "folder" comes back as an entry with a
 * null id, and its contents need a list() of their own. Legacy keys are
 * {agent}/{owner_type}/{owner_id}/{uuid}, four levels, but nothing here assumes
 * that -- an orphan at any depth is caught. Paged, because list() caps at
 * `limit` and a silent prefix of the bucket is the failure this exists to
 * avoid.
 */
export async function listAllObjects(storage, bucket) {
  const keys = [];
  const pending = [""];
  while (pending.length > 0) {
    const prefix = pending.shift();
    for (let offset = 0; ; offset += PAGE_SIZE) {
      const { data, error } = await storage.from(bucket).list(prefix, {
        limit: PAGE_SIZE,
        offset,
        sortBy: { column: "name", order: "asc" },
      });
      if (error) throw new Error(`list ${bucket}/${prefix}: ${error.message}`);
      for (const entry of data ?? []) {
        const path = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
        // A folder placeholder has no id; an object has one.
        if (entry.id === null || entry.id === undefined) pending.push(path);
        else keys.push(path);
      }
      if (!data || data.length < PAGE_SIZE) break;
    }
  }
  return keys;
}

/**
 * Removes keys through the Storage API, `size` at a time. Returns which keys
 * were confirmed removed and which batches failed, rather than throwing on the
 * first failure: a half-finished purge must say exactly what is left.
 */
export async function removeInBatches(storage, bucket, keys, size = REMOVE_BATCH_SIZE) {
  const removed = [];
  const failed = [];
  for (let i = 0; i < keys.length; i += size) {
    const batch = keys.slice(i, i + size);
    const { data, error } = await storage.from(bucket).remove(batch);
    if (error) {
      failed.push(...batch.map((key) => ({ key, reason: error.message })));
      continue;
    }
    // remove() reports the objects it actually deleted. A key it does not
    // echo was not there (or not removed) -- counted as not-removed, and the
    // caller decides whether that matters.
    const gone = new Set((data ?? []).map((o) => o.name));
    for (const key of batch) {
      if (gone.has(key)) removed.push(key);
      else failed.push({ key, reason: "not reported removed" });
    }
  }
  return { removed, failed };
}

/** Every documents row's id, owner_type and file_key, paged past max_rows. */
export async function readLegacyRows(db) {
  const rows = [];
  for (let from = 0; ; from += PAGE_SIZE) {
    const { data, error } = await db
      .from("documents")
      .select("id, owner_type, file_key")
      .order("id", { ascending: true })
      .range(from, from + PAGE_SIZE - 1);
    if (error) throw new Error(`read documents: ${error.message}`);
    rows.push(...(data ?? []));
    if (!data || data.length < PAGE_SIZE) break;
  }
  return rows;
}

/** Counts rows per owner_type, every value present plus a total. */
export function countByOwnerType(rows) {
  const counts = {};
  for (const row of rows) counts[row.owner_type] = (counts[row.owner_type] ?? 0) + 1;
  return counts;
}

/**
 * Which rows may be deleted: those whose object is not in the bucket any more.
 * `remainingKeys` is the bucket AFTER removal (or before it, on a dry run).
 */
export function rowsSafeToDelete(rows, remainingKeys) {
  const remaining = new Set(remainingKeys);
  return {
    deletable: rows.filter((r) => !remaining.has(r.file_key)),
    kept: rows.filter((r) => remaining.has(r.file_key)),
  };
}

/** Deletes rows by id, in batches. Returns how many the database confirmed. */
export async function deleteRows(db, ids, size = REMOVE_BATCH_SIZE) {
  let deleted = 0;
  for (let i = 0; i < ids.length; i += size) {
    const batch = ids.slice(i, i + size);
    const { data, error } = await db
      .from("documents")
      .delete()
      .in("id", batch)
      .select("id");
    if (error) throw new Error(`delete documents rows: ${error.message}`);
    deleted += (data ?? []).length;
  }
  return deleted;
}

// ---------------------------------------------------------------------------
// Connection -- dev only. Mirrors devTarget() in load-hardware-catalog.mjs.
// ---------------------------------------------------------------------------

function devTarget() {
  try {
    execSync(`node ${GUARD}`, { stdio: ["ignore", "ignore", "inherit"] });
  } catch {
    throw new Error("linked-project guard refused -- not touching anything.");
  }

  const linked = JSON.parse(readFileSync(LINK_FILE, "utf8"));
  const url = `https://${linked.ref}.supabase.co`;
  assertDevTarget(linked.ref, url);

  // Never printed, never written to a file.
  let key = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
  if (key === "") {
    const raw = execSync(
      `npx supabase projects api-keys --project-ref ${linked.ref} --reveal -o json`,
      { encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] },
    );
    const keys = JSON.parse(raw.slice(raw.indexOf("[")));
    key =
      keys.find((k) => k.type === "secret")?.api_key ??
      keys.find((k) => k.id === "service_role")?.api_key ??
      "";
  }
  if (key === "") {
    throw new Error(
      "No service-role key for dev. Set SUPABASE_SERVICE_ROLE_KEY, or log the CLI in.",
    );
  }
  return { label: `${linked.name} (${linked.ref}) -- DEV`, url, key };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function main(argv) {
  const { write } = parseArgs(argv);
  const target = devTarget();
  const { createClient } = await import("@supabase/supabase-js");
  const db = createClient(target.url, target.key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  console.log(`target:  ${target.label}`);
  console.log(`mode:    ${write ? "WRITE -- objects and rows will be deleted" : "dry run (add --write to delete)"}`);
  console.log("");

  const rows = await readLegacyRows(db);
  const objects = await listAllObjects(db.storage, LEGACY_BUCKET);
  const named = new Set(rows.map((r) => r.file_key));
  const orphans = objects.filter((key) => !named.has(key));
  const inBucket = new Set(objects);
  const rowsWithoutObject = rows.filter((r) => !inBucket.has(r.file_key)).length;

  console.log("documents rows, by owner_type:");
  const counts = countByOwnerType(rows);
  for (const type of Object.keys(counts).sort()) {
    console.log(`  ${type.padEnd(16)} ${counts[type]}`);
  }
  console.log(`  ${"total".padEnd(16)} ${rows.length}`);
  console.log("");
  console.log(`objects in the "${LEGACY_BUCKET}" bucket: ${objects.length}`);
  console.log(`  named by a row:      ${objects.length - orphans.length}`);
  console.log(`  orphaned (no row):   ${orphans.length}`);
  console.log(`rows whose object is already missing: ${rowsWithoutObject}`);
  console.log("");

  if (!write) {
    console.log("dry run: nothing deleted.");
    return;
  }

  const { removed, failed } = await removeInBatches(db.storage, LEGACY_BUCKET, objects);
  console.log(`removed ${removed.length} object(s) via the Storage API, in batches of ${REMOVE_BATCH_SIZE}.`);
  if (failed.length > 0) {
    console.log(`FAILED to remove ${failed.length} object(s):`);
    for (const f of failed.slice(0, 20)) console.log(`  ${f.key} -- ${f.reason}`);
    if (failed.length > 20) console.log(`  ...and ${failed.length - 20} more`);
  }

  // Re-list rather than trust the remove() report: the bucket is the truth.
  const remaining = await listAllObjects(db.storage, LEGACY_BUCKET);
  const { deletable, kept } = rowsSafeToDelete(rows, remaining);
  const deleted = await deleteRows(db, deletable.map((r) => r.id));
  console.log(`deleted ${deleted} documents row(s).`);
  if (kept.length > 0) {
    console.log(`KEPT ${kept.length} row(s) whose object is still in the bucket; re-run to retry.`);
  }
  console.log(`objects left in the bucket: ${remaining.length}`);
  console.log("done.");
}

// Only when run as a script. The exports above are what the tests import.
if (process.argv[1]?.endsWith("purge-legacy-documents.mjs")) {
  try {
    await main(process.argv.slice(2));
  } catch (err) {
    console.error(`purge-legacy-documents: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
  }
}
