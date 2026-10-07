import { createClient } from "@/lib/supabase/server";
import { resolveProfileNames } from "@/lib/annotations-data";
import { AUDIT_COLUMNS, type AuditRow } from "@/lib/timeline";

/**
 * The lead timeline's only read — the admin-only audit trail — plus the byline
 * lookup the merged feed needs.
 *
 * Everything else the timeline shows is already on the lead page: notes,
 * tasks, documents, quotes and marketing events are all loaded there for the
 * panels, and lib/timeline.ts re-sorts those same rows without touching the
 * network. This file exists so that the one genuinely new query lives beside
 * the reasoning for it rather than inline in a page.
 *
 * ## What each role gets back, exactly
 *
 * `audit_log` has ONE select policy and no own-row branch:
 *
 *     create policy "admin reads audit log" on audit_log
 *       for select using (is_admin());
 *
 * So an **admin** reads every matching row, and an **agent** reads none —
 * on their own lead as readily as on anyone else's. The grant is real
 * (`grant select on audit_log to authenticated`), so this is not a permission
 * error: the request succeeds and comes back empty. The feed is thinner for a
 * rep and nothing anywhere pretends otherwise.
 *
 * ## Why the query still runs for an agent
 *
 * It would be cheap to skip it on `role !== "admin"` and the answer would be
 * identical today. It is deliberately not skipped. A role branch here is a
 * copy of the policy in application code — the thing the rest of this codebase
 * is careful to avoid — and it has a specific failure mode: if `audit_log` ever
 * gains an own-row branch for reps, the policy would start returning rows while
 * this file kept showing none, and nothing would fail. Letting RLS answer means
 * the feed widens by itself the moment the policy does.
 *
 * The cost is near zero in any case. `is_admin()` is a stable zero-argument
 * function, so Postgres evaluates it once per query and the scan returns
 * immediately for a non-admin.
 *
 * ## No definer escape hatch, and none needed
 *
 * There is no `security definer` RPC behind this and no service-role client.
 * Both would make the feed richer for a rep and both would be the wrong trade:
 * the admin-only trail is the record of what was done to a rep's book by
 * somebody else, and `check_duplicates()` is the only function in this schema
 * that reaches past RLS — it pays for that with a hand-written guard and a
 * redacted return shape, which is a lot of machinery to buy a prettier page.
 */

/**
 * Audit rows belonging to a lead's story: the lead, its quotes, its pre-app.
 *
 * ONE QUERY PER TABLE, and that is not stylistic. `audit_log.row_id` is `text`
 * and ids collide freely across tables — lead 7, quote 7 and pre-app 7 all
 * plausibly exist — so a single `.in("table_name", …).in("row_id", …)` would
 * cross-match: quote 7's audit row would surface on lead 7's timeline, and no
 * policy would object because an admin may read both. The pair has to be
 * filtered as a pair, which three `.eq(table).in(ids)` reads do and one
 * combined read cannot.
 *
 * `lib/timeline.ts`'s `auditEntries()` re-checks the pair when it builds the
 * entries. That is belt-and-braces on purpose: this is the layer that can be
 * replaced by a cleverer query, and the one that re-derives the match is the
 * one that cannot be skipped.
 *
 * Note there is no index on `audit_log` (no migration creates one), so these
 * are sequential scans for an admin. Fine at the table's current size, and
 * adding one is a schema change rather than part of a read-only feature — the
 * obvious shape when it is needed is `(table_name, row_id)`.
 */
export async function loadLeadTimelineExtras(input: {
  leadId: number;
  /** Quote ids already read on the page, under the quotes select policy. */
  quoteIds: readonly number[];
  /** The pre-app that came off this lead, if any. */
  preAppId: number | null;
  /**
   * Profile ids on rows the page already holds — note, task and marketing
   * authors. Unioned with the audit actors so one lookup covers every byline
   * in the feed instead of one per source.
   */
  knownActorIds: readonly string[];
}): Promise<{ auditRows: AuditRow[]; actorNames: Map<string, string> }> {
  const supabase = await createClient();

  const [leadAudit, quoteAudit, preAppAudit] = await Promise.all([
    supabase
      .from("audit_log")
      .select(AUDIT_COLUMNS)
      .eq("table_name", "leads")
      .eq("row_id", String(input.leadId))
      .order("created_at", { ascending: false })
      .order("id", { ascending: false }),

    // Skipped entirely when the lead has no quotes: `.in()` with an empty list
    // is a request that can only return nothing.
    input.quoteIds.length === 0
      ? Promise.resolve({ data: [] })
      : supabase
          .from("audit_log")
          .select(AUDIT_COLUMNS)
          .eq("table_name", "quotes")
          .in("row_id", input.quoteIds.map(String))
          .order("created_at", { ascending: false })
          .order("id", { ascending: false }),

    input.preAppId === null
      ? Promise.resolve({ data: [] })
      : supabase
          .from("audit_log")
          .select(AUDIT_COLUMNS)
          .eq("table_name", "pre_apps")
          .eq("row_id", String(input.preAppId))
          .order("created_at", { ascending: false })
          .order("id", { ascending: false }),
  ]);

  // An error is treated as no rows rather than thrown. The timeline is a
  // read-only summary beside five panels that each render their own source, so
  // a failed audit read must not take the lead page down — and for a rep the
  // empty result is the correct answer anyway, which is exactly why this must
  // never be the only thing standing between a rep and an admin row.
  const auditRows = [
    ...((leadAudit.data ?? []) as AuditRow[]),
    ...((quoteAudit.data ?? []) as AuditRow[]),
    ...((preAppAudit.data ?? []) as AuditRow[]),
  ];

  const actorNames = await resolveProfileNames(supabase, [
    ...input.knownActorIds,
    // Null actor_id is a service-role write and names nobody to look up.
    ...auditRows
      .map((row) => row.actor_id)
      .filter((id): id is string => id !== null),
  ]);

  return { auditRows, actorNames };
}
