import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

/**
 * supabase/config.toml's sign-up settings for the LOCAL stack, pinned without
 * a stack. tests/live/local-auth-config.test.ts proves the running stack
 * refuses a sign-up; this proves the file says so, which is what a reviewer
 * edits.
 *
 * The two settings look like a pair and are not. [auth].enable_signup is what
 * blocks self-service accounts. [auth.email].enable_signup is the email
 * provider's on/off switch, so turning it off to "double-lock" sign-up takes
 * password LOGIN down with it -- the whole app. Both halves are asserted.
 *
 * (These two assertions lived in tests/live/document-urls.test.ts, which was
 * deleted with the legacy documents path on 13 Oct 2026, and went with it.)
 */

const toml = readFileSync(
  path.resolve(import.meta.dirname, "../../supabase/config.toml"),
  "utf8",
);

/** A key's raw value inside one exact [section], ignoring comments. Sections
 *  are matched by their full header, so [auth] never reads [auth.email]. */
function setting(section: string, key: string): string | undefined {
  let current = "";
  for (const raw of toml.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, "").trim();
    const header = /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      current = header[1].trim();
      continue;
    }
    if (current !== section) continue;
    const kv = /^([A-Za-z0-9_]+)\s*=\s*(.+)$/.exec(line);
    if (kv && kv[1] === key) return kv[2].trim();
  }
  return undefined;
}

describe("local auth config", () => {
  it("disables self-service sign-up under [auth]", () => {
    expect(setting("auth", "enable_signup")).toBe("false");
  });

  it("keeps the email provider ON, or password login goes with it", () => {
    expect(setting("auth.email", "enable_signup")).toBe("true");
  });

  it("reads sections exactly, so the two keys cannot be confused", () => {
    // Sanity check on the reader itself: the same key name has different
    // values in the two sections, so a reader that ignored the header would
    // fail one of the two assertions above.
    expect(setting("auth", "enable_signup")).not.toBe(
      setting("auth.email", "enable_signup"),
    );
  });
});
