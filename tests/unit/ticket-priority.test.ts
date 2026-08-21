import { describe, expect, it } from "vitest";

import {
  DEFAULT_TICKET_PRIORITY,
  SUPPORT_TICKET_FORM_STATUSES,
  SUPPORT_TICKET_STATUSES,
  TICKET_PRIORITIES,
  supportTicketPriorityOptions,
  supportTicketStatusIntent,
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

/**
 * The status control's vocabulary, which is deliberately NOT the column's.
 *
 * SUPPORT_TICKET_STATUSES mirrors the check constraint and has to keep all
 * three, because the filter tabs and the badges read closed tickets.
 * SUPPORT_TICKET_FORM_STATUSES is what a form may *write*, and drops "closed"
 * because closing is irreversible (support_tickets_guard_close, migration
 * 20260821113000) and belongs behind a confirmation step.
 *
 * Nothing type-checks that relationship — both are `readonly string[]` as far as
 * TypeScript cares — so the failure mode without this test is quiet: someone
 * "fixes the inconsistency" by pointing the form's select back at the full
 * vocabulary, and closing silently becomes a dropdown option again, with the
 * reopen it also offers now raising a 409 nobody can explain.
 */
describe("SUPPORT_TICKET_FORM_STATUSES", () => {
  it("offers the two interchangeable statuses and not the terminal one", () => {
    expect(SUPPORT_TICKET_FORM_STATUSES).toEqual(["open", "pending"]);
  });

  it("keeps closed in the full vocabulary, which reads rather than writes", () => {
    // If this ever fails, the filter tabs and the status badge lost their
    // ability to describe a closed ticket — a different bug entirely from the
    // one above, and the reason these are two lists rather than one.
    expect(SUPPORT_TICKET_STATUSES).toContain("closed");
  });

  it("is a strict subset, so the form can never offer an invalid status", () => {
    // The database's check constraint is the authority. A form value outside it
    // fails as a 400 with a constraint name in it, which is not a sentence a rep
    // can act on.
    for (const status of SUPPORT_TICKET_FORM_STATUSES) {
      expect(SUPPORT_TICKET_STATUSES).toContain(status);
    }
    expect(SUPPORT_TICKET_FORM_STATUSES.length).toBeLessThan(
      SUPPORT_TICKET_STATUSES.length,
    );
  });

  it("maps every offered status to a distinct badge intent", () => {
    // The three intents stay separable, which is the point of mapping through
    // supportTicketStatusIntent at all — amber for needs-work, grey for parked,
    // green for done. Closing has to be visible as a state change, not just a
    // disappearance from the queue.
    expect(supportTicketStatusIntent("open")).toBe("warning");
    expect(supportTicketStatusIntent("pending")).toBe("neutral");
    expect(supportTicketStatusIntent("closed")).toBe("success");
  });
});
