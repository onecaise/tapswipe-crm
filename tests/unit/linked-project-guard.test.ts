// scripts/check-linked-project.mjs and the npm scripts that wrap the Supabase
// CLI with it.
//
// The bypass this pins: npm appends `npm run x -- <args>` to the END of the
// script string. When the wrappers read `npm run guard:linked && npx supabase
// functions deploy`, `npm run functions:deploy -- --project-ref <prod>` handed
// the flag to the CLI: the guard printed "dev, ok" and the deploy went to prod.
//
// Each test runs the real `npm run` in a throwaway project that holds a copy of
// the guard, this repo's script strings, a link file, and a FAKE `supabase` bin
// that records its argv instead of reaching any project. npx resolves the local
// bin first; npm_config_offline/yes=false make a missing one an error rather
// than a download.

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const REPO = path.resolve(import.meta.dirname, "../..");
const DEV_REF = "vdjtosofrimipklbdjbi";
const PROD_REF = "zuvsdkjnfstrjahstsmg";
const WRAPPED = ["db:push", "db:dump", "migration:list", "functions:deploy"];
const REPO_SCRIPTS: Record<string, string> = JSON.parse(
  readFileSync(path.join(REPO, "package.json"), "utf8"),
).scripts;

let dir: string;

function project(ref: string | null, scripts: Record<string, string> = REPO_SCRIPTS) {
  mkdirSync(path.join(dir, "scripts"), { recursive: true });
  copyFileSync(
    path.join(REPO, "scripts/check-linked-project.mjs"),
    path.join(dir, "scripts/check-linked-project.mjs"),
  );
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "guard-fixture", private: true, scripts }));
  if (ref) {
    mkdirSync(path.join(dir, "supabase/.temp"), { recursive: true });
    writeFileSync(
      path.join(dir, "supabase/.temp/linked-project.json"),
      JSON.stringify({ ref, name: ref === PROD_REF ? "tapwipe-crm-prod" : "tapswipe-crm-dev" }),
    );
  }
  // The fake CLI: one JSON line of argv per call.
  const bin = path.join(dir, "node_modules/.bin");
  mkdirSync(bin, { recursive: true });
  mkdirSync(path.join(dir, "node_modules/supabase"), { recursive: true });
  writeFileSync(
    path.join(dir, "node_modules/supabase/package.json"),
    JSON.stringify({ name: "supabase", version: "0.0.0", bin: { supabase: "fake.cjs" } }),
  );
  writeFileSync(
    path.join(dir, "node_modules/supabase/fake.cjs"),
    `require("fs").appendFileSync(${JSON.stringify(path.join(dir, "calls.log"))}, JSON.stringify(process.argv.slice(2)) + "\\n");`,
  );
  writeFileSync(path.join(bin, "supabase"), `#!/bin/sh\nexec node "$(dirname "$0")/../supabase/fake.cjs" "$@"\n`, {
    mode: 0o755,
  });
  writeFileSync(path.join(bin, "supabase.cmd"), `@node "%~dp0\\..\\supabase\\fake.cjs" %*\r\n`);
}

function npmRun(script: string, args: string[] = [], env: Record<string, string> = {}) {
  const npmCli = process.env.npm_execpath;
  const argv = ["run", "--silent", script, ...(args.length ? ["--", ...args] : [])];
  const opts = {
    cwd: dir,
    encoding: "utf8" as const,
    env: { ...process.env, ALLOW_PROD_SUPABASE: "", npm_config_offline: "true", npm_config_yes: "false", ...env },
  };
  const r =
    npmCli && npmCli.endsWith(".js")
      ? spawnSync(process.execPath, [npmCli, ...argv], opts)
      : spawnSync("npm", argv, { ...opts, shell: true });
  return { status: r.status, stderr: r.stderr ?? "" };
}

function guard(args: string[] = [], env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, ["scripts/check-linked-project.mjs", ...args], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, ALLOW_PROD_SUPABASE: "", npm_config_offline: "true", npm_config_yes: "false", ...env },
  });
  return { status: r.status, stderr: r.stderr ?? "" };
}

function calls(): string[][] {
  const log = path.join(dir, "calls.log");
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
}

beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "linked-guard-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("package.json: every wrapper launches the CLI through the guard", () => {
  it.each(WRAPPED)("%s hands its arguments to the guard, not straight to the CLI", (name) => {
    const s = REPO_SCRIPTS[name];
    expect(s.startsWith("node scripts/check-linked-project.mjs -- ")).toBe(true);
    // A second command after the guard is where npm's appended args would go.
    expect(s).not.toMatch(/&&|;|\|/);
    expect(s).not.toMatch(/npx supabase/);
  });

  it("no other script runs the Supabase CLI around the guard", () => {
    const others = Object.entries(REPO_SCRIPTS).filter(([n]) => !WRAPPED.includes(n));
    for (const [, s] of others) expect(s).not.toMatch(/supabase\s/);
  });
});

describe("npm run <wrapper> -- --project-ref / --db-url is refused before the CLI runs", () => {
  it("control: the old `guard:linked && npx supabase …` form hands the flag to the CLI", () => {
    // The reproduction. Same fake CLI, the script strings as they were.
    project(DEV_REF, {
      "guard:linked": "node scripts/check-linked-project.mjs",
      "functions:deploy": "npm run guard:linked && npx supabase functions deploy",
    });
    const r = npmRun("functions:deploy", ["--project-ref", PROD_REF]);
    expect(r.stderr).toContain("dev, ok");
    expect(r.status).toBe(0);
    expect(calls()).toEqual([["functions", "deploy", "--project-ref", PROD_REF]]);
  }, 60_000);

  it("functions:deploy -- --project-ref <prod>", () => {
    project(DEV_REF);
    const r = npmRun("functions:deploy", ["--project-ref", PROD_REF]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("REFUSING: --project-ref");
    expect(r.stderr).not.toContain("dev, ok");
    expect(calls()).toEqual([]);
  }, 60_000);

  it("db:push -- --db-url <url>", () => {
    project(DEV_REF);
    const r = npmRun("db:push", ["--db-url", "postgresql://u@db.example.test:5432/postgres"]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("REFUSING: --db-url");
    expect(calls()).toEqual([]);
  }, 60_000);

  it("refuses the --flag=value spelling too, even with ALLOW_PROD_SUPABASE=1", () => {
    project(DEV_REF);
    const r = npmRun("migration:list", [`--project-ref=${PROD_REF}`], { ALLOW_PROD_SUPABASE: "1" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("REFUSING: --project-ref");
    expect(calls()).toEqual([]);
  }, 60_000);

  it.each(WRAPPED)("%s: both flags, both spellings (guard argv as npm builds it)", (name) => {
    project(DEV_REF);
    const base = REPO_SCRIPTS[name].replace("node scripts/check-linked-project.mjs ", "").split(" ");
    for (const extra of [
      ["--project-ref", PROD_REF],
      [`--project-ref=${PROD_REF}`],
      ["--db-url", "postgresql://x"],
      ["--db-url=postgresql://x"],
    ]) {
      const r = guard([...base, ...extra]);
      expect(r.status, extra.join(" ")).toBe(1);
      expect(r.stderr).toContain("REFUSING");
    }
    expect(calls()).toEqual([]);
  });
});

describe("the wrappers still work and still check the link", () => {
  it("functions:deploy -- <name> reaches the CLI with the name, on dev", () => {
    project(DEV_REF);
    const r = npmRun("functions:deploy", ["create-user"]);
    expect(r.status).toBe(0);
    expect(r.stderr).toContain("dev, ok");
    expect(calls()).toEqual([["functions", "deploy", "create-user"]]);
  }, 60_000);

  it("db:push passes --yes through", () => {
    project(DEV_REF);
    expect(npmRun("db:push", ["--yes"]).status).toBe(0);
    expect(calls()).toEqual([["db", "push", "--yes"]]);
  }, 60_000);

  it("refuses when prod is linked, and runs nothing", () => {
    project(PROD_REF);
    const r = npmRun("db:push");
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain("REFUSING: linked project is PRODUCTION");
    expect(calls()).toEqual([]);
  }, 60_000);

  it("runs on a linked prod with ALLOW_PROD_SUPABASE=1", () => {
    project(PROD_REF);
    const r = npmRun("migration:list", [], { ALLOW_PROD_SUPABASE: "1" });
    expect(r.status).toBe(0);
    expect(calls()).toEqual([["migration", "list", "--linked"]]);
  }, 60_000);

  it("refuses with no link file or an unrecognised ref", () => {
    project(null);
    expect(guard(["--", "db", "push"]).status).toBe(1);
    project("abcdefghijklmnopqrst");
    expect(guard(["--", "db", "push"]).status).toBe(1);
    expect(calls()).toEqual([]);
  });

  it("passes the CLI's exit code back", () => {
    project(DEV_REF);
    writeFileSync(path.join(dir, "node_modules/supabase/fake.cjs"), "process.exit(3);");
    expect(guard(["--", "db", "push"]).status).toBe(3);
  });
});

describe("check-only mode (what load-hardware-catalog and purge-legacy-documents spawn)", () => {
  it("exits 0 on dev, 1 on prod, and runs no CLI", () => {
    project(DEV_REF);
    expect(guard().status).toBe(0);
    project(PROD_REF);
    expect(guard().status).toBe(1);
    expect(guard([], { ALLOW_PROD_SUPABASE: "1" }).status).toBe(0);
    expect(calls()).toEqual([]);
  });
});
