// Which deployed projects the tests/deployed suite checks, and how it finds them.
//
// This file exists because the suite used to check exactly one project: whatever
// .env.local happened to name. .env.local names DEV, so for three weeks the
// "compliance checks against production" checked nothing of the sort — and the
// two facts that caused the 2026-09-02 outage (prod had public sign-up on, and
// prod was 12 migrations behind) were both sitting in plain sight on a project
// no test ever looked at.
//
// So the target is now explicit and plural. One project cannot be silently
// dropped from coverage, because requireDeployedProjects() refuses to run
// without production in the list.
//
// Everything here uses the publishable/anon key only — the key that ships in
// the browser bundle. Nothing in this suite can read a row.

import { readFileSync } from "node:fs";
import path from "node:path";

export type DeployedProject = {
  /** Short name from the env var, e.g. "dev" / "prod". Used in test titles. */
  name: string;
  url: string;
  publishableKey: string;
};

/** The env file naming the projects. Gitignored via `.env*.local`. */
const ENV_FILE = ".env.deployed.local";

/**
 * The one project that must always be covered.
 *
 * Drift on dev is a nuisance someone notices while developing. Drift on prod is
 * an outage, and it is the case a single-project suite is most likely to omit,
 * because the project you develop against is the one whose URL is already
 * lying around in an env file.
 */
const REQUIRED = "prod";

function parseEnvFile(file: string): Map<string, string> {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    throw new Error(
      `Could not read ${file}. This suite asserts the state of the deployed ` +
        `projects, so it needs to be told which ones. Create it with a URL and ` +
        `publishable key per project:\n\n` +
        `  DEPLOYED_PROJECT_DEV_URL=https://<dev-ref>.supabase.co\n` +
        `  DEPLOYED_PROJECT_DEV_KEY=<dev publishable/anon key>\n` +
        `  DEPLOYED_PROJECT_PROD_URL=https://<prod-ref>.supabase.co\n` +
        `  DEPLOYED_PROJECT_PROD_KEY=<prod publishable/anon key>\n\n` +
        `Both are in the dashboard under project settings > API, or from\n` +
        `\`npx supabase projects api-keys --project-ref <ref>\`.`,
    );
  }

  const values = new Map<string, string>();
  for (const line of raw.split(/\r?\n/)) {
    const match = /^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/.exec(line);
    if (match) values.set(match[1], match[2].replace(/^["']|["']$/g, ""));
  }
  return values;
}

/**
 * Every project named in the env file, discovered by convention rather than
 * from a list that would have to be kept in step with the pairs below it.
 */
export function requireDeployedProjects(): DeployedProject[] {
  const values = parseEnvFile(path.join(process.cwd(), ENV_FILE));

  const projects: DeployedProject[] = [];
  for (const [key, url] of values) {
    const match = /^DEPLOYED_PROJECT_([A-Z0-9]+)_URL$/.exec(key);
    if (!match) continue;

    const name = match[1].toLowerCase();
    const publishableKey = values.get(`DEPLOYED_PROJECT_${match[1]}_KEY`);
    if (!publishableKey) {
      throw new Error(
        `${ENV_FILE} has ${key} but no DEPLOYED_PROJECT_${match[1]}_KEY.`,
      );
    }

    // The same guard the single-project version had, and for the same reason:
    // pointed at the local stack this suite would pass while asserting nothing
    // about anything deployed.
    if (url.includes("127.0.0.1") || url.includes("localhost")) {
      throw new Error(
        `${ENV_FILE} points "${name}" at ${url}. This suite asserts the state ` +
          `of deployed projects; the local stack would make it pass for the ` +
          `wrong reason.`,
      );
    }

    projects.push({ name, url, publishableKey });
  }

  if (projects.length === 0) {
    throw new Error(
      `${ENV_FILE} names no projects. Expected at least one ` +
        `DEPLOYED_PROJECT_<NAME>_URL / _KEY pair.`,
    );
  }

  // Fails loudly rather than quietly checking less. A suite that passes because
  // production was not in its list is the exact false negative this file was
  // written to remove.
  if (!projects.some((project) => project.name === REQUIRED)) {
    throw new Error(
      `${ENV_FILE} does not name a "${REQUIRED}" project (found: ` +
        `${projects.map((p) => p.name).join(", ")}). Production is the one ` +
        `whose drift is an outage, so it is not optional here. Add ` +
        `DEPLOYED_PROJECT_PROD_URL / _KEY.`,
    );
  }

  return projects;
}

/** GET against a project, with only the publishable key. */
export async function getFromProject(
  project: DeployedProject,
  pathname: string,
): Promise<{ status: number; body: string }> {
  const response = await fetch(`${project.url}${pathname}`, {
    headers: { apikey: project.publishableKey },
  });
  return { status: response.status, body: await response.text() };
}
