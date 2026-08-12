import { describe, expect, it } from "vitest";

import {
  ANNOTATION_OWNER_LABELS,
  ANNOTATION_OWNER_TYPES,
  DEFAULT_TASK_INDEX_FILTER,
  TASK_INDEX_FILTERS,
  TASK_INDEX_FILTER_OPTIONS,
  annotationOwnerHref,
  parseTaskIndexFilter,
} from "@/lib/annotations";

/**
 * The pure half of the /notes and /tasks index pages.
 *
 * The scoping is proved in tests/rls/notes-tasks.test.ts against real policies.
 * What is left here is the vocabulary: every owner type needs a label and a
 * route, and an untrusted ?status= has to narrow to something the query can use.
 */
describe("annotationOwnerHref", () => {
  it("routes every owner type to a page that exists", () => {
    expect(annotationOwnerHref("lead", 7)).toBe("/leads/7");
    expect(annotationOwnerHref("pre_app", 7)).toBe("/pre-apps/7");
    expect(annotationOwnerHref("merchant", 7)).toBe("/merchants/7");
    expect(annotationOwnerHref("ghost_sheet", 7)).toBe("/ghost-sheets/7");
  });

  it("covers the whole union, so a fifth owner type fails here", () => {
    // Not a formality: the union mirrors a check constraint, and the cost of
    // missing a case is a blank cell or a dead link rather than an error.
    for (const ownerType of ANNOTATION_OWNER_TYPES) {
      expect(annotationOwnerHref(ownerType, 1)).toMatch(/^\/[a-z-]+\/1$/);
      expect(ANNOTATION_OWNER_LABELS[ownerType]).toBeTruthy();
    }
  });

  it("keeps the pair distinct — same id, different type, different route", () => {
    // lead 1 and merchant 1 both exist in the fixtures. Anything that keys on
    // owner_id alone mixes them, and RLS will not object.
    expect(annotationOwnerHref("lead", 1)).not.toBe(
      annotationOwnerHref("merchant", 1),
    );
  });
});

describe("parseTaskIndexFilter", () => {
  it("accepts every declared filter", () => {
    for (const filter of TASK_INDEX_FILTERS) {
      expect(parseTaskIndexFilter(filter)).toBe(filter);
    }
  });

  it("falls back to open for anything unrecognised", () => {
    // Falling back rather than passing the raw value through: an unknown filter
    // reaching the query returns zero rows, which reads as "you have no tasks"
    // instead of "that filter doesn't exist".
    expect(parseTaskIndexFilter(undefined)).toBe(DEFAULT_TASK_INDEX_FILTER);
    expect(parseTaskIndexFilter("")).toBe(DEFAULT_TASK_INDEX_FILTER);
    expect(parseTaskIndexFilter("archived")).toBe(DEFAULT_TASK_INDEX_FILTER);
    expect(parseTaskIndexFilter("OPEN")).toBe(DEFAULT_TASK_INDEX_FILTER);
  });

  it("defaults to open, not all", () => {
    // The default is what the page shows on a bare /tasks. Open is the useful
    // one; a list dominated by completed work is not.
    expect(DEFAULT_TASK_INDEX_FILTER).toBe("open");
  });

  it("offers a tab for every filter", () => {
    expect(TASK_INDEX_FILTER_OPTIONS.map((o) => o.value)).toEqual([
      ...TASK_INDEX_FILTERS,
    ]);
  });
});
