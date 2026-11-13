# Hosted projects and deployment

Moved **verbatim** out of CLAUDE.md on 4 Nov 2026 (phase 13 of `docs/design/intake-and-reports.md`), to bring CLAUDE.md under its size limit. These are binding rules, not history; CLAUDE.md keeps a summary and the safety rules that point here. "Below" and "above" in the text refer to this file, or to CLAUDE.md where it says so.

## The text

Stack: Next.js 16 (App Router, React 19), Supabase (Postgres + Auth + Storage + Deno Edge Functions), Tailwind 3 + shadcn/ui (new-york, `neutral` base), TypeScript strict. Linked Supabase project ref: `vdjtosofrimipklbdjbi` — and note **which** project that is: `tapswipe-crm-dev`. The second project `tapwipe-crm-prod` (`zuvsdkjnfstrjahstsmg`) is **not linked, but it is deployed and real**: `PRE_APP_SECRETS_KEY` is set and its private buckets exist (made by hand before `20261009170000_storage_buckets.sql`, which only fills in a missing one). Treat it as live production, not as a spare project.

**Prod schema is caught up as of 18 Sep 2026 — all 30 migrations, verified against its own catalog** by `scripts/push-prod-migration.ps1`, which checks the migration rows AND the resulting objects rather than trusting the CLI's exit code. Log in `scripts/logs/`. Don't take that as standing parity: it was two behind for two days before this, and the only honest way to know is to run `scripts/diag-prod-trigger.ps1`, which says outright whether prod matches the repo.

**Functions are a separate question from the schema, and a migration push does not carry them.** That is `functions deploy`, which is also the one command where `--project-ref` genuinely exists — so deploying to prod needs no relink and no database password, only a logged-in CLI.

**As of 13 Oct 2026 the repo's functions and prod's are different sets** — which ones, and how a prod deploy is verified (401 from the function vs 404 for a missing slug): `docs/claude/project-state.md`.

So `supabase db push`, `functions deploy` and `migration list --linked` target **dev**; `npm run test:deployed` is the exception — it reads `.env.deployed.local` and checks **every** project named there, dev and prod both, so it is the one command whose target does not depend on the link at all. Where this file says "production" of the linked project it means the hosted project — **dev is what those commands hit.**

**Reaching prod is not one answer, and `--project-ref` is not it.** That flag exists on `functions deploy` — which is how the 4 Sep prod deploys were done, and for functions it genuinely is the form no one else's relink can invalidate. It does **not** exist on the migration commands. Verified 16 Sep 2026: `supabase db push --help` lists only `--linked`, `--local` and `--db-url` for targeting, and `migration list --project-ref …` fails outright with `UnrecognizedOption`. So for anything schema-related there are exactly two routes to prod, and both cost something:

- **Relink** (`supabase link --project-ref zuvsdkjnfstrjahstsmg`, then `ALLOW_PROD_SUPABASE=1 npm run db:push`). This is the 2 Sep incident's own mechanism — it changes global CLI state, and until it is reversed the guard fails closed on every wrapped command, blocking unrelated work.
- **`--db-url`** with the prod connection string. No relink and no global state, but it needs the prod Postgres password, which is deliberately nowhere in this repo — `.env.deployed.local` holds publishable keys only.

**And the URL is not the obvious one:** `db.<ref>.supabase.co` is IPv6-only and fails at DNS without IPv6 egress (`docs/claude/project-state.md`). Use the pooler in **session** mode; the username carries the ref:

```
postgresql://postgres.zuvsdkjnfstrjahstsmg@aws-0-us-west-2.pooler.supabase.com:5432/postgres   # password in $env:PGPASSWORD, never in the URL (a command line is readable by other processes; scripts/prod-db.ps1)
```

Port 5432, not 6543: transaction mode breaks a migration partway through. Both projects are `us-west-2`, so dev's pooler host is prod's too.

**Pooler host is `aws-0`, never `aws-1`:** the wrong one fails as `Tenant or user not found`, which reads like a bad password. History: `docs/claude/project-state.md`.

**Don't hand-build that URL — use the scripts.** `scripts/diag-prod-trigger.ps1` reads prod's state read-only and says whether it matches the repo; `scripts/push-prod-migration.ps1` applies what is pending and verifies the result against the catalog. Both take the password from `$env:SUPABASE_DB_PASSWORD` (set it with `Read-Host -AsSecureString`, never a literal assignment — PSReadLine's sensitive-input filter catches the word "password" but *not* a credential embedded in a URL, which is how three of them ended up in shell history), both redact it out of everything they print, and both write a log to `scripts/logs/` because the answer has to outlive the terminal. Run the push with `-DryRun` first.

Why they stream `db push --yes` and derive the migration check from the directory: `docs/claude/project-state.md`.

**`npm run db:push -- --db-url <prod>` used to print `dev, ok` and go to prod** (npm appended the flag after the guard); since 21 Oct 2026 the wrappers launch the CLI from the guard, which refuses `--project-ref` and `--db-url` (`docs/claude/security-fixes.md`, phase 4). When targeting prod by URL, call `npx supabase` directly so nothing claims to have checked something it did not.

**The linked-project claim above drifted once, silently, and the guard exists because of it.** On 2 Sep 2026 the CLI was relinked to **prod** while this file said dev for seven days (story: `docs/claude/project-state.md`). Now something does — `scripts/check-linked-project.mjs` prints the linked project and **fails closed** when it is prod, missing, or an unrecognised ref. Use the wrapped scripts for anything acting on the linked project:

```bash
npm run guard:linked      # print the linked project; exit 1 if prod or unrecognised
npm run db:push           # guard, then supabase db push
npm run db:dump           # guard, then db dump --linked
npm run migration:list    # guard, then migration list --linked
npm run functions:deploy  # guard, then functions deploy
ALLOW_PROD_SUPABASE=1 npm run db:push   # act on prod on purpose
```

The guard reads `supabase/.temp/linked-project.json`, so it reports what the CLI will *actually* do rather than what any doc claims. Raw `npx supabase …` still bypasses it — prefer the npm scripts for anything aimed at the linked project, and pin `--project-ref` when you mean prod **on a command that has that flag** (`functions deploy` does; `db push` and `migration list` do not — see above for what to use instead). Dev is often `INACTIVE` (paused): `migration list` times out and `functions deploy` 404s with `status 'INACTIVE'`; restore it in the dashboard (no CLI equivalent).

**Never run `supabase projects api-keys`.** It prints the project's service-role key to stdout, and stdout is a transcript — a terminal scrollback, a CI log, an agent session — that outlives the command. `scripts/load-hardware-catalog.mjs` is the one caller, and it captures the output and never prints it; anything you type by hand has no such guarantee.

**The local stack's service versions follow the LINKED project**: after any `supabase link`, relink to dev and see `docs/claude/project-state.md` (the `42P10` fix).
