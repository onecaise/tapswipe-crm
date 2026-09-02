// Does each deployed project's schema actually satisfy the queries this build
// runs? Run with:  npm run test:deployed
//
// This is the test that was missing on 2026-09-02. lib/auth.ts selected
// profiles.last_viewed_notifications_at; the migration adding that column had
// never been pushed to production; PostgREST answered 400 "column ... does not
// exist"; getCurrentProfile() reported it as an absent profile and every
// signed-in user was redirected to /auth/error?error=no-profile. Nothing in any
// suite compared what the app asks for against what the deployed schema has,
// because `npm test` runs the migrations itself and so is always in step by
// construction — which is precisely why it cannot catch this.
//
// The mechanism is a happy accident of PostgREST's ordering: it resolves column
// and table names BEFORE it checks grants. So with nothing but the publishable
// key, a request for a column that exists is refused with
//   401 42501  permission denied for table profiles
// while a request for one that does not is refused with
//   400 42703  column profiles.<name> does not exist
// and a missing table with
//   404 PGRST205  Could not find the table 'public.<name>'
//
// A 401 is therefore the PASSING answer here, and the assertions below say so
// explicitly rather than looking like they got lucky. Nothing in this file can
// read a row from any project — the key it uses is the one that ships in the
// browser bundle.

import { describe, expect, it } from "vitest";

import { PROFILE_SELECT } from "@/lib/auth";
import {
  getFromProject,
  requireDeployedProjects,
  type DeployedProject,
} from "./helpers/projects";

const projects = requireDeployedProjects();

/**
 * Queries whose failure is a user-visible outage rather than a broken page.
 *
 * `profiles` comes from lib/auth.ts's own exported constant, so every column
 * added to the app's profile read is covered here from the moment it is added,
 * with nobody having to remember this file exists. That one matters most:
 * requireUser() gates every authenticated route, so a column missing there
 * takes down the whole app rather than one screen.
 *
 * The rest is a floor, not an inventory. An exhaustive schema diff would need
 * the service-role key (PostgREST refuses its OpenAPI root to anything else),
 * and putting that key in a test suite to catch drift is a poor trade against
 * running these with a key that is already public.
 */
const CRITICAL_QUERIES: { label: string; path: string }[] = [
  {
    label: "profiles, exactly as lib/auth.ts reads it",
    path: `/rest/v1/profiles?select=${encodeURIComponent(PROFILE_SELECT)}&limit=1`,
  },
  {
    label: "profiles.email + agent_number (Manage Users, residual import)",
    path: "/rest/v1/profiles?select=id,email,agent_number&limit=1",
  },
  {
    label: "merchants.pre_app_id (merchant provenance)",
    path: "/rest/v1/merchants?select=id,pre_app_id&limit=1",
  },
  {
    label: "rep_payout_batches (residuals)",
    path: "/rest/v1/rep_payout_batches?select=id&limit=1",
  },
  {
    label: "rep_payout_rows (residuals)",
    path: "/rest/v1/rep_payout_rows?select=id&limit=1",
  },
  {
    label: "bug_reports",
    path: "/rest/v1/bug_reports?select=id&limit=1",
  },
  {
    label: "support_ticket_replies",
    path: "/rest/v1/support_ticket_replies?select=id&limit=1",
  },
  {
    label: "documents.file_key",
    path: "/rest/v1/documents?select=id,file_key&limit=1",
  },
];

/** PostgREST's codes for "this name is not in the schema", the drift signals. */
const MISSING_COLUMN = "42703";
const MISSING_TABLE = "PGRST205";

describe.each(projects)(
  "deployed schema: $name",
  (project: DeployedProject) => {
    it("is the project it claims to be, and is awake", async () => {
      // First, so a paused or renamed project reports that rather than
      // producing eight confusing failures below it. A paused project does not
      // resolve in DNS at all, which surfaces here as a fetch rejection.
      const { status } = await getFromProject(project, "/auth/v1/health");
      expect([200, 401]).toContain(status);
    });

    for (const query of CRITICAL_QUERIES) {
      it(`has the schema for: ${query.label}`, async () => {
        const { status, body } = await getFromProject(project, query.path);

        const code = (() => {
          try {
            return String((JSON.parse(body) as { code?: unknown }).code ?? "");
          } catch {
            return "";
          }
        })();

        // Named separately from the assertion so a failure says which kind of
        // drift it is: a table that was never created, or a column that a later
        // migration added and this project never received.
        expect(
          code,
          `${project.name} is missing a TABLE this build queries — it is ` +
            `behind on migrations. ${project.url} -> ${body}`,
        ).not.toBe(MISSING_TABLE);

        expect(
          code,
          `${project.name} is missing a COLUMN this build selects — it is ` +
            `behind on migrations. This is the 2026-09-02 outage shape: the ` +
            `app asks for something the deployed schema does not have. ` +
            `${project.url} -> ${body}`,
        ).not.toBe(MISSING_COLUMN);

        // The positive form of the same thing. 401/403 is healthy: the names
        // all resolved and RLS then declined to hand over data, which is
        // exactly what the publishable key should get. 200 is fine too, for a
        // table that is deliberately readable. Anything else is unexplained,
        // and an unexplained answer from production should not read as a pass.
        expect(
          [200, 206, 401, 403],
          `unexpected answer from ${project.name}: ${status} ${body}`,
        ).toContain(status);
      });
    }
  },
);

describe("coverage", () => {
  it("checks production, not just whichever project was handy", () => {
    // The regression guard on the suite itself. Before this, tests/deployed
    // read .env.local — which names dev — so "compliance checks against the
    // deployed project" silently never looked at production at all.
    expect(projects.map((project) => project.name)).toContain("prod");
  });

  it("checks more than one project, so the two can drift apart visibly", () => {
    expect(projects.length).toBeGreaterThanOrEqual(2);
  });
});
