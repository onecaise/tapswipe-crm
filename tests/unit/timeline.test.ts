import { describe, expect, it } from "vitest";

import type { Note, Task, WithAuthor } from "@/lib/annotations";
import type { DocumentRow } from "@/lib/documents";
import type { MarketingEvent, MarketingEventType } from "@/lib/marketing-materials";
import type { Quote } from "@/lib/quotes";
import {
  AUDITED_TIMELINE_TABLES,
  TIMELINE_SOURCES,
  TIMELINE_SOURCE_LABELS,
  auditActionLabel,
  buildLeadTimeline,
  compareTimelineEntries,
  mergeTimeline,
  type AuditRow,
  type TimelineEntry,
} from "@/lib/timeline";

/**
 * The lead timeline's merge, which is all of it that is pure.
 *
 * The SCOPING is not testable here and is not meant to be: every row this file
 * hands in has, in production, already come through a policy, and "an agent
 * reads zero audit rows" is a fact about `audit_log`'s `using (is_admin())`
 * rather than about any code. That half lives in e2e/lead-timeline.spec.ts,
 * where two real sessions load the same lead.
 *
 * What is left is the part that can be wrong without anything noticing: the
 * order. Ties are the interesting case and they are not rare — `created_at`
 * defaults to `now()`, which is frozen for a transaction, so a quote and the
 * audit row its own trigger writes carry the same microsecond.
 */

const LEAD_ID = 7;

function entry(over: Partial<TimelineEntry> & Pick<TimelineEntry, "source" | "id">): TimelineEntry {
  return {
    key: `${over.source}:${over.id}`,
    at: "2026-10-01T12:00:00+00:00",
    title: "t",
    detail: null,
    actorName: null,
    href: null,
    ...over,
  };
}

function note(over: Partial<WithAuthor<Note>> = {}): WithAuthor<Note> {
  return {
    id: 1,
    agent_id: "agent-uuid",
    owner_type: "lead",
    owner_id: LEAD_ID,
    body: "Called, left voicemail",
    created_at: "2026-10-01T12:00:00+00:00",
    author_name: "Rep One",
    ...over,
  };
}

function task(over: Partial<WithAuthor<Task>> = {}): WithAuthor<Task> {
  return {
    id: 1,
    agent_id: "agent-uuid",
    owner_type: "lead",
    owner_id: LEAD_ID,
    title: "Send pricing",
    due_date: "2026-10-09",
    completed: false,
    created_at: "2026-10-02T12:00:00+00:00",
    author_name: "Rep One",
    ...over,
  };
}

function document(over: Partial<DocumentRow> = {}): DocumentRow {
  return {
    id: 1,
    // The LEAD's owner, not the uploader — the whole reason these carry no
    // byline. See lib/timeline.ts.
    agent_id: "agent-uuid",
    owner_type: "lead",
    owner_id: LEAD_ID,
    doc_type: "Voided check",
    file_key: "agent-uuid/lead/7/abc",
    file_name: "check.pdf",
    mime_type: "application/pdf",
    uploaded_at: "2026-10-03T12:00:00+00:00",
    ...over,
  };
}

function quote(over: Partial<Quote> = {}): Quote {
  return {
    id: 1,
    quote_group_id: "group-a",
    version: 1,
    lead_id: LEAD_ID,
    // Null, because quotes_at_most_one_link permits one link and the
    // timeline is a LEAD feature — a merchant proposal never reaches it.
    merchant_id: null,
    customer_name: "Lead Seven Cafe",
    // The rep the proposal is for.
    agent_id: "agent-uuid",
    status: "draft",
    title: "Countertop package",
    notes: null,
    created_at: "2026-10-04T12:00:00+00:00",
    ...over,
  };
}

function marketing(
  over: Partial<MarketingEvent> & { event_type?: MarketingEventType } = {},
): MarketingEvent {
  return {
    id: 1,
    material_id: 42,
    lead_id: LEAD_ID,
    agent_id: "agent-uuid",
    event_type: "viewed",
    occurred_at: "2026-10-05T12:00:00+00:00",
    ...over,
  };
}

function audit(over: Partial<AuditRow> = {}): AuditRow {
  return {
    id: 1,
    actor_id: "admin-uuid",
    action: "cross_agent_update",
    table_name: "leads",
    row_id: String(LEAD_ID),
    created_at: "2026-10-06T12:00:00+00:00",
    ...over,
  };
}

const NAMES = new Map([
  ["agent-uuid", "Rep One"],
  ["admin-uuid", "Admin Two"],
]);
const TITLES = new Map([[42, "2026 rate card"]]);

/** Every source, one row each, so a feed built from this has all six. */
function fullInput(over: Partial<Parameters<typeof buildLeadTimeline>[0]> = {}) {
  return {
    leadId: LEAD_ID,
    notes: [note()],
    tasks: [task()],
    documents: [document()],
    quotes: [quote()],
    marketingEvents: [marketing()],
    materialTitles: TITLES,
    auditRows: [audit()],
    preAppId: null,
    actorNames: NAMES,
    ...over,
  };
}

describe("compareTimelineEntries — ordering", () => {
  it("puts the newest first across mixed sources", () => {
    const merged = mergeTimeline(
      [entry({ source: "note", id: 1, at: "2026-10-01T00:00:00+00:00" })],
      [entry({ source: "audit", id: 2, at: "2026-10-03T00:00:00+00:00" })],
      [entry({ source: "quote", id: 3, at: "2026-10-02T00:00:00+00:00" })],
    );

    expect(merged.map((e) => e.key)).toEqual(["audit:2", "quote:3", "note:1"]);
  });

  it("compares INSTANTS, not strings — a different offset is not a later time", () => {
    // 09:00Z and 10:00Z. Lexically "…T09:00:00+00:00" sorts ABOVE
    // "…T06:00:00-04:00", so a string comparison gets this exactly backwards
    // while looking entirely plausible on same-offset data.
    const earlierStamp = "2026-10-07T09:00:00+00:00";
    const laterStamp = "2026-10-07T06:00:00-04:00";

    // The trap, stated outright: the later instant is the LOWER string.
    expect(laterStamp > earlierStamp).toBe(false);
    expect(Date.parse(laterStamp)).toBeGreaterThan(Date.parse(earlierStamp));

    const merged = mergeTimeline(
      [entry({ source: "note", id: 1, at: earlierStamp })],
      [entry({ source: "note", id: 2, at: laterStamp })],
    );

    expect(merged.map((e) => e.key)).toEqual(["note:2", "note:1"]);
  });

  it("breaks an exact tie by source, with the audit trace after the act", () => {
    // create_quote_version() writes the quote and log_cross_agent_change()
    // writes its audit row inside one transaction, so now() is identical.
    const same = "2026-10-07T12:00:00.123456+00:00";
    const merged = mergeTimeline(
      [entry({ source: "audit", id: 9, at: same })],
      [entry({ source: "marketing", id: 9, at: same })],
      [entry({ source: "note", id: 9, at: same })],
      [entry({ source: "document", id: 9, at: same })],
      [entry({ source: "task", id: 9, at: same })],
      [entry({ source: "quote", id: 9, at: same })],
    );

    expect(merged.map((e) => e.source)).toEqual([
      "note",
      "task",
      "quote",
      "document",
      "marketing",
      "audit",
    ]);
  });

  it("breaks a same-source tie by id, newest row first", () => {
    const same = "2026-10-07T12:00:00+00:00";
    const merged = mergeTimeline([
      entry({ source: "note", id: 1, at: same }),
      entry({ source: "note", id: 3, at: same }),
      entry({ source: "note", id: 2, at: same }),
    ]);

    expect(merged.map((e) => e.id)).toEqual([3, 2, 1]);
  });

  it("is a TOTAL order — the result does not depend on input order", () => {
    // Array.prototype.sort is stable with respect to its INPUT, and the input
    // here is six concatenated lists. Without a deterministic tie-break the
    // feed would silently reshuffle when an unrelated source gained a row.
    const same = "2026-10-07T12:00:00+00:00";
    const rows = [
      entry({ source: "audit", id: 1, at: same }),
      entry({ source: "note", id: 2, at: same }),
      entry({ source: "note", id: 1, at: same }),
      entry({ source: "quote", id: 5, at: same }),
    ];

    const forward = mergeTimeline(rows).map((e) => e.key);
    const reversed = mergeTimeline([...rows].reverse()).map((e) => e.key);

    expect(reversed).toEqual(forward);
    // And no pair compares equal, which is what makes that guarantee hold.
    for (const a of rows) {
      for (const b of rows) {
        if (a.key === b.key) continue;
        expect(compareTimelineEntries(a, b)).not.toBe(0);
      }
    }
  });

  it("sends undated rows to the end rather than guessing a position", () => {
    const merged = mergeTimeline(
      [entry({ source: "note", id: 1, at: null })],
      [entry({ source: "task", id: 2, at: "2020-01-01T00:00:00+00:00" })],
      [entry({ source: "quote", id: 3, at: null })],
    );

    expect(merged.map((e) => e.key)).toEqual(["task:2", "note:1", "quote:3"]);
  });

  it("treats an unparseable timestamp as undated, not as 1970", () => {
    // Dated-as-epoch would also sort last today, so the two are told apart by
    // an entry that is genuinely older than the epoch would be.
    const merged = mergeTimeline(
      [entry({ source: "note", id: 1, at: "not a timestamp" })],
      [entry({ source: "note", id: 2, at: "1969-01-01T00:00:00+00:00" })],
    );

    expect(merged.map((e) => e.key)).toEqual(["note:2", "note:1"]);
  });

  it("orders undated rows among themselves deterministically", () => {
    const merged = mergeTimeline([
      entry({ source: "audit", id: 1, at: null }),
      entry({ source: "note", id: 1, at: null }),
      entry({ source: "note", id: 2, at: null }),
    ]);

    expect(merged.map((e) => e.key)).toEqual(["note:2", "note:1", "audit:1"]);
  });

  it("does not reorder the caller's arrays", () => {
    // The page hands in the very arrays it renders the five panels from.
    const group = [
      entry({ source: "note", id: 1, at: "2026-01-01T00:00:00+00:00" }),
      entry({ source: "note", id: 2, at: "2026-06-01T00:00:00+00:00" }),
    ];
    const before = group.map((e) => e.key);

    mergeTimeline(group);

    expect(group.map((e) => e.key)).toEqual(before);
  });
});

describe("buildLeadTimeline — mixed sources", () => {
  it("merges all six sources into one feed, newest first", () => {
    const { entries, truncated } = buildLeadTimeline(fullInput());

    expect(entries.map((e) => e.source)).toEqual([
      "audit", // 10-06
      "marketing", // 10-05
      "quote", // 10-04
      "document", // 10-03
      "task", // 10-02
      "note", // 10-01
    ]);
    expect(truncated).toBe(false);
    // Every declared source really is reachable, so adding a seventh without
    // wiring it up fails here rather than going quietly missing.
    expect(new Set(entries.map((e) => e.source))).toEqual(
      new Set(TIMELINE_SOURCES),
    );
  });

  it("gives every source a label, so none renders a blank chip", () => {
    for (const source of TIMELINE_SOURCES) {
      expect(TIMELINE_SOURCE_LABELS[source]).toBeTruthy();
    }
  });

  it("builds a feed with NO audit entries when the caller read none", () => {
    // This is the agent's case in production: audit_log's policy is
    // `using (is_admin())` with no own-row branch, so the query succeeds and
    // returns nothing. The rest of the feed must be unaffected.
    const { entries } = buildLeadTimeline(fullInput({ auditRows: [] }));

    expect(entries.filter((e) => e.source === "audit")).toEqual([]);
    expect(entries).toHaveLength(5);
  });

  it("keys entries uniquely even when ids collide across sources", () => {
    const { entries } = buildLeadTimeline(
      fullInput({
        notes: [note({ id: 1 })],
        tasks: [task({ id: 1 })],
        documents: [document({ id: 1 })],
        quotes: [quote({ id: 1 })],
        marketingEvents: [marketing({ id: 1 })],
        auditRows: [audit({ id: 1 })],
      }),
    );

    expect(new Set(entries.map((e) => e.key)).size).toBe(entries.length);
  });

  it("caps the feed and says that it did", () => {
    const many = Array.from({ length: 5 }, (_, i) =>
      note({ id: i + 1, created_at: `2026-10-0${i + 1}T00:00:00+00:00` }),
    );

    const { entries, truncated } = buildLeadTimeline(
      fullInput({ notes: many, limit: 3 }),
    );

    expect(entries).toHaveLength(3);
    expect(truncated).toBe(true);
    // Capped AFTER the merge: the three newest overall, not three per source.
    // audit 10-06, marketing 10-05T12:00, then the newest NOTE at 10-05T00:00 —
    // which is the whole point. Capped per source the note would have been
    // dropped to make room for a quote three days older.
    expect(entries.map((e) => e.source)).toEqual([
      "audit",
      "marketing",
      "note",
    ]);
    expect(entries[2].id).toBe(5);
  });
});

describe("buildLeadTimeline — audit rows are matched on the PAIR", () => {
  it("resolves a quote audit row to its version and its print link", () => {
    const { entries } = buildLeadTimeline(
      fullInput({
        quotes: [quote({ id: 31, quote_group_id: "group-z", version: 2 })],
        auditRows: [audit({ table_name: "quotes", row_id: "31" })],
      }),
    );

    const row = entries.find((e) => e.source === "audit");
    expect(row?.detail).toBe("Quote version 2");
    expect(row?.href).toBe(
      `/leads/${LEAD_ID}/quotes/group-z/print?quote=31`,
    );
  });

  it("drops a row whose id matches but whose TABLE does not", () => {
    // lead 7 and quote 7 both exist. Matching on row_id alone would file
    // quote 7's audit row under the lead, and an admin may read both, so no
    // policy would object.
    const { entries } = buildLeadTimeline(
      fullInput({
        quotes: [quote({ id: 99 })],
        auditRows: [audit({ table_name: "quotes", row_id: String(LEAD_ID) })],
      }),
    );

    expect(entries.filter((e) => e.source === "audit")).toEqual([]);
  });

  it("drops a lead audit row for a DIFFERENT lead", () => {
    const { entries } = buildLeadTimeline(
      fullInput({ auditRows: [audit({ row_id: "8" })] }),
    );

    expect(entries.filter((e) => e.source === "audit")).toEqual([]);
  });

  it("includes the lead's pre-app, and only when there is one", () => {
    const preAppRow = audit({
      table_name: "pre_apps",
      row_id: "55",
      action: "approve_pre_app",
    });

    const withPreApp = buildLeadTimeline(
      fullInput({ auditRows: [preAppRow], preAppId: 55 }),
    );
    const row = withPreApp.entries.find((e) => e.source === "audit");
    expect(row?.title).toBe("Pre-app approved");
    expect(row?.href).toBe("/pre-apps/55");

    // No pre-app on this lead, or a different one: not this lead's story.
    expect(
      buildLeadTimeline(fullInput({ auditRows: [preAppRow], preAppId: null }))
        .entries.filter((e) => e.source === "audit"),
    ).toEqual([]);
    expect(
      buildLeadTimeline(fullInput({ auditRows: [preAppRow], preAppId: 56 }))
        .entries.filter((e) => e.source === "audit"),
    ).toEqual([]);
  });

  it("drops rows from tables the feed does not cover, and rows with no pair", () => {
    const { entries } = buildLeadTimeline(
      fullInput({
        auditRows: [
          // documents is excluded on purpose — see AUDITED_TIMELINE_TABLES.
          audit({ id: 2, table_name: "documents", row_id: "1" }),
          audit({ id: 3, table_name: "profiles", row_id: "1" }),
          audit({ id: 4, table_name: null, row_id: String(LEAD_ID) }),
          audit({ id: 5, table_name: "leads", row_id: null }),
          audit({ id: 6, table_name: "leads", row_id: "not-a-number" }),
        ],
      }),
    );

    expect(entries.filter((e) => e.source === "audit")).toEqual([]);
    expect(AUDITED_TIMELINE_TABLES).not.toContain("documents");
  });

  it("names the actor, and calls a service-role write automated", () => {
    const { entries } = buildLeadTimeline(
      fullInput({
        auditRows: [
          audit({ id: 1, actor_id: "admin-uuid" }),
          audit({ id: 2, actor_id: null }),
          audit({ id: 3, actor_id: "somebody-the-caller-cannot-see" }),
        ],
      }),
    );

    const byId = new Map(
      entries
        .filter((e) => e.source === "audit")
        .map((e) => [e.id, e.actorName]),
    );
    expect(byId.get(1)).toBe("Admin Two");
    // Null actor_id and an unresolvable one both render with no name, and the
    // component tells them apart by source rather than by a flag here.
    expect(byId.get(2)).toBeNull();
    expect(byId.get(3)).toBeNull();
  });
});

describe("buildLeadTimeline — bylines and wording", () => {
  it("names note, task and marketing actors", () => {
    const { entries } = buildLeadTimeline(fullInput());
    const bySource = new Map(entries.map((e) => [e.source, e.actorName]));

    expect(bySource.get("note")).toBe("Rep One");
    expect(bySource.get("task")).toBe("Rep One");
    expect(bySource.get("marketing")).toBe("Rep One");
  });

  it("refuses a byline on documents and quotes", () => {
    // Their agent_id is the LEAD's owner, not whoever acted, so an admin's
    // upload on a rep's lead would be attributed to the rep. A plausible wrong
    // byline is worse than none.
    const { entries } = buildLeadTimeline(
      fullInput({
        documents: [document({ agent_id: "agent-uuid" })],
        quotes: [quote({ agent_id: "agent-uuid" })],
      }),
    );
    const bySource = new Map(entries.map((e) => [e.source, e.actorName]));

    expect(bySource.get("document")).toBeNull();
    expect(bySource.get("quote")).toBeNull();
  });

  it("dates a task by creation and carries the due date as detail", () => {
    const { entries } = buildLeadTimeline(
      fullInput({
        tasks: [
          task({
            created_at: "2026-10-02T12:00:00+00:00",
            due_date: "2027-01-01",
          }),
        ],
      }),
    );

    const row = entries.find((e) => e.source === "task");
    // Dated by the due date this would sit in 2027, above everything real.
    expect(row?.at).toBe("2026-10-02T12:00:00+00:00");
    expect(row?.detail).toContain("2027-01-01");
  });

  it("marks a completed task without inventing a completion time", () => {
    // `tasks` has no completed_at, so there is no instant to place a
    // "completed" event at. The state rides on the creation entry instead.
    const { entries } = buildLeadTimeline(
      fullInput({ tasks: [task({ completed: true })] }),
    );

    const rows = entries.filter((e) => e.source === "task");
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toMatch(/completed/i);
  });

  it("labels each quote version, and links to THAT version", () => {
    const { entries } = buildLeadTimeline(
      fullInput({
        quotes: [
          quote({ id: 1, version: 1, created_at: "2026-10-04T00:00:00+00:00" }),
          quote({ id: 2, version: 2, created_at: "2026-10-05T00:00:00+00:00" }),
        ],
      }),
    );

    const rows = entries.filter((e) => e.source === "quote");
    expect(rows.map((e) => e.title)).toEqual([
      "Quote revised to v2",
      "Quote created",
    ]);
    // Explicit ?quote=, never the bare group URL — that prints whatever is
    // current now, so a v1 row would show v2's figures under v1's date.
    for (const row of rows) {
      expect(row.href).toContain(`?quote=${row.id}`);
    }
  });

  it("never claims an email was sent", () => {
    // No send path exists in this codebase. "Emailed" in a list of things that
    // happened is how an admin comes to believe a proposal went out.
    const { entries } = buildLeadTimeline(
      fullInput({ marketingEvents: [marketing({ event_type: "emailed" })] }),
    );

    const row = entries.find((e) => e.source === "marketing");
    expect(row?.title).toMatch(/no email was sent/i);
    expect(row?.title).not.toBe("Emailed");
  });

  it("names a material by id when its title cannot be resolved", () => {
    const { entries } = buildLeadTimeline(
      fullInput({
        marketingEvents: [marketing({ material_id: 404 })],
      }),
    );

    expect(entries.find((e) => e.source === "marketing")?.detail).toBe(
      "Material #404",
    );
  });
});

describe("auditActionLabel", () => {
  it("labels the trigger verbs factually, without naming a role", () => {
    // The trigger fires whenever the actor is not the row's owner, which
    // includes a service-role write with no actor at all — so "by an
    // administrator" would over-claim. The byline carries who.
    expect(auditActionLabel("cross_agent_update")).toBe("Record updated");
    expect(auditActionLabel("cross_agent_insert")).toBe("Record created");
    expect(auditActionLabel("cross_agent_delete")).toBe("Record deleted");
    expect(auditActionLabel("record_reassigned")).toBe(
      "Reassigned to another rep",
    );
    for (const verb of [
      "cross_agent_update",
      "cross_agent_insert",
      "cross_agent_delete",
    ]) {
      expect(auditActionLabel(verb).toLowerCase()).not.toContain("admin");
    }
  });

  it("carries a templated verb's qualifier through", () => {
    // read-pre-app-secrets writes `read_pre_app_secrets:full|last4`, so the
    // vocabulary is open and the stem has to be matched on its own.
    expect(auditActionLabel("read_pre_app_secrets:full")).toBe(
      "Sensitive data viewed (full)",
    );
    expect(auditActionLabel("read_pre_app_secrets:last4")).toBe(
      "Sensitive data viewed (last4)",
    );
    expect(auditActionLabel("submit_pre_app_secrets:owner_ssn")).toBe(
      "Sensitive data submitted (owner ssn)",
    );
  });

  it("renders an unmapped verb rather than crashing on it", () => {
    // Same rule as the lead status badge: a value outside the vocabulary is
    // normal here, because several writers template their verb.
    expect(auditActionLabel("some_future_action")).toBe("Some future action");
    expect(auditActionLabel("upload_document:lead")).toBe(
      "Upload document lead",
    );
    expect(auditActionLabel("")).toBe("Recorded action");
    expect(auditActionLabel(":")).toBe("Recorded action");
  });
});
