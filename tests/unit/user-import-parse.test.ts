import { describe, expect, it } from "vitest";

import {
  COLUMN_HEADERS,
  MAX_IMPORT_ROWS,
  blockerMessage,
  detectDelimiter,
  isBlocking,
  mapHeaders,
  parseDelimitedText,
  parseRoleCell,
  parseUserImport,
  pickBlocker,
} from "../../supabase/functions/_shared/user-imports";

/**
 * The bulk rep-import parser.
 *
 * Imported straight out of supabase/functions/_shared/, which works for the same
 * reason tests/unit/residuals-parse.test.ts does it: the module is
 * dependency-free precisely so it needs no deno.json import map, and that
 * property lets Node import it. So every rule where the judgement lives is
 * testable with no Deno, no Docker and no running stack.
 *
 * What these tests are really guarding, in order of how much a mistake would
 * cost:
 *
 *   1. **A quoted field must not shift the columns.** A rep called `Smith, Jr.`
 *      is the ordinary case that silently turns an email column into a name
 *      column, and produces a plausible-looking import of nonsense.
 *   2. **Duplicates are caught BEFORE any account is created.** That is the
 *      entire reason the flow is staged. Two rows for one person that both reach
 *      provisioning means the second one adopts or conflicts, which is correct
 *      but is a worse place to discover it than a review screen.
 *   3. **A role is never silently guessed.** Blank defaults to `agent` — the
 *      least privilege, and the only safe direction. Unreadable text blocks the
 *      row rather than defaulting, because "Manger" quietly becoming an agent is
 *      the class of quiet wrong answer this flow exists to prevent.
 *   4. **Blank is not empty-string.** An agent number of '' is a value the
 *      partial unique index enforces, so two reps cleared that way collide.
 *   5. **An over-size file is refused, not truncated.** A silent cap reads as a
 *      complete import.
 */

/** Builds CSV text from rows, so the tests read as tables rather than strings. */
function csv(rows: string[][]): string {
  return rows.map((row) => row.join(",")).join("\n");
}

const HEADER = ["Full name", "Email", "Role", "Agent #"];

describe("parseDelimitedText", () => {
  it("splits plain comma-separated cells", () => {
    expect(parseDelimitedText("a,b,c", ",")).toEqual([["a", "b", "c"]]);
  });

  it("keeps a delimiter that sits inside quotes", () => {
    // The whole reason this is not text.split(","). A name like `Smith, Jr.`
    // would otherwise shift every column after it by one.
    expect(parseDelimitedText('"Smith, Jr.",a@b.com', ",")).toEqual([
      ["Smith, Jr.", "a@b.com"],
    ]);
  });

  it("reads a doubled quote as one literal quote", () => {
    expect(parseDelimitedText('"say ""hi""",x', ",")).toEqual([
      ['say "hi"', "x"],
    ]);
  });

  it("keeps a newline that sits inside quotes", () => {
    expect(parseDelimitedText('"line1\nline2",x', ",")).toEqual([
      ["line1\nline2", "x"],
    ]);
  });

  it("normalises a CRLF inside a quoted field to a bare newline", () => {
    // Otherwise a stray carriage return rides into the database on a name.
    expect(parseDelimitedText('"line1\r\nline2",x', ",")).toEqual([
      ["line1\nline2", "x"],
    ]);
  });

  it("treats CRLF, LF and CR as one row break each", () => {
    expect(parseDelimitedText("a\r\nb\nc\rd", ",")).toEqual([
      ["a"],
      ["b"],
      ["c"],
      ["d"],
    ]);
  });

  it("splits on tabs when told to", () => {
    expect(parseDelimitedText("a\tb", "\t")).toEqual([["a", "b"]]);
  });
});

describe("detectDelimiter", () => {
  it("picks comma for ordinary CSV", () => {
    expect(detectDelimiter("Full name,Email\nA,b@c.com")).toBe(",");
  });

  it("picks tab when the header is tab-separated", () => {
    // Pasting a block of cells out of Excel produces TSV. Without this the whole
    // row lands in one column and the error names every column as missing.
    expect(detectDelimiter("Full name\tEmail\nA\tb@c.com")).toBe("\t");
  });

  it("prefers comma on a tie, including when neither appears", () => {
    expect(detectDelimiter("single")).toBe(",");
  });
});

describe("mapHeaders", () => {
  it("tolerates case and spacing around the hash", () => {
    const map = mapHeaders(["FULL NAME", "email", "Role", "AGENT  #"]);
    expect(map.missing).toEqual([]);
    expect(map.index.full_name).toBe(0);
    expect(map.index.agent_number).toBe(3);
  });

  it("reports missing required columns by their canonical name", () => {
    const map = mapHeaders(["Full name"]);
    expect(map.missing).toEqual([COLUMN_HEADERS.email]);
  });

  it("does not require the optional columns", () => {
    expect(mapHeaders(["Full name", "Email"]).missing).toEqual([]);
  });

  it("lets the first of a duplicated header win", () => {
    // Preferring the last copy would make which values imported depend on
    // column order.
    expect(mapHeaders(["Email", "Email"]).index.email).toBe(0);
  });
});

describe("parseRoleCell", () => {
  it("defaults blank to agent, the least privilege", () => {
    expect(parseRoleCell(undefined)).toEqual({ role: "agent", ok: true });
    expect(parseRoleCell("   ")).toEqual({ role: "agent", ok: true });
  });

  it("accepts either role in any case", () => {
    expect(parseRoleCell("ADMIN")).toEqual({ role: "admin", ok: true });
    expect(parseRoleCell("Agent")).toEqual({ role: "agent", ok: true });
  });

  it("refuses unreadable text rather than defaulting it", () => {
    expect(parseRoleCell("Manger").ok).toBe(false);
  });
});

describe("parseUserImport — whole-file failures", () => {
  it("refuses an empty file", () => {
    const result = parseUserImport("   ");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/empty/i);
  });

  it("refuses a file missing a required column, naming it", () => {
    const result = parseUserImport(csv([["Full name"], ["Avery"]]));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain("Email");
  });

  it("refuses a header with no rows under it", () => {
    const result = parseUserImport(csv([HEADER]));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/no rows/i);
  });

  it("REFUSES an over-size file rather than truncating it", () => {
    const rows = Array.from({ length: MAX_IMPORT_ROWS + 1 }, (_, i) => [
      `Rep ${i}`,
      `rep${i}@tapswipe.test`,
      "agent",
      "",
    ]);
    const result = parseUserImport(csv([HEADER, ...rows]));

    expect(result.ok).toBe(false);
    if (!result.ok) {
      // Names both numbers, so the admin knows how far over they are.
      expect(result.error).toContain(String(MAX_IMPORT_ROWS + 1));
      expect(result.error).toContain(String(MAX_IMPORT_ROWS));
    }
  });

  it("accepts a file of exactly the cap", () => {
    const rows = Array.from({ length: MAX_IMPORT_ROWS }, (_, i) => [
      `Rep ${i}`,
      `rep${i}@tapswipe.test`,
      "agent",
      "",
    ]);
    const result = parseUserImport(csv([HEADER, ...rows]));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.rows).toHaveLength(MAX_IMPORT_ROWS);
  });

  it("strips a UTF-8 BOM before matching the first header", () => {
    // Excel writes one on every CSV it saves as UTF-8, and without this the
    // first column never matches and the file looks like it has no name column.
    const result = parseUserImport(
      "﻿" + csv([HEADER, ["Avery", "a@tapswipe.test", "agent", ""]]),
    );
    expect(result.ok).toBe(true);
  });
});

describe("parseUserImport — rows", () => {
  it("reads a clean row and numbers it as the file does", () => {
    const result = parseUserImport(
      csv([HEADER, ["Avery Agent", "Avery@Tapswipe.com", "admin", "4471"]]),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.rows).toHaveLength(1);
    const row = result.rows[0];
    // Row 2, because the header is row 1 — what an admin counts in the file.
    expect(row.row_number).toBe(2);
    expect(row.full_name).toBe("Avery Agent");
    // Lower-cased by the same helper provisionUser uses.
    expect(row.email).toBe("avery@tapswipe.com");
    expect(row.role).toBe("admin");
    expect(row.agent_number).toBe("4471");
    expect(row.blockers).toEqual([]);
    // The raw text survives, so the review screen can show what the file said.
    expect(row.email_raw).toBe("Avery@Tapswipe.com");
  });

  it("defaults every row to agent when the Role column is absent", () => {
    const result = parseUserImport(
      csv([["Full name", "Email"], ["Avery", "a@tapswipe.test"]]),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.rows[0].role).toBe("agent");
  });

  it("stores a blank agent number as null, never as empty string", () => {
    // '' is a value the partial unique index enforces, so two reps cleared that
    // way would collide.
    const result = parseUserImport(
      csv([HEADER, ["Avery", "a@tapswipe.test", "agent", "   "]]),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.rows[0].agent_number).toBeNull();
  });

  it("skips entirely blank rows rather than blocking them", () => {
    const result = parseUserImport(
      csv([
        HEADER,
        ["Avery", "a@tapswipe.test", "agent", ""],
        ["", "", "", ""],
        ["Blake", "b@tapswipe.test", "agent", ""],
      ]) + "\n",
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows).toHaveLength(2);
    // The gap does not renumber what follows it.
    expect(result.rows.map((row) => row.row_number)).toEqual([2, 4]);
  });

  it("keeps the columns aligned when a name contains the delimiter", () => {
    const result = parseUserImport(
      ["Full name,Email,Role,Agent #", '"Smith, Jr.",s@tapswipe.test,agent,7']
        .join("\n"),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows[0].full_name).toBe("Smith, Jr.");
    expect(result.rows[0].email).toBe("s@tapswipe.test");
    expect(result.rows[0].agent_number).toBe("7");
  });
});

describe("parseUserImport — blockers", () => {
  it("blocks a row with no name", () => {
    const result = parseUserImport(
      csv([HEADER, ["   ", "a@tapswipe.test", "agent", ""]]),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.rows[0].blockers).toContain("missing_name");
  });

  it("blocks an unreadable email and keeps what the file said", () => {
    const result = parseUserImport(
      csv([HEADER, ["Avery", "not-an-email", "agent", ""]]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows[0].blockers).toContain("invalid_email");
    expect(result.rows[0].context.email).toBe("not-an-email");
  });

  it("blocks an unrecognised role", () => {
    const result = parseUserImport(
      csv([HEADER, ["Avery", "a@tapswipe.test", "Manger", ""]]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows[0].blockers).toContain("invalid_role");
    expect(result.rows[0].role).toBeNull();
  });

  it("blocks an agent number longer than the column allows", () => {
    const result = parseUserImport(
      csv([HEADER, ["Avery", "a@tapswipe.test", "agent", "x".repeat(33)]]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows[0].blockers).toContain("invalid_agent_number");
    expect(result.rows[0].agent_number).toBeNull();
  });

  it("blocks the SECOND row sharing an email, naming the first", () => {
    const result = parseUserImport(
      csv([
        HEADER,
        ["Avery", "dupe@tapswipe.test", "agent", ""],
        ["Blake", "dupe@tapswipe.test", "agent", ""],
      ]),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // First occurrence wins, so row 2 is clean and row 3 is the problem.
    expect(result.rows[0].blockers).toEqual([]);
    expect(result.rows[1].blockers).toContain("duplicate_email_in_file");
    expect(result.rows[1].context.duplicateOfRow).toBe(2);
  });

  it("matches a duplicate email case-insensitively", () => {
    // Two rows differing only in case are one person, and the access model
    // depends on an address naming exactly one human.
    const result = parseUserImport(
      csv([
        HEADER,
        ["Avery", "dupe@tapswipe.test", "agent", ""],
        ["Blake", "DUPE@Tapswipe.TEST", "agent", ""],
      ]),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rows[1].blockers).toContain("duplicate_email_in_file");
    }
  });

  it("blocks the second row sharing an agent number, naming the first", () => {
    const result = parseUserImport(
      csv([
        HEADER,
        ["Avery", "a@tapswipe.test", "agent", "4471"],
        ["Blake", "b@tapswipe.test", "agent", "4471"],
      ]),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows[0].blockers).toEqual([]);
    expect(result.rows[1].blockers).toContain("duplicate_agent_number_in_file");
    expect(result.rows[1].context.duplicateOfRow).toBe(2);
  });

  it("does not treat two blank agent numbers as duplicates of each other", () => {
    // The common case: nobody has processor codes yet. Blank is null, and null
    // collides with nothing.
    const result = parseUserImport(
      csv([
        HEADER,
        ["Avery", "a@tapswipe.test", "agent", ""],
        ["Blake", "b@tapswipe.test", "agent", ""],
      ]),
    );

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rows.every((row) => row.blockers.length === 0)).toBe(true);
    }
  });
});

describe("pickBlocker precedence", () => {
  it("reports nothing when there is nothing wrong", () => {
    expect(pickBlocker([])).toBeNull();
    expect(pickBlocker([null])).toBeNull();
  });

  it("puts a structural problem ahead of a collision", () => {
    // Telling an admin to go and look at an existing account, over a row that
    // was never valid in the first place, is the wrong instruction.
    expect(pickBlocker(["email_exists", "missing_name"])).toBe("missing_name");
  });

  it("puts an in-file contradiction ahead of a collision with reality", () => {
    expect(pickBlocker(["agent_number_taken", "duplicate_email_in_file"])).toBe(
      "duplicate_email_in_file",
    );
  });

  it("orders the two structural email problems by which is more basic", () => {
    expect(pickBlocker(["duplicate_email_in_file", "invalid_email"])).toBe(
      "invalid_email",
    );
  });
});

describe("isBlocking", () => {
  it("lets a row that collides with an existing account be skipped", () => {
    // Accounts are independent of one another, unlike one period's ledger rows.
    // Three people who already have logins must not stop thirty-nine who do not.
    expect(isBlocking("email_exists")).toBe(false);
    expect(isBlocking("agent_number_taken")).toBe(false);
  });

  it("blocks everything else", () => {
    expect(isBlocking("missing_name")).toBe(true);
    expect(isBlocking("invalid_email")).toBe(true);
    expect(isBlocking("duplicate_email_in_file")).toBe(true);
  });

  it("treats no blocker as not blocking", () => {
    expect(isBlocking(null)).toBe(false);
  });
});

describe("blockerMessage", () => {
  it("names the row a duplicate collides with", () => {
    expect(
      blockerMessage("duplicate_email_in_file", {
        email: "a@tapswipe.test",
        duplicateOfRow: 4,
      }),
    ).toBe("The file already used a@tapswipe.test on row 4.");
  });

  it("says a skipped row is skipped, so the outcome is not a surprise", () => {
    expect(
      blockerMessage("email_exists", { email: "a@tapswipe.test" }),
    ).toContain("skipped");
  });

  it("has a message for every blocker", () => {
    const all = [
      "missing_name",
      "invalid_email",
      "invalid_role",
      "invalid_agent_number",
      "invalid_legal_name",
      "invalid_llc_legal_name",
      "duplicate_email_in_file",
      "duplicate_agent_number_in_file",
      "email_exists",
      "agent_number_taken",
    ] as const;

    for (const blocker of all) {
      expect(blockerMessage(blocker, {}).length).toBeGreaterThan(0);
    }
  });

  it("names the 200-character cap for both identity blockers", () => {
    expect(blockerMessage("invalid_legal_name")).toBe(
      "Legal name must be 200 characters or fewer.",
    );
    expect(blockerMessage("invalid_llc_legal_name")).toBe(
      "LLC legal name must be 200 characters or fewer.",
    );
  });
});

/**
 * Phase 2 of docs/design/intake-and-reports.md: two optional columns, "Legal
 * name" and "LLC legal name", handed to set_rep_identity() once the account
 * exists. Optional at creation (memo A20); over the cap blocks the row, because
 * the RPC would refuse it after the account was already made.
 */
describe("parseUserImport — rep identity columns", () => {
  const IDENTITY_HEADER = [...HEADER, "Legal name", "LLC legal name"];

  it("maps both headers, case-insensitively, and keeps them optional", () => {
    const map = mapHeaders(["Full name", "Email", "LEGAL NAME", "llc legal name"]);
    expect(map.missing).toEqual([]);
    expect(map.index.legal_name).toBe(2);
    expect(map.index.llc_legal_name).toBe(3);
    expect(map.index.full_name).toBe(0);
    expect(COLUMN_HEADERS.legal_name).toBe("Legal name");
    expect(COLUMN_HEADERS.llc_legal_name).toBe("LLC legal name");
  });

  it("reads both, trimmed, alongside the display name", () => {
    const result = parseUserImport(
      csv([
        IDENTITY_HEADER,
        ["Ann", "ann@tapswipe.test", "", "", "  Ann Ito ", " Ito Payments LLC"],
      ]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const row = result.rows[0];
    expect(row.full_name).toBe("Ann");
    expect(row.legal_name).toBe("Ann Ito");
    expect(row.llc_legal_name).toBe("Ito Payments LLC");
    expect(row.legal_name_raw).toBe("Ann Ito");
    expect(row.blockers).toEqual([]);
  });

  it("reads a quoted LLC name containing a comma", () => {
    const result = parseUserImport(
      [
        IDENTITY_HEADER.join(","),
        'Ann,ann@tapswipe.test,,,Ann Ito,"Ito Payments, LLC"',
      ].join("\n"),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.rows[0].llc_legal_name).toBe("Ito Payments, LLC");
  });

  it("treats blank cells, and absent columns, as not given", () => {
    const blank = parseUserImport(
      csv([IDENTITY_HEADER, ["Ann", "ann@tapswipe.test", "", "", "  ", ""]]),
    );
    expect(blank.ok).toBe(true);
    if (blank.ok) {
      expect(blank.rows[0].legal_name).toBeNull();
      expect(blank.rows[0].llc_legal_name).toBeNull();
      expect(blank.rows[0].blockers).toEqual([]);
    }

    const absent = parseUserImport(csv([HEADER, ["Ann", "ann@tapswipe.test", "", ""]]));
    expect(absent.ok).toBe(true);
    if (absent.ok) {
      expect(absent.rows[0].legal_name).toBeNull();
      expect(absent.rows[0].llc_legal_name).toBeNull();
    }
  });

  it("accepts exactly 200 characters and blocks 201, keeping the raw text", () => {
    const result = parseUserImport(
      csv([
        IDENTITY_HEADER,
        ["Ann", "ann@tapswipe.test", "", "", "L".repeat(200), "C".repeat(200)],
        ["Bo", "bo@tapswipe.test", "", "", "L".repeat(201), "Lee LLC"],
        ["Cy", "cy@tapswipe.test", "", "", "Cy Ng", "C".repeat(201)],
      ]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const [ann, bo, cy] = result.rows;

    expect(ann.blockers).toEqual([]);
    expect(ann.legal_name).toHaveLength(200);

    expect(bo.blockers).toEqual(["invalid_legal_name"]);
    expect(bo.legal_name).toBeNull();
    expect(bo.legal_name_raw).toHaveLength(201);
    expect(bo.llc_legal_name).toBe("Lee LLC");
    expect(isBlocking("invalid_legal_name")).toBe(true);

    expect(cy.blockers).toEqual(["invalid_llc_legal_name"]);
    expect(cy.llc_legal_name).toBeNull();
    expect(cy.legal_name).toBe("Cy Ng");
  });

  it("ranks a missing name above an over-long legal name", () => {
    expect(pickBlocker(["invalid_legal_name", "missing_name"])).toBe(
      "missing_name",
    );
    expect(
      pickBlocker(["duplicate_email_in_file", "invalid_llc_legal_name"]),
    ).toBe("invalid_llc_legal_name");
  });
});
