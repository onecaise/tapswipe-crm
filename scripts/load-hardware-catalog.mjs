#!/usr/bin/env node
/**
 * Loads data/hardware-catalog.csv into `products` and `product_compatibility`.
 *
 *   node scripts/load-hardware-catalog.mjs                 # dry run, local stack
 *   node scripts/load-hardware-catalog.mjs --write         # apply, local stack
 *   node scripts/load-hardware-catalog.mjs --target dev    # dry run, linked dev project
 *
 * THIS REPLACES THE BULK-IMPORT PIPELINE the products migration deferred, and
 * the replacement is deliberate rather than a shortcut. A staging table plus a
 * review screen plus a commit RPC -- the rep_payout_import_rows /
 * user_import_rows shape -- exists so a non-engineer can load a file nobody has
 * seen before, repeatedly, and inspect the damage before committing. The
 * hardware catalog is 43 curated rows in version control that change a few
 * times a year, and after the first load an admin maintains them on
 * /admin/products. So the review screen is this script's dry run, the staging
 * table is the CSV's own git history, and there is nothing to build.
 *
 * WHAT A RE-RUN DOES, because "idempotent" is not the same as "harmless": the
 * CSV is the source of truth for every column it owns, so re-running RESETS a
 * product an admin has edited on /admin/products back to what the file says.
 * The dry run prints those differences field by field precisely so that is a
 * decision rather than a surprise. It is also why --write is opt-in.
 *
 * Three things it deliberately does NOT do:
 *
 *   * It never deletes a product. `products` has no DELETE policy and no DELETE
 *     grant, because quote_line_items snapshots what a product said and the row
 *     is therefore evidence. A row dropped from the CSV is left alone and
 *     reported, not retired -- retiring it is `archived_at`, and that is an
 *     admin's call on a product a merchant may be holding a quote for.
 *   * It never deletes a compatibility link. It only adds missing ones. A link
 *     in the database that the CSV does not name is reported and left, since an
 *     admin adding one on /admin/products is the expected workflow and a loader
 *     that silently undid it would make that page a lie.
 *   * It never prints a key. Both targets hold a service-role credential.
 */

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createClient } from "@supabase/supabase-js";

const DEV_REF = "vdjtosofrimipklbdjbi"; // tapswipe-crm-dev
const PROD_REF = "zuvsdkjnfstrjahstsmg"; // tapwipe-crm-prod
const LINK_FILE = "supabase/.temp/linked-project.json";
const GUARD = "scripts/check-linked-project.mjs";

export const DEFAULT_CATALOG_PATH = "data/hardware-catalog.csv";

/**
 * The header row, in order, exactly.
 *
 * Positional rather than mapped-by-name, unlike mapHeaders() in the rep import.
 * That one accepts a spreadsheet somebody exported; this one reads a file in
 * this repo next to this script, so a renamed or reordered column is a change
 * to the pair of them and should fail loudly rather than be accommodated.
 */
export const CATALOG_COLUMNS = [
  "id",
  "kind",
  "brand",
  "name",
  "device_type",
  "connectivity",
  "retail_price",
  "billing",
  "fits",
  "notes",
  "active",
  "review",
];

/** Mirrors products_kind_vocabulary. */
export const KINDS = ["device", "addon"];
/** Mirrors products_billing_vocabulary. */
export const BILLINGS = ["one_time", "monthly"];

// ---------------------------------------------------------------------------
// CSV
// ---------------------------------------------------------------------------

/**
 * Splits CSV text into rows of cells, RFC4180-style.
 *
 * A VERBATIM COPY of parseDelimitedText() in
 * supabase/functions/_shared/user-imports.ts, with the delimiter fixed to a
 * comma. The duplication is not an oversight and could not be avoided here:
 * that module is TypeScript under supabase/, which plain `node` cannot import,
 * and this file is a .mjs script by design -- it has to run with nothing but
 * node and the one dependency already in package.json.
 *
 * So it is PINNED BY BEHAVIOUR instead, the arrangement isBlocking() already
 * has: tests/unit/hardware-catalog.test.ts imports both functions and asserts
 * they agree, including on the two cases this catalog actually contains -- a
 * quoted field holding a comma, and a doubled quote standing for the inches
 * mark in `Square KDS 15.6" touchscreen`. Change one and the other reds.
 */
export function splitCsvRows(text) {
  const rows = [];
  let row = [];
  let field = "";
  let inQuotes = false;
  let index = 0;

  while (index < text.length) {
    const char = text[index];

    if (inQuotes) {
      if (char === '"') {
        // A doubled quote is a literal quote; a lone one ends the field.
        if (text[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        inQuotes = false;
        index += 1;
        continue;
      }
      if (char === "\r" && text[index + 1] === "\n") {
        field += "\n";
        index += 2;
        continue;
      }
      field += char;
      index += 1;
      continue;
    }

    if (char === '"') {
      inQuotes = true;
      index += 1;
      continue;
    }
    if (char === ",") {
      row.push(field);
      field = "";
      index += 1;
      continue;
    }
    if (char === "\r" || char === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      index += char === "\r" && text[index + 1] === "\n" ? 2 : 1;
      continue;
    }

    field += char;
    index += 1;
  }

  row.push(field);
  rows.push(row);

  return rows;
}

// ---------------------------------------------------------------------------
// Parse + validate
// ---------------------------------------------------------------------------

/**
 * A price cell to what list_price should hold, or an error.
 *
 * Blank is `null`, NOT zero, and that distinction is the whole reason this is a
 * function. `list_price` is nullable precisely so "not priced yet" survives as
 * a different fact from "free", create_quote_version() refuses the null
 * outright, and `Number("")` is 0 -- so the one-liner is wrong in the direction
 * that puts a free terminal on a document somebody hands a merchant.
 *
 * Mirrors parsePriceInput() in lib/products.ts, which is the browser's copy of
 * the same rules. Not shared, for the reason splitCsvRows() is not shared.
 */
export function parsePriceCell(raw) {
  const trimmed = raw.trim();
  if (trimmed === "") return { value: null };

  const cleaned = trimmed.replace(/[$,\s]/g, "");
  if (cleaned === "") return { error: "not a number" };
  const parsed = Number(cleaned);
  if (!Number.isFinite(parsed)) return { error: "not a number" };
  if (parsed < 0) return { error: "negative" };
  if (Math.round(parsed * 100) / 100 !== parsed) {
    return { error: "more than two decimal places" };
  }
  if (parsed >= 10 ** 10) return { error: "too large for numeric(12,2)" };
  return { value: parsed };
}

/** `yes` / `no`, and nothing else. Anything else is a typo worth stopping on. */
export function parseActiveCell(raw) {
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === "yes") return { value: true };
  if (trimmed === "no") return { value: false };
  return { error: `expected yes or no, got "${raw.trim()}"` };
}

/** '' is never stored in a text column this script writes. See normalizeSku(). */
function blankToNull(raw) {
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}

/**
 * Reads the catalog file into items plus the problems that stop a load.
 *
 * Returns `{ items, problems }`. ANY problem stops the run -- there is no
 * skippable/blocking split of the kind the rep import draws, and the reason is
 * that the two imports have different units. Two hundred rep accounts are two
 * hundred independent things, so refusing forty onboardings because three
 * people already have logins is the wrong trade. A catalog is one document: a
 * row that will not parse means the file is wrong, and loading the other
 * forty-two leaves a half-stocked store that looks complete.
 */
export function parseCatalog(text) {
  const problems = [];
  const fail = (line, id, message) => problems.push({ line, id, message });

  const rows = splitCsvRows(text).filter(
    (row) => !(row.length === 1 && row[0].trim() === ""),
  );
  if (rows.length === 0) {
    fail(0, null, "the file is empty");
    return { items: [], problems };
  }

  const header = rows[0].map((cell) => cell.trim());
  if (
    header.length !== CATALOG_COLUMNS.length ||
    header.some((cell, i) => cell !== CATALOG_COLUMNS[i])
  ) {
    fail(
      1,
      null,
      `header must be exactly: ${CATALOG_COLUMNS.join(",")} -- got: ${header.join(",")}`,
    );
    return { items: [], problems };
  }

  const items = [];
  const seen = new Map();

  for (let i = 1; i < rows.length; i += 1) {
    const cells = rows[i];
    const line = i + 1; // 1-based and counting the header, as an editor shows it.
    if (cells.length !== CATALOG_COLUMNS.length) {
      fail(
        line,
        cells[0]?.trim() || null,
        `has ${cells.length} cells, expected ${CATALOG_COLUMNS.length}`,
      );
      continue;
    }

    const cell = (name) => cells[CATALOG_COLUMNS.indexOf(name)];
    const id = cell("id").trim();
    if (id === "") {
      fail(line, null, "has no id");
      continue;
    }
    if (seen.has(id)) {
      fail(line, id, `duplicate id -- already used on line ${seen.get(id)}`);
      continue;
    }
    seen.set(id, line);

    const kind = cell("kind").trim();
    if (!KINDS.includes(kind)) {
      fail(line, id, `kind "${kind}" is not one of ${KINDS.join(", ")}`);
    }

    const billing = cell("billing").trim();
    if (!BILLINGS.includes(billing)) {
      fail(line, id, `billing "${billing}" is not one of ${BILLINGS.join(", ")}`);
    }

    const name = cell("name").trim();
    if (name === "") fail(line, id, "has no name");

    // -> products.category, which is `not null`.
    const deviceType = cell("device_type").trim();
    if (deviceType === "") fail(line, id, "has no device_type");

    const price = parsePriceCell(cell("retail_price"));
    if (price.error) {
      fail(
        line,
        id,
        `retail_price "${cell("retail_price").trim()}" is ${price.error}`,
      );
    }

    const active = parseActiveCell(cell("active"));
    if (active.error) fail(line, id, `active ${active.error}`);

    const fits = cell("fits")
      .split(";")
      .map((part) => part.trim())
      .filter((part) => part !== "");

    if (kind === "addon" && fits.length === 0) {
      // Not a style rule. The store only ever asks "which add-ons fit this
      // device", keyed on device_product_id, so an add-on linked to nothing is
      // a row no rep can reach by any route -- invisible rather than wrong,
      // which is the kind of thing nobody reports.
      fail(line, id, "is an add-on and fits nothing");
    }
    if (kind === "device" && fits.length > 0) {
      // product_compatibility's device side must be kind 'device' and its
      // add-on side kind 'addon' -- enforce_compatibility_kinds() raises on
      // either. A device naming `fits` means the two columns got swapped.
      fail(line, id, `is a device but names fits (${fits.join(", ")})`);
    }
    if (fits.includes(id)) {
      fail(line, id, "fits itself"); // product_compatibility_distinct
    }
    const fitsSeen = new Set();
    for (const target of fits) {
      if (fitsSeen.has(target)) fail(line, id, `fits "${target}" twice`);
      fitsSeen.add(target);
    }

    items.push({
      line,
      id,
      kind,
      billing,
      brand: blankToNull(cell("brand")),
      name,
      category: deviceType,
      connectivity: blankToNull(cell("connectivity")),
      listPrice: price.value ?? null,
      fits,
      description: blankToNull(cell("notes")),
      active: active.value ?? true,
      review: blankToNull(cell("review")),
    });
  }

  // Cross-row rules, once every id is known. Checked after the per-row pass so
  // a forward reference -- an add-on listed above the device it fits -- is
  // legal, which keeps the file groupable by brand.
  const byId = new Map(items.map((item) => [item.id, item]));
  for (const item of items) {
    for (const target of item.fits) {
      const device = byId.get(target);
      if (!device) {
        fail(item.line, item.id, `fits "${target}", which is not in this file`);
      } else if (device.kind !== "device") {
        fail(
          item.line,
          item.id,
          `fits "${target}", which is a ${device.kind}, not a device`,
        );
      }
    }
  }

  return { items, problems };
}

/**
 * The `products` columns one catalog item maps to.
 *
 * `specs` carries the two CSV columns with no column of their own, which is
 * exactly what that jsonb catch-all is for -- "whatever the lineup turns out to
 * need, with no migration". `review` goes in there rather than being dropped
 * because the file is the only place that says WHY a row is parked, and an
 * archived product on /admin/products with no stated reason is one an admin
 * un-archives at the price nobody confirmed.
 */
export function toProductRow(item) {
  const specs = {};
  if (item.connectivity !== null) specs.connectivity = item.connectivity;
  if (item.review !== null) specs.review = item.review;

  return {
    sku: item.id,
    name: item.name,
    category: item.category,
    brand: item.brand,
    kind: item.kind,
    billing: item.billing,
    list_price: item.listPrice,
    description: item.description,
    specs,
  };
}

/** The `specs` keys this loader owns. Any other key is an admin's, and is kept. */
export const SPECS_KEYS_OWNED = ["connectivity", "review"];

// ---------------------------------------------------------------------------
// Diffing
// ---------------------------------------------------------------------------

/** numeric(12,2) arrives from PostgREST as a string. See priceNumber(). */
function samePrice(a, b) {
  if (a === null || a === undefined) return b === null || b === undefined;
  if (b === null || b === undefined) return false;
  return Math.round(Number(a) * 100) === Math.round(Number(b) * 100);
}

function sameSpecs(a, b) {
  const keys = (o) => Object.keys(o ?? {}).sort();
  const ak = keys(a);
  const bk = keys(b);
  return (
    ak.length === bk.length &&
    ak.every(
      (k, i) => k === bk[i] && JSON.stringify(a[k]) === JSON.stringify(b[k]),
    )
  );
}

/**
 * Merges the loader's specs into whatever the row already holds.
 *
 * The CSV owns SPECS_KEYS_OWNED and nothing else: a key present in the file is
 * set, a key blank in the file is REMOVED, and every other key an admin added
 * on /admin/products survives. A wholesale overwrite would quietly delete those
 * -- and this column exists to be extended without a migration, so deleting an
 * extension is the one thing a loader must not do to it.
 */
export function mergeSpecs(existing, fromCsv) {
  const merged = { ...(existing ?? {}) };
  for (const key of SPECS_KEYS_OWNED) {
    if (key in fromCsv) merged[key] = fromCsv[key];
    else delete merged[key];
  }
  return merged;
}

/**
 * What a load would change, given the catalog and what is already there.
 *
 * Pure, so the dry run and the write are the same computation rather than two
 * descriptions of one intent that can drift.
 */
export function planLoad(items, existingProducts, existingLinks, now) {
  const bySku = new Map(
    existingProducts.filter((p) => p.sku !== null).map((p) => [p.sku, p]),
  );

  const inserts = [];
  const updates = [];
  let unchanged = 0;

  for (const item of items) {
    const want = toProductRow(item);
    const have = bySku.get(item.id);

    if (!have) {
      inserts.push({
        item,
        row: { ...want, archived_at: item.active ? null : now },
      });
      continue;
    }

    const specs = mergeSpecs(have.specs, want.specs);
    const changes = {};
    for (const field of [
      "name",
      "category",
      "brand",
      "kind",
      "billing",
      "description",
    ]) {
      if ((have[field] ?? null) !== want[field]) {
        changes[field] = [have[field] ?? null, want[field]];
      }
    }
    if (!samePrice(have.list_price, want.list_price)) {
      changes.list_price = [have.list_price ?? null, want.list_price];
    }
    if (!sameSpecs(have.specs, specs)) {
      changes.specs = [have.specs ?? {}, specs];
    }
    // archived_at is a timestamp, so only its NULLNESS is compared: an already
    // archived row keeps the moment it was archived rather than having that
    // reset to now on every run.
    const archived = have.archived_at !== null;
    if (item.active && archived) changes.archived_at = [have.archived_at, null];
    if (!item.active && !archived) changes.archived_at = [null, now];

    if (Object.keys(changes).length === 0) {
      unchanged += 1;
    } else {
      updates.push({ item, id: have.id, changes, row: { ...want, specs } });
    }
  }

  // Links, by the (addon, device) PAIR -- never by add-on alone, or a second
  // device for an existing add-on would read as already present.
  const idBySku = new Map(
    existingProducts.filter((p) => p.sku !== null).map((p) => [p.sku, p.id]),
  );
  const have = new Set(
    existingLinks.map((l) => `${l.addon_product_id}:${l.device_product_id}`),
  );
  const wantedPairs = new Set();
  const linkInserts = [];
  for (const item of items) {
    for (const target of item.fits) {
      const addonId = idBySku.get(item.id) ?? null;
      const deviceId = idBySku.get(target) ?? null;
      if (addonId !== null && deviceId !== null) {
        wantedPairs.add(`${addonId}:${deviceId}`);
        if (have.has(`${addonId}:${deviceId}`)) continue;
      }
      linkInserts.push({
        addonSku: item.id,
        deviceSku: target,
        addonId,
        deviceId,
      });
    }
  }

  // Reported, never deleted. Only links whose add-on side this file knows
  // about, so a pair between two products the catalog has never heard of is
  // somebody else's business and is not mentioned at all.
  const skus = new Set(items.map((i) => i.id));
  const skuById = new Map(existingProducts.map((p) => [p.id, p.sku]));
  const extraLinks = existingLinks
    .filter((l) => skus.has(skuById.get(l.addon_product_id) ?? ""))
    .filter(
      (l) => !wantedPairs.has(`${l.addon_product_id}:${l.device_product_id}`),
    )
    .map((l) => ({
      addonSku: skuById.get(l.addon_product_id) ?? `#${l.addon_product_id}`,
      deviceSku: skuById.get(l.device_product_id) ?? `#${l.device_product_id}`,
    }));

  // A product in the database the file no longer names. Reported so a dropped
  // row is visible; never touched, because retiring one is archived_at and that
  // is a decision about a merchant's live quote, not a side effect of a load.
  const orphans = existingProducts
    .filter((p) => p.sku !== null && !skus.has(p.sku))
    .map((p) => ({ sku: p.sku, name: p.name }));

  return { inserts, updates, unchanged, linkInserts, extraLinks, orphans };
}

// ---------------------------------------------------------------------------
// Connection
//
// Two targets, and the invariant that matters is the same for both: the client
// is built from the thing that was CHECKED, never from a value supplied
// alongside it. `npm run db:push -- --db-url <prod>` is the standing example of
// the other arrangement -- the guard reads the linked project, prints
// "dev, ok", and the command underneath goes somewhere else entirely.
// ---------------------------------------------------------------------------

function supabaseStatusEnv() {
  const raw = execSync("npx supabase status -o env", { encoding: "utf8" });
  const cfg = new Map();
  for (const line of raw.split(/\r?\n/)) {
    const m = /^([A-Z0-9_]+)="?(.*?)"?$/.exec(line.trim());
    if (m) cfg.set(m[1], m[2]);
  }
  return cfg;
}

function localTarget() {
  const cfg = supabaseStatusEnv();
  const url = cfg.get("API_URL");
  const key = cfg.get("SERVICE_ROLE_KEY");
  if (!url || !key) {
    throw new Error("Local stack is not running. Run: npx supabase start");
  }
  // The same hard refusal both seed scripts carry, for the same reason: this
  // holds a service-role key, which bypasses RLS entirely.
  if (!/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url)) {
    throw new Error(`Refusing to treat a non-local host as the local stack: ${url}`);
  }
  return { label: `local (${url})`, url, key };
}

/**
 * The linked project, but only if the guard says it is dev.
 *
 * The guard is spawned rather than reimplemented -- one place decides what
 * counts as prod -- and then the URL is DERIVED from the same link file the
 * guard read. Nothing here accepts a URL from a flag or an env file, so there
 * is no way for the thing checked and the thing connected to be different
 * projects. ALLOW_PROD_SUPABASE is deliberately not honoured: the guard lets it
 * through, and this script refuses anyway on the ref.
 */
function devTarget() {
  try {
    execSync(`node ${GUARD}`, { stdio: ["ignore", "ignore", "inherit"] });
  } catch {
    throw new Error("linked-project guard refused -- not loading anything.");
  }

  const linked = JSON.parse(readFileSync(LINK_FILE, "utf8"));
  if (linked.ref === PROD_REF) {
    throw new Error(
      `Refusing PRODUCTION (${linked.ref}). This script has no prod path at all.`,
    );
  }
  if (linked.ref !== DEV_REF) {
    throw new Error(`Linked ref ${linked.ref} is not dev (${DEV_REF}).`);
  }

  const url = `https://${linked.ref}.supabase.co`;

  // The service-role key, never printed and never written to a file. Taken from
  // the already-logged-in CLI by default so no third secret has to live on disk
  // -- .env.deployed.local is publishable keys only, on purpose.
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
// Reporting
// ---------------------------------------------------------------------------

const money = (v) =>
  v === null || v === undefined ? "--" : `$${Number(v).toFixed(2)}`;

function show(value) {
  if (value === null || value === undefined) return "--";
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function report(plan, items, write) {
  const devices = items.filter((i) => i.kind === "device").length;
  const addons = items.length - devices;
  const links = items.reduce((n, i) => n + i.fits.length, 0);
  const inactive = items.filter((i) => !i.active);

  console.log(
    `catalog: ${items.length} items (${devices} devices, ${addons} add-ons), ` +
      `${links} compatibility links`,
  );

  console.log(
    `\nproducts  ${plan.inserts.length} new, ${plan.updates.length} changed, ` +
      `${plan.unchanged} already current`,
  );
  for (const { item, row } of plan.inserts) {
    console.log(
      `  + ${item.id.padEnd(26)} ${money(row.list_price).padStart(10)}  ` +
        `${item.kind.padEnd(6)} ${item.billing.padEnd(9)} ${item.name}` +
        (row.archived_at ? "   [archived]" : ""),
    );
  }
  for (const { item, changes } of plan.updates) {
    console.log(`  ~ ${item.id}`);
    for (const [field, [from, to]] of Object.entries(changes)) {
      console.log(`      ${field}: ${show(from)}  ->  ${show(to)}`);
    }
  }

  console.log(`\nlinks     ${plan.linkInserts.length} new`);
  for (const link of plan.linkInserts) {
    console.log(`  + ${link.addonSku.padEnd(26)} fits  ${link.deviceSku}`);
  }
  if (plan.extraLinks.length > 0) {
    console.log(
      `\n  ${plan.extraLinks.length} link(s) in the database the CSV does not name -- LEFT ALONE:`,
    );
    for (const link of plan.extraLinks) {
      console.log(`  ! ${link.addonSku.padEnd(26)} fits  ${link.deviceSku}`);
    }
  }
  if (plan.orphans.length > 0) {
    console.log(
      `\n  ${plan.orphans.length} product(s) in the database the CSV does not name -- LEFT ALONE:`,
    );
    for (const orphan of plan.orphans) {
      console.log(`  ! ${orphan.sku.padEnd(26)} ${orphan.name}`);
    }
  }

  if (inactive.length > 0) {
    console.log(`\n${inactive.length} row(s) marked active=no, loaded archived:`);
    for (const item of inactive) {
      console.log(`  - ${item.id.padEnd(26)} ${item.review ?? "(no reason given)"}`);
    }
  }

  if (!write) {
    console.log("\nDRY RUN -- nothing written. Re-run with --write to apply.");
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const PRODUCT_COLUMNS =
  "id, sku, name, category, brand, kind, billing, list_price, description, specs, archived_at";

export async function main(argv) {
  const write = argv.includes("--write");
  const targetName = argv.includes("--target")
    ? argv[argv.indexOf("--target") + 1]
    : "local";
  const file = argv.includes("--file")
    ? argv[argv.indexOf("--file") + 1]
    : DEFAULT_CATALOG_PATH;

  if (!["local", "dev"].includes(targetName)) {
    throw new Error(
      `--target must be local or dev, got "${targetName}". There is no prod target.`,
    );
  }

  const { items, problems } = parseCatalog(readFileSync(file, "utf8"));
  if (problems.length > 0) {
    console.error(`${file}: ${problems.length} problem(s), nothing loaded.\n`);
    for (const problem of problems) {
      console.error(
        `  line ${problem.line}${problem.id ? ` (${problem.id})` : ""}: ${problem.message}`,
      );
    }
    process.exitCode = 1;
    return;
  }

  const target = targetName === "dev" ? devTarget() : localTarget();

  // The guard runs before EITHER target writes, not only dev. A relink is
  // global CLI state, so "I was only working locally" is exactly the belief the
  // 2 Sep incident was held under.
  if (write && targetName === "local") {
    try {
      execSync(`node ${GUARD}`, { stdio: ["ignore", "ignore", "inherit"] });
    } catch {
      throw new Error("linked-project guard refused -- not writing, even locally.");
    }
  }

  console.log(`target:  ${target.label}`);
  console.log(`file:    ${file}`);

  const db = createClient(target.url, target.key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const existing = await db.from("products").select(PRODUCT_COLUMNS);
  if (existing.error) throw new Error(`reading products: ${existing.error.message}`);

  const links = await db
    .from("product_compatibility")
    .select("addon_product_id, device_product_id");
  if (links.error) {
    throw new Error(`reading product_compatibility: ${links.error.message}`);
  }

  const now = new Date().toISOString();
  let plan = planLoad(items, existing.data, links.data, now);
  report(plan, items, write);

  if (!write) return;

  console.log("\nwriting...");

  if (plan.inserts.length > 0) {
    const inserted = await db
      .from("products")
      .insert(plan.inserts.map((i) => i.row))
      .select("id, sku");
    if (inserted.error) {
      throw new Error(`inserting products: ${inserted.error.message}`);
    }
    console.log(`  inserted ${inserted.data.length} product(s)`);
  }

  for (const update of plan.updates) {
    const changed = {};
    for (const field of Object.keys(update.changes)) {
      changed[field] =
        field === "archived_at" ? update.changes.archived_at[1] : update.row[field];
    }
    const result = await db.from("products").update(changed).eq("id", update.id);
    if (result.error) {
      throw new Error(`updating ${update.item.id}: ${result.error.message}`);
    }
  }
  if (plan.updates.length > 0) {
    console.log(`  updated ${plan.updates.length} product(s)`);
  }

  // Re-read, because the ids of everything just inserted are what the links are
  // made of. Re-PLANNING rather than threading those ids through also means the
  // link step is written against the state that actually exists, so a run that
  // died halfway through the products pass resumes instead of doubling up.
  const after = await db.from("products").select(PRODUCT_COLUMNS);
  if (after.error) throw new Error(`re-reading products: ${after.error.message}`);
  const afterLinks = await db
    .from("product_compatibility")
    .select("addon_product_id, device_product_id");
  if (afterLinks.error) {
    throw new Error(`re-reading links: ${afterLinks.error.message}`);
  }

  plan = planLoad(items, after.data, afterLinks.data, now);
  if (plan.inserts.length > 0 || plan.updates.length > 0) {
    throw new Error(
      `products did not settle: ${plan.inserts.length} still new, ` +
        `${plan.updates.length} still changed`,
    );
  }

  const unresolved = plan.linkInserts.filter(
    (l) => l.addonId === null || l.deviceId === null,
  );
  if (unresolved.length > 0) {
    throw new Error(
      `cannot resolve ${unresolved.length} link(s) to product ids -- ` +
        unresolved.map((l) => `${l.addonSku}->${l.deviceSku}`).join(", "),
    );
  }

  if (plan.linkInserts.length > 0) {
    const insertedLinks = await db
      .from("product_compatibility")
      .insert(
        plan.linkInserts.map((l) => ({
          addon_product_id: l.addonId,
          device_product_id: l.deviceId,
        })),
      )
      .select("addon_product_id");
    if (insertedLinks.error) {
      throw new Error(`inserting links: ${insertedLinks.error.message}`);
    }
    console.log(`  inserted ${insertedLinks.data.length} link(s)`);
  }

  console.log("done.");
}

// Only when run as a script. The exports above are what the unit tests import.
if (process.argv[1]?.endsWith("load-hardware-catalog.mjs")) {
  await main(process.argv.slice(2));
}
