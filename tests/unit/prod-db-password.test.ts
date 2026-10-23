// The prod database password must never be on a process command line.
//
// diag-prod-trigger.ps1, push-prod-migration.ps1 and audit-percent-corruption.ps1
// used to percent-encode $env:SUPABASE_DB_PASSWORD into the connection URL and
// pass that URL to `docker exec ... psql -d <url>` and `supabase db push
// --db-url <url>`. Any process of the same user can read another's command line
// (Win32_Process.CommandLine). Now the URL carries no password and the value
// travels in PGPASSWORD: `docker exec -e PGPASSWORD` (the name only, so docker
// reads the value from its own environment) and the CLI's own environment.
//
// Each test runs the REAL script, copied into a throwaway layout so its logs and
// its CLI path land there. Nothing in it can reach a database:
//   - `docker` is a PowerShell function defined before the script runs, which
//     records its argv and the PGPASSWORD it sees. A function outranks an
//     external command, and PATH holds only System32 and PowerShell besides, so
//     the real docker.exe cannot be found even if that ever changed.
//   - the CLI is a fake node_modules\.bin\supabase.cmd that records the same.
//   - the push script only reaches the CLI because the fake docker reports a
//     remote server; there is no real server behind it.
//
// The canary has characters that percent-encode, so both the raw and the
// encoded form are looked for.

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

const REPO = path.resolve(import.meta.dirname, "../..");
const CANARY = "Ph6-canary/pw:x@y#z";
// [uri]::EscapeDataString and encodeURIComponent agree for these characters.
const CANARY_ENC = encodeURIComponent(CANARY);
const CONTAINER = "supabase_db_tapswipe-crm";
const SCRIPTS = [
  "diag-prod-trigger.ps1",
  "push-prod-migration.ps1",
  "audit-percent-corruption.ps1",
  "audit-percent-corruption.sql",
  "prod-state.ps1",
  "prod-db.ps1",
];

type Call = { tool: "docker" | "cli"; argv: string[]; pg: string | null };

let dir: string;
let stubLog: string;

function layout() {
  mkdirSync(path.join(dir, "scripts"), { recursive: true });
  for (const f of SCRIPTS) {
    if (existsSync(path.join(REPO, "scripts", f))) {
      copyFileSync(path.join(REPO, "scripts", f), path.join(dir, "scripts", f));
    }
  }
  // One migration the fake server lacks, so the push script has work to do.
  mkdirSync(path.join(dir, "supabase/migrations"), { recursive: true });
  writeFileSync(path.join(dir, "supabase/migrations/20990101000000_stub.sql"), "select 1;\n");

  // Fake CLI: one JSON line per call.
  const bin = path.join(dir, "node_modules/.bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(
    path.join(bin, "fake-cli.cjs"),
    `require("fs").appendFileSync(process.env.STUB_LOG, JSON.stringify({ tool: "cli", argv: process.argv.slice(2), pg: process.env.PGPASSWORD ?? null }) + "\\n");
console.log("fake cli ran");`,
  );
  writeFileSync(
    path.join(bin, "supabase.cmd"),
    `@"${process.execPath}" "%~dp0fake-cli.cjs" %*\r\n`,
  );

  // Fake docker: `ps` names the container, the versions query returns nothing
  // (so everything is pending), anything else reports a remote server.
  writeFileSync(
    path.join(dir, "fake-docker.ps1"),
    `function global:docker {
  $rec = [ordered]@{ tool = 'docker'; argv = @($args | ForEach-Object { [string]$_ }); pg = $env:PGPASSWORD }
  [IO.File]::AppendAllText($env:STUB_LOG, ($rec | ConvertTo-Json -Compress) + [Environment]::NewLine)
  $global:LASTEXITCODE = 0
  if ($args[0] -eq 'ps') { return '${CONTAINER}' }
  if (($args -join ' ') -match 'order by version') { return }
  'server=10.9.9.9 | port=5432 | db=postgres | latest=none'
}
`,
  );
}

function run(script: string, scriptArgs = "", extraEnv: Record<string, string> = {}) {
  const env = {} as NodeJS.ProcessEnv;
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !/^(path|pgpassword|supabase_db_password)$/i.test(k)) env[k] = v;
  }
  const sysRoot = process.env.SystemRoot ?? "C:\\Windows";
  env.PATH = [path.join(sysRoot, "System32"), path.join(sysRoot, "System32\\WindowsPowerShell\\v1.0")].join(";");
  env.SUPABASE_DB_PASSWORD = CANARY;
  env.STUB_LOG = stubLog;
  Object.assign(env, extraEnv);

  const command =
    `. '${path.join(dir, "fake-docker.ps1")}'; ` +
    `& '${path.join(dir, "scripts", script)}' ${scriptArgs}; ` +
    `'PGPASSWORD-after=[' + $env:PGPASSWORD + ']'`;
  const res = spawnSync(
    path.join(sysRoot, "System32\\WindowsPowerShell\\v1.0\\powershell.exe"),
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", command],
    { env, encoding: "utf8", timeout: 60_000 },
  );
  const calls: Call[] = existsSync(stubLog)
    ? readFileSync(stubLog, "utf8")
        .replace(/^\uFEFF/, "")
        .split(/\r?\n/)
        .filter((l) => l.trim())
        .map((l) => JSON.parse(l))
    : [];
  const logDir = path.join(dir, "scripts/logs");
  const logs = existsSync(logDir)
    ? readdirSync(logDir).map((f) => readFileSync(path.join(logDir, f), "utf8")).join("\n")
    : "";
  return { out: `${res.stdout}\n${res.stderr}`, calls, logs };
}

function leaks(text: string) {
  return text.includes(CANARY) || text.includes(CANARY_ENC);
}

// Every psql call: the URL has no password, -e PGPASSWORD names the variable
// with no value, and the value arrived through the environment.
function expectPsqlCallsClean(calls: Call[], minimum: number) {
  const execs = calls.filter((c) => c.tool === "docker" && c.argv[0] === "exec");
  expect(execs.length).toBeGreaterThanOrEqual(minimum);
  for (const c of execs) {
    expect(c.argv.some(leaks), `argv: ${c.argv.join(" ")}`).toBe(false);
    const e = c.argv.indexOf("-e");
    expect(e, "docker exec carries -e").toBeGreaterThan(0);
    expect(c.argv[e + 1]).toBe("PGPASSWORD");
    expect(c.argv.some((a) => /PGPASSWORD=/i.test(a))).toBe(false);
    const url = c.argv[c.argv.indexOf("-d") + 1];
    expect(url).toMatch(/^postgresql:\/\/postgres\.[a-z0-9]+@/);
    expect(c.pg).toBe(CANARY);
  }
}

function expectNothingElseHadIt(calls: Call[]) {
  const ps = calls.filter((c) => c.tool === "docker" && c.argv[0] === "ps");
  expect(ps.length).toBeGreaterThan(0);
  for (const c of ps) expect(c.pg).toBeNull();
}

describe.skipIf(process.platform !== "win32")("prod scripts keep the password off command lines", () => {
  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "prod-db-pw-"));
    stubLog = path.join(dir, "calls.jsonl");
    layout();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("diag-prod-trigger.ps1: psql gets the password in PGPASSWORD only, and it is cleared afterwards", () => {
    const { out, calls, logs } = run("diag-prod-trigger.ps1");
    expectPsqlCallsClean(calls, 2);
    expectNothingElseHadIt(calls);
    expect(leaks(out)).toBe(false);
    expect(leaks(logs)).toBe(false);
    expect(logs).toContain(`CHECK pwchars=${CANARY.length}`);
    expect(out).toContain("PGPASSWORD-after=[]");
  });

  it("push-prod-migration.ps1 -DryRun: psql and the CLI get it in PGPASSWORD only", () => {
    const { out, calls, logs } = run("push-prod-migration.ps1", "-DryRun");
    expectPsqlCallsClean(calls, 2);
    expectNothingElseHadIt(calls);

    const cli = calls.filter((c) => c.tool === "cli");
    expect(cli).toHaveLength(1);
    expect(cli[0].argv.some(leaks), `argv: ${cli[0].argv.join(" ")}`).toBe(false);
    expect(cli[0].argv.slice(0, 3)).toEqual(["db", "push", "--db-url"]);
    expect(cli[0].argv[3]).toBe(
      "postgresql://postgres.zuvsdkjnfstrjahstsmg@aws-0-us-west-2.pooler.supabase.com:5432/postgres",
    );
    expect(cli[0].argv).toContain("--yes");
    expect(cli[0].argv).toContain("--dry-run");
    expect(cli[0].pg).toBe(CANARY);

    expect(logs).toContain("fake cli ran"); // the CLI's output still streams into the log
    expect(logs).toContain("cli exit code: 0");
    expect(leaks(out)).toBe(false);
    expect(leaks(logs)).toBe(false);
    expect(out).toContain("PGPASSWORD-after=[]");
  });

  it("push-prod-migration.ps1 (real run): the after-push verification reads the same way", () => {
    const { out, calls, logs } = run("push-prod-migration.ps1");
    // Two reads before the push and two after.
    expectPsqlCallsClean(calls, 4);
    const cli = calls.filter((c) => c.tool === "cli");
    expect(cli).toHaveLength(1);
    expect(cli[0].argv.some(leaks), `argv: ${cli[0].argv.join(" ")}`).toBe(false);
    expect(cli[0].argv).not.toContain("--dry-run");
    expect(cli[0].pg).toBe(CANARY);
    expect(leaks(out)).toBe(false);
    expect(leaks(logs)).toBe(false);
    expect(out).toContain("PGPASSWORD-after=[]");
  });

  it("audit-percent-corruption.ps1: the piped psql call gets it in PGPASSWORD only", () => {
    const { out, calls, logs } = run("audit-percent-corruption.ps1", "-ProjectRef stubref");
    expectPsqlCallsClean(calls, 1);
    const exec = calls.find((c) => c.tool === "docker" && c.argv[0] === "exec")!;
    expect(exec.argv[1]).toBe("-i");
    expect(leaks(out)).toBe(false);
    expect(leaks(logs)).toBe(false);
    expect(out).toContain("Read complete");
    expect(out).toContain("PGPASSWORD-after=[]");
  });

  it("a PGPASSWORD the caller already had is put back, not clobbered or removed", () => {
    const { out, calls } = run("diag-prod-trigger.ps1", "", { PGPASSWORD: "callers-own" });
    expectPsqlCallsClean(calls, 2);
    expect(out).toContain("PGPASSWORD-after=[callers-own]");
  });
});

describe.skipIf(process.platform !== "win32")("scripts/prod-db.ps1", () => {
  function ps(command: string) {
    const sysRoot = process.env.SystemRoot ?? "C:\\Windows";
    return spawnSync(
      path.join(sysRoot, "System32\\WindowsPowerShell\\v1.0\\powershell.exe"),
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command",
        `. '${path.join(REPO, "scripts/prod-db.ps1")}'; ${command}`],
      { encoding: "utf8", timeout: 60_000 },
    );
  }

  it("refuses to build arguments from a URL that carries a password, without echoing it", () => {
    const r = ps(
      `try { Get-PsqlDockerArgs -Container c -Url 'postgresql://postgres.x:${CANARY_ENC}@h:5432/postgres' -PsqlArgs @('-c','select 1') } catch { 'refused: ' + $_.Exception.Message }; ` +
        `try { Get-DbPushArgs -Url 'postgresql://postgres.x:${CANARY_ENC}@h:5432/postgres' } catch { 'refused: ' + $_.Exception.Message }`,
    );
    const lines = r.stdout.trim().split(/\r?\n/);
    expect(lines).toHaveLength(2);
    for (const l of lines) expect(l).toMatch(/^refused: ABORT: the connection URL carries a password/);
    expect(leaks(r.stdout + r.stderr)).toBe(false);
  });

  it("builds a pooler URL with no password and accepts it", () => {
    const r = ps(
      `$u = Get-PoolerUrl -ProjectRef abc -PoolerHost h.example -Port 5432; $u; (Get-PsqlDockerArgs -Container c -Url $u -PsqlArgs @('-tA')) -join ' '`,
    );
    expect(r.stdout.trim().split(/\r?\n/)).toEqual([
      "postgresql://postgres.abc@h.example:5432/postgres",
      "exec -e PGPASSWORD c psql -w -d postgresql://postgres.abc@h.example:5432/postgres -tA",
    ]);
  });
});
