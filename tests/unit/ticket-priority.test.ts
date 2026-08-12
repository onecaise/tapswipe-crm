import { describe, expect, it } from "vitest";

import {
  DEFAULT_TICKET_PRIORITY,
  TICKET_PRIORITIES,
  supportTicketPriorityOptions,
} from "@/lib/support-tickets";

/**
 * The priority control's vocabulary.
 *
 * The column is bare `text` with no check constraint — tests/rls/support-tickets
 * proves all four levels store and read back — so nothing in the database
 * enforces this list. It exists only here, which is exactly why it is worth
 * pinning: the field shipped as a <datalist> that rendered as a plain textbox
 * pre-filled "Normal", and the levels were invisible rather than absent.
 */
describe("supportTicketPriorityOptions", () => {
  it("offers every level, not just the default", () => {
    // The reported bug, as an assertion.
    expect(supportTicketPriorityOptions(undefined)).toEqual([
      "Low",
      "Normal",
      "High",
      "Urgent",
    ]);
  });

  it("defaults to Normal", () => {
    expect(DEFAULT_TICKET_PRIORITY).toBe("Normal");
    expect(TICKET_PRIORITIES).toContain(DEFAULT_TICKET_PRIORITY);
  });

  it("does not duplicate a value the ticket already holds", () => {
    expect(supportTicketPriorityOptions("High")).toEqual([...TICKET_PRIORITIES]);
  });

  it("keeps a stored value that is not one of the four", () => {
    // The column is unconstrained, so an older ticket can hold anything. Losing
    // it here would mean opening the edit form silently rewrote a field nobody
    // touched — a save that changes data it was not asked to.
    expect(supportTicketPriorityOptions("P1 — escalated")).toEqual([
      ...TICKET_PRIORITIES,
      "P1 — escalated",
    ]);
  });

  it("ignores empty and null, rather than offering a blank option", () => {
    expect(supportTicketPriorityOptions("")).toEqual([...TICKET_PRIORITIES]);
    expect(supportTicketPriorityOptions(null)).toEqual([...TICKET_PRIORITIES]);
  });
});
