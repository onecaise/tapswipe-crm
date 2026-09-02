// Compliance checks against the DEPLOYED projects, not the local stack.
//
// Run with:  npm run test:deployed
//
// Separate from both other suites on purpose. `npm test` is hermetic PGlite and
// must stay that way; `npm run test:live` drives the local stack. This one
// asserts facts about the real hosted projects, which no amount of local
// testing can establish — supabase/config.toml governs the local stack only, so
// the deployed Auth settings are a completely independent surface that had
// already drifted from what docs/tapswipe_crm_schema.sql requires.
//
// It now runs against EVERY project in .env.deployed.local rather than the one
// .env.local happened to name. That change is the whole point: .env.local names
// dev, so this file spent three weeks asserting dev's auth settings under a
// heading that says production, while production quietly had public sign-up
// switched on. See tests/deployed/helpers/projects.ts.
//
// Everything here is read-only. Nothing is created, and no credential beyond
// the publishable key is used — that key is designed to ship in a browser
// bundle.

import { beforeAll, describe, expect, it } from "vitest";

import {
  getFromProject,
  requireDeployedProjects,
  type DeployedProject,
} from "./helpers/projects";

type GoTrueSettings = {
  disable_signup: boolean;
  mailer_autoconfirm: boolean;
  external: Record<string, boolean>;
};

const projects = requireDeployedProjects();

describe.each(projects)(
  "deployed Auth configuration: $name",
  (project: DeployedProject) => {
    let settings: GoTrueSettings;

    beforeAll(async () => {
      const { status, body } = await getFromProject(
        project,
        "/auth/v1/settings",
      );
      if (status !== 200) {
        throw new Error(
          `GET ${project.url}/auth/v1/settings returned ${status}: ${body}`,
        );
      }
      settings = JSON.parse(body) as GoTrueSettings;
      console.log(`  ${project.name} ${project.url} -> ${body}`);
    });

    it("has public sign-up disabled", () => {
      // §1 of docs/tapswipe_crm_schema.sql: this is an admin-provisioned CRM.
      // Accounts come from the create-user Edge Function only. With sign-up on,
      // anyone holding the publishable key — which ships in the browser bundle
      // — can create auth.users rows. RLS still shows them nothing, since a
      // user with no profiles row fails both is_active_agent() and is_admin()
      // and profiles has no insert policy to self-heal with, so this is
      // account-spam and email-quota abuse rather than a data breach. It is
      // still the exact setting the schema doc forbids.
      //
      // This assertion failed against prod on 2026-09-02 — the first time it
      // was ever pointed at prod.
      //
      // Deliberately NOT tested by attempting a real signUp: if the setting
      // were wrong, the attempt would succeed and create the very account this
      // exists to prevent. Behavioural refusal is covered against the local
      // stack in tests/live/document-urls.test.ts, where a junk user costs
      // nothing.
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
  },
);

describe("deployed Auth configuration: agreement between projects", () => {
  it("gives dev and prod the same answer on every setting asserted above", async () => {
    // The drift check, as opposed to the compliance checks. Each assertion
    // above can pass on both projects while the two are still configured
    // differently in some way nobody has thought to assert yet — and "it works
    // on dev" is the sentence that precedes finding out prod was different.
    const settled = await Promise.all(
      projects.map(async (project) => {
        const { body } = await getFromProject(project, "/auth/v1/settings");
        const parsed = JSON.parse(body) as GoTrueSettings;
        return {
          name: project.name,
          // Only the fields the suite has an opinion about. mailer_autoconfirm
          // and the rest are deliberately excluded: they legitimately differ
          // between a project people test against and one real reps log in to,
          // and asserting them here would make this fail for reasons that are
          // not drift.
          compared: {
            disable_signup: parsed.disable_signup,
            email: parsed.external.email,
            anonymous_users: parsed.external.anonymous_users ?? false,
          },
        };
      }),
    );

    const [first, ...rest] = settled;
    for (const other of rest) {
      expect(
        other.compared,
        `${other.name} and ${first.name} are configured differently`,
      ).toEqual(first.compared);
    }
  });
});
