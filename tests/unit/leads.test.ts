import { describe, expect, it } from "vitest";

import {
  LEAD_FOLLOWUP_FILTER_OPTIONS,
  LEAD_STATUSES,
  LEAD_STATUS_FILTER_OPTIONS,
  LEAD_STATUS_LABELS,
  isLeadStatus,
  leadsHref,
  parseLeadFollowupFilter,
  parseLeadStatusFilter,
  statusIntent,
} from "@/lib/leads";

describe("isLeadStatus", () => {
  it("accepts every value in the vocabulary", () => {
    for (const status of LEAD_STATUSES) {
      expect(isLeadStatus(status)).toBe(true);
    }
  });

  it("rejects the values rows written before the constraint can hold", () => {
    // leads_status_vocabulary is NOT VALID, so these really are in the table.
    // Every read path has to narrow rather than trust the type.
    expect(isLeadStatus("open")).toBe(false);
    expect(isLeadStatus("Left voicemail")).toBe(false);
    expect(isLeadStatus("")).toBe(false);
    expect(isLeadStatus(null)).toBe(false);
  });

  it("rejects 'won', which is derived and never stored", () => {
    expect(isLeadStatus("won")).toBe(false);
  });
});

describe("statusIntent", () => {
  it("colours 'lost' grey, never red", () => {
    // Brand and destructive red never appear on a status badge. A lost lead is
    // an inert record, not a danger — colouring it like the delete button puts
    // every closed-out row in the palette reserved for irreversible actions.
    expect(statusIntent("lost")).toBe("neutral");
  });

  it("treats 'application_sent' as the one success", () => {
    // It is the only stage meaning the work left this table and became a
    // pre-app. Everything after that is pre_apps.status's business.
    expect(statusIntent("application_sent")).toBe("success");
  });

  it("treats the three waiting-on-the-merchant stages as warning", () => {
    expect(statusIntent("contacted")).toBe("warning");
    expect(statusIntent("qualified")).toBe("warning");
    expect(statusIntent("proposal_sent")).toBe("warning");
  });

  it("treats 'new' and 'nurturing' as inert", () => {
    expect(statusIntent("new")).toBe("neutral");
    expect(statusIntent("nurturing")).toBe("neutral");
  });

  it("falls back to neutral for a value outside the vocabulary", () => {
    // A pre-migration row must render, not crash the list page it appears on.
    expect(statusIntent("Left voicemail")).toBe("neutral");
    expect(statusIntent(null)).toBe("neutral");
  });

  it("returns one of the three shared intents for every known status", () => {
    for (const status of LEAD_STATUSES) {
      expect(["success", "warning", "neutral"]).toContain(statusIntent(status));
    }
  });
});

describe("filter parsing", () => {
  it("narrows an unrecognised value to 'all' rather than querying it", () => {
    // Passing the raw value through would return zero rows, which reads as
    // "you have no leads" instead of "that filter doesn't exist".
    expect(parseLeadStatusFilter("in_progress")).toBe("all");
    expect(parseLeadStatusFilter(undefined)).toBe("all");
    expect(parseLeadFollowupFilter("yesterday")).toBe("all");
    expect(parseLeadFollowupFilter(undefined)).toBe("all");
  });

  it("keeps a real value", () => {
    expect(parseLeadStatusFilter("proposal_sent")).toBe("proposal_sent");
    expect(parseLeadFollowupFilter("overdue")).toBe("overdue");
  });

  it("does not accept a follow-up value as a status, or the reverse", () => {
    // The two filters share the 'all' value and nothing else. They were one
    // param until leads got a status; crossing them would silently restore the
    // bug that move fixed.
    expect(parseLeadStatusFilter("overdue")).toBe("all");
    expect(parseLeadFollowupFilter("qualified")).toBe("all");
  });

  it("offers a labelled tab for every status, plus All", () => {
    expect(LEAD_STATUS_FILTER_OPTIONS).toHaveLength(LEAD_STATUSES.length + 1);
    expect(LEAD_STATUS_FILTER_OPTIONS[0]).toEqual({
      value: "all",
      label: "All",
    });
    for (const status of LEAD_STATUSES) {
      expect(LEAD_STATUS_FILTER_OPTIONS).toContainEqual({
        value: status,
        label: LEAD_STATUS_LABELS[status],
      });
    }
  });

  it("labels the follow-up 'all' tab away from the pipeline's", () => {
    // Two rows of chips both reading "All" is how a user learns one of them
    // does nothing.
    expect(LEAD_FOLLOWUP_FILTER_OPTIONS[0]).toEqual({
      value: "all",
      label: "Any date",
    });
  });
});

describe("leadsHref", () => {
  it("keeps the unfiltered page at a bare /leads", () => {
    expect(leadsHref("all", "all")).toBe("/leads");
  });

  it("carries one filter when only one is set", () => {
    expect(leadsHref("qualified", "all")).toBe("/leads?status=qualified");
    expect(leadsHref("all", "overdue")).toBe("/leads?followup=overdue");
  });

  it("preserves the other filter when changing one", () => {
    // The whole point of two filters is combining them. A tab that dropped the
    // other would make the pair unusable: pick a stage, lose your date window,
    // pick the window back, lose the stage.
    expect(leadsHref("qualified", "overdue")).toBe(
      "/leads?status=qualified&followup=overdue",
    );
  });
});
