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
//
// Two ways to call it:
//
//   node scripts/check-linked-project.mjs                  check only (other scripts spawn this)
//   node scripts/check-linked-project.mjs -- <cli args>    check, then run `npx supabase <cli args>`
//
// The npm scripts use the second form, and the reason is how npm passes
// arguments. `npm run functions:deploy -- --project-ref <prod>` appends the flag
// to the END of the script string. When that string was
// `npm run guard:linked && npx supabase functions deploy`, the flag went to the
// CLI, not to the guard: the guard read the link file, printed "dev, ok", and
// the deploy went to prod. Launching the CLI from here puts npm's appended
// arguments in this process's argv, where they can be refused.
//
// `--project-ref` and `--db-url` name a target other than the linked project,
// so a check of the linked project says nothing about them. They are refused
// even with ALLOW_PROD_SUPABASE=1. To target a project by ref or URL, call
// `npx supabase` directly, so nothing claims to have checked what it did not.

import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";

const DEV_REF = "vdjtosofrimipklbdjbi";  // tapswipe-crm-dev
const PROD_REF = "zuvsdkjnfstrjahstsmg"; // tapwipe-crm-prod
const LINK_FILE = "supabase/.temp/linked-project.json";
const TARGET_FLAGS = ["--project-ref", "--db-url"];

const sep = process.argv.indexOf("--", 2);
const cliArgs = sep === -1 ? null : process.argv.slice(sep + 1);

if (cliArgs) {
  const found = cliArgs.filter((a) => TARGET_FLAGS.some((f) => a === f || a.startsWith(`${f}=`)));
  if (found.length > 0) {
    const flags = [...new Set(found.map((a) => a.split("=")[0]))].join(", ");
    console.error(
      `[supabase-guard] REFUSING: ${flags} names a target other than the linked project,\n` +
      `  so this guard cannot vouch for it. Nothing was run.\n` +
      `  To act on the linked project:   drop the flag.\n` +
      `  To target a project by ref/URL: npx supabase <cmd> ${flags.split(", ")[0]} ...  (no npm wrapper)`
    );
    process.exit(1);
  }
}

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
  if (process.env.ALLOW_PROD_SUPABASE !== "1") {
    console.error(
      `[supabase-guard] REFUSING: linked project is PRODUCTION ${label}.\n` +
      `  This command assumes dev. To target dev:  npx supabase link --project-ref ${DEV_REF}\n` +
      `  To act on prod on purpose:                ALLOW_PROD_SUPABASE=1 <command>`
    );
    process.exit(1);
  }
  console.error(`[supabase-guard] PRODUCTION: ${label} — allowed via ALLOW_PROD_SUPABASE=1`);
} else if (ref === DEV_REF) {
  console.error(`[supabase-guard] linked project: ${label} — dev, ok`);
} else {
  console.error(`[supabase-guard] linked project: ${label} — UNRECOGNISED ref, check this`);
  process.exit(1);
}

if (!cliArgs) process.exit(0);

// npx is a .cmd shim on Windows, which only a shell can start, and a shell
// joins arguments with spaces — so quote anything that is not a plain token.
const win = process.platform === "win32";
const quote = (a) => (!win || /^[\w@%+=:,./-]+$/.test(a) ? a : `"${a.replace(/"/g, '\\"')}"`);
const result = spawnSync("npx", ["supabase", ...cliArgs].map(quote), { stdio: "inherit", shell: win });
if (result.error) {
  console.error(`[supabase-guard] could not start the Supabase CLI: ${result.error.message}`);
  process.exit(1);
}
process.exit(result.status ?? 1);
