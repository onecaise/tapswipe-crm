// Compliance checks against the DEPLOYED project, not the local stack.
//
// Run with:  npm run test:deployed
//
// Separate from both other suites on purpose. `npm test` is hermetic PGlite and
// must stay that way; `npm run test:live` drives the local stack. This one
// asserts facts about the real hosted project, which no amount of local testing
// can establish — supabase/config.toml governs the local stack only, so the
// deployed Auth settings are a completely independent surface that had already
// drifted from what docs/tapswipe_crm_schema.sql requires.
//
// Everything here is read-only. Nothing is created, and no credential beyond the
// publishable key is used — that key is designed to ship in a browser bundle.

import { readFileSync } from "node:fs";
import path from "node:path";

import { beforeAll, describe, expect, it } from "vitest";

type EnvVars = { url: string; publishableKey: string };

/**
 * Reads .env.local directly rather than depending on a loader.
 *
 * These tests target whatever project .env.local points at, which is the same
 * project the app itself talks to — so there is no way for the suite to pass
 * against one project while the app runs against another.
 */
function readEnvLocal(): EnvVars {
  const file = path.join(process.cwd(), ".env.local");
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    throw new Error(
      `Could not read ${file}. This suite checks the deployed project, so it ` +
        `needs the same env file the app uses.`,
    );
  }

  const values = new Map<string, string>();
  for (const line of raw.split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (match) values.set(match[1], match[2].replace(/^["']|["']$/g, ""));
  }

  const url = values.get("NEXT_PUBLIC_SUPABASE_URL");
  const publishableKey = values.get("NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY");
  if (!url || !publishableKey) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY missing from .env.local",
    );
  }
  if (url.includes("127.0.0.1") || url.includes("localhost")) {
    throw new Error(
      `.env.local points at ${url}. This suite asserts the state of the ` +
        `deployed project; pointing it at the local stack would make it pass ` +
        `for the wrong reason.`,
    );
  }

  return { url, publishableKey };
}

type GoTrueSettings = {
  disable_signup: boolean;
  mailer_autoconfirm: boolean;
  external: Record<string, boolean>;
};

let env: EnvVars;
let settings: GoTrueSettings;

beforeAll(async () => {
  env = readEnvLocal();

  const response = await fetch(`${env.url}/auth/v1/settings`, {
    headers: { apikey: env.publishableKey },
  });
  if (!response.ok) {
    throw new Error(
      `GET /auth/v1/settings returned ${response.status}: ${await response.text()}`,
    );
  }
  settings = (await response.json()) as GoTrueSettings;
  console.log(`  ${env.url} -> ${JSON.stringify(settings)}`);
});

describe("deployed Auth configuration", () => {
  it("has public sign-up disabled", () => {
    // §1 of docs/tapswipe_crm_schema.sql: this is an admin-provisioned CRM.
    // Accounts come from the create-user Edge Function only. With sign-up on,
    // anyone holding the publishable key — which ships in the browser bundle —
    // can create auth.users rows. RLS still shows them nothing, since a user
    // with no profiles row fails both is_active_agent() and is_admin() and
    // profiles has no insert policy to self-heal with, so this is account-spam
    // and email-quota abuse rather than a data breach. It is still the exact
    // setting the schema doc forbids.
    //
    // Deliberately NOT tested by attempting a real signUp: if the setting were
    // wrong, the attempt would succeed and create the very account this exists
    // to prevent. Behavioural refusal is covered against the local stack in
    // tests/live/document-urls.test.ts, where a junk user costs nothing.
    expect(settings.disable_signup).toBe(true);
  });

  it("has the email provider enabled so password login works", () => {
    // The other half of the pair, and the one that is easy to break while
    // "hardening" the first. In supabase/config.toml the equivalent field is
    // [auth.email].enable_signup, which maps to GOTRUE_EXTERNAL_EMAIL_ENABLED
    // and switches sign-IN off too. Turning this off to double-lock sign-up
    // locks every agent out of the app instead.
    expect(settings.external.email).toBe(true);
  });

  it("has every third-party provider disabled", () => {
    // Nothing but email is provisioned, so any provider flipping to true is
    // either a mistake or someone else in the dashboard.
    const enabled = Object.entries(settings.external)
      .filter(([name, on]) => on && name !== "email")
      .map(([name]) => name);

    expect(enabled).toEqual([]);
  });

  it("does not allow anonymous sign-ins", () => {
    // An anonymous user is an auth.users row with no profiles row — the same
    // dead-end state public sign-up creates, reachable without an email.
    expect(settings.external.anonymous_users ?? false).toBe(false);
  });
});
