import { describe, expect, it } from "vitest";

import { DB_ERROR_MESSAGES, friendlyDbError } from "@/lib/db-errors";

/**
 * C2 (D-05). A constraint violation reaching a form used to read as Postgres
 * text ("numeric field overflow", "duplicate key value violates unique
 * constraint …"). friendlyDbError() turns the five common SQLSTATEs into plain
 * sentences — and must leave our own RPCs' deliberate messages alone, because
 * those ARE the plain sentences.
 */
const err = (code: string | undefined, message: string) => ({ code, message, details: null, hint: null });

describe("friendlyDbError — five codes, plain words", () => {
  it.each([
    ["23505", /already exists/],
    ["23503", /no longer exists|can't use/],
    ["23514", /isn't allowed/],
    ["22003", /too large/],
    ["22P02", /format/],
  ])("maps %s", (code, words) => {
    const raw = "raw postgres text that must not reach the screen";
    const out = friendlyDbError(err(code, raw), "fallback");
    expect(out).toMatch(words);
    expect(out).toBe(DB_ERROR_MESSAGES[code as keyof typeof DB_ERROR_MESSAGES]);
    expect(out).not.toContain("postgres");
  });

  it("lets a caller's own wording for a code win", () => {
    expect(
      friendlyDbError(err("23505", "duplicate key … merchants_mid_key"), "x", {
        "23505": "That MID is already in use.",
      }),
    ).toBe("That MID is already in use.");
  });
});

describe("friendlyDbError — our own messages pass through verbatim", () => {
  it.each([
    ["P0001", "This pre-app can only be edited while it is a draft."],
    ["PT409", "That proposal has a newer version. Reload to see it."],
    ["PT422", "Product 41 has no list price yet, so it cannot be quoted."],
    ["PT403", "Only an admin can do that."],
  ])("%s keeps its message", (code, message) => {
    expect(friendlyDbError(err(code, message), "fallback")).toBe(message);
  });

  it("an Error without a code keeps its message", () => {
    expect(friendlyDbError(new Error("That lead could not be updated."), "fallback")).toBe(
      "That lead could not be updated.",
    );
  });

  it("anything else gets the fallback", () => {
    expect(friendlyDbError(null, "fallback")).toBe("fallback");
    expect(friendlyDbError("boom", "fallback")).toBe("fallback");
    expect(friendlyDbError({ code: "23505" }, "fallback")).toBe(DB_ERROR_MESSAGES["23505"]);
    expect(friendlyDbError({ message: "" }, "fallback")).toBe("fallback");
  });

  it("does not treat a prototype key as a code", () => {
    expect(friendlyDbError(err("constructor", "kept"), "fallback")).toBe("kept");
  });
});
