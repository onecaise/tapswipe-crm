#!/usr/bin/env node
// Pre-flight guard for Supabase CLI commands that act on the *linked* project.
//
// Why this exists: on 2 Sep the CLI was manually relinked to tapwipe-crm-prod and
// CLAUDE.md still said dev was linked. For two days every `--linked` command was
// hitting production while the docs (and a Claude session, on 2 Sep 16:34 UTC)
// asserted otherwise. Nothing destructive ran, but nothing stopped it either.
//
// This prints the linked project on every invocation and fails closed when that
// project is prod. Set ALLOW_PROD_SUPABASE=1 to act on prod deliberately.

import { readFileSync } from "node:fs";

const DEV_REF = "vdjtosofrimipklbdjbi";  // tapswipe-crm-dev
const PROD_REF = "zuvsdkjnfstrjahstsmg"; // tapwipe-crm-prod
const LINK_FILE = "supabase/.temp/linked-project.json";

let linked;
try {
  linked = JSON.parse(readFileSync(LINK_FILE, "utf8"));
} catch {
  // No link file: `supabase link` has not run in this checkout. Not a prod risk,
  // but the caller's assumption about "the linked project" is unfounded either way.
  console.error(`[supabase-guard] No ${LINK_FILE} — nothing is linked. Run: npx supabase link --project-ref ${DEV_REF}`);
  process.exit(1);
}

const { ref, name } = linked;
const label = `${name ?? "unknown"} (${ref})`;

if (ref === PROD_REF) {
  if (process.env.ALLOW_PROD_SUPABASE === "1") {
    console.error(`[supabase-guard] PRODUCTION: ${label} — allowed via ALLOW_PROD_SUPABASE=1`);
    process.exit(0);
  }
  console.error(
    `[supabase-guard] REFUSING: linked project is PRODUCTION ${label}.\n` +
    `  This command assumes dev. To target dev:  npx supabase link --project-ref ${DEV_REF}\n` +
    `  To act on prod on purpose:                ALLOW_PROD_SUPABASE=1 <command>\n` +
    `  Prefer pinning the ref explicitly:        npx supabase <cmd> --project-ref <ref>`
  );
  process.exit(1);
}

console.error(`[supabase-guard] linked project: ${label}${ref === DEV_REF ? " — dev, ok" : " — UNRECOGNISED ref, check this"}`);
process.exit(ref === DEV_REF ? 0 : 1);
