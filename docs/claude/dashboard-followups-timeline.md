# Dashboard filters, follow-ups, and the lead timeline

Moved verbatim from `CLAUDE.md` on 19 Oct 2026 to keep that file under the size limit. **These are binding rules, not history** — CLAUDE.md's "Security and safety rules" summary points here. Words like "above", "below" or "this file" refer to the original single CLAUDE.md; the docs index at the end of CLAUDE.md says where each section now lives.

### The dashboard's filters narrow a view the caller already had in full

`dashboard_counts()` takes six optional parameters as of `20261007120000` — rep
(`agent_id`), manager (via `profiles.manager_id`), territory, lead stage, and a
`created_at` range — and **stays security invoker**. That is the whole design,
not a property it happens to retain.

Every parameter is an extra `WHERE` clause **ANDed on top of** the caller's own
policies, never a substitute for one. An agent who passes another rep's
`agent_id` gets `agent_id = other` and the policy's `agent_id = auth.uid()`,
which is unsatisfiable — so the answer is zero, and that is a consequence of the
function not bypassing anything rather than a check it performs. The manager and
territory filters resolve *through* `profiles`, and that subselect is RLS-scoped
too (own-row plus admin), so for an agent it can only ever return their own row:
**the same call gives an admin the whole team and a rep only themselves.**
`tests/rls/dashboard-filters.test.ts` asserts both halves, and asserts
`prosecdef` is false — flip that and every scoping assertion in the file
silently becomes an assertion about nothing.

**It is not an access change.** No policy is touched, and none reads
`manager_id` or `territory` — both stay the reporting labels their column
comments describe. A manager gains no wider book by being nameable here; what
this adds is filtering **for an admin who already sees every row**, which is the
exact use `profiles.manager_id`'s own comment anticipates. The test greps
`pg_policies` for both words, the same way `set-manager` and `set-territory` do.

Three decisions worth knowing before changing any of it:

- **The zero-argument function is DROPPED, not replaced.** Left beside the new
  one it would give a bare `dashboard_counts()` two candidates, since every new
  parameter has a default — an ambiguity Postgres reports at call time, from the
  browser, not in the migration. A test asserts the name resolves exactly once.
- **A stage filter gets its own output column, `leads_at_stage`**, rather than
  narrowing `active_leads`. That column means "a lead no pre-app points at yet",
  a funnel position the records prove; a stage is something a rep types. Folded
  together, one output would mean two things depending on a parameter — and
  would read as near-zero for `application_sent`, whose leads are precisely the
  ones a pre-app points at, while looking entirely healthy. It is **null** when
  no stage was asked for, which is a different fact from zero and renders as a
  different thing (no card at all).
- **The upper date bound is `< to + 1`, not `<= to`.** `created_at` is a
  timestamptz, so `<=` compares against midnight and drops everything created on
  the last day of the range the person believes they asked for — a plausible set
  of smaller numbers with nothing to say it is wrong.

The filter bar (`components/dashboard-filters.tsx`) is a **server component with
no client JavaScript**: stage is a `FilterTabs` row whose chips carry the other
five filters (the job `leadsHref` does for the leads list's pair), and
rep/manager/territory/dates are a plain GET form with an Apply button. A rep
list is unbounded, so those four could not be chips; a form keeps them linkable
and working with JS off rather than introducing a second interaction model. The
three people controls are **admin-only in the UI** — not because a rep sending
`?rep=…` would learn anything, but because for a rep every setting of them is
their own numbers again or a blank page, and a control whose every option is a
no-op is a broken control.

**The "Your tasks" digest takes no part in any of it**, and that is structural
rather than a promise: `DashboardTasks` reads `profile.id` and never
`searchParams`, and sits in its own `<Suspense>` boundary *outside*
`DashboardOverview`. The page says so in a line under the heading, because the
filter bar sits directly above it and an admin who has just narrowed the
overview to one rep would otherwise read that list as that rep's.
`e2e/dashboard-filters.spec.ts` pins it by choosing a date range that empties
every figure above and showing the digest did not move.

**The e2e specs assert no hardcoded counts.** Numbers in the dev database move —
the live suite writes to the same stack — so each filter is checked by
*cross-reading*: an admin filtering by one rep must see exactly what that rep
sees on their own dashboard, which the suite can load because it holds a storage
state for them. That is both robust and a sharper claim than a constant: it says
the filter selected the same rows the policy would.

### Follow-ups live in two places, and they are reconciled in the UI rather than in the schema

`leads.next_followup_date` and the generic `tasks` table both answer "when is
the next thing to do on this lead", and they stay **separate columns on
purpose**. Three things decided it, and all three are reasons not to "fix" the
duplication later:

- **`tasks.owner_id` carries no foreign key** — it points into four tables — and
  PostgREST needs one to embed. So a lead cannot cheaply pull its own tasks.
- **The leads list would lose its single indexed query.** Today "order by next
  follow-up, show overdue" is one scan of one table. Derived from `tasks` it is
  N+1 or a new view/RPC, and the "Unscheduled" filter becomes a `NOT EXISTS`
  with no FK for the planner to use.
- **A sync trigger was considered and rejected.** Writing the lead from a task
  would fire the lead's own `log_cross_agent_change()`, so an admin adding a
  task on a rep's lead would produce **two audit rows for one event** — noise
  bought for a convenience.

The accepted cost is real and is written down rather than hidden: a rep can
leave `next_followup_date` blank while a task is due tomorrow, and the leads
list files that lead under "Unscheduled". The mitigation is two UI surfaces,
neither of which stores anything new — nothing is duplicated, so nothing can
drift silently afterwards:

- `components/followup-reconcile.tsx` on the lead detail page, which surfaces
  the earliest open task's date beside the lead's own and offers one click that
  writes `leads.next_followup_date`. It renders **nothing** when there is no
  dated open task; a permanent banner on every lead is how a prompt becomes
  wallpaper.
- The **"Your tasks" digest** on `/dashboard`, which is the login-surfaced half:
  what is late, and what is due inside `nextWeekBound()` — literally the leads
  list's own "Next 7 days", so a rep working a day sees one horizon rather than
  two.

`earliestOpenTaskDue()` in `lib/annotations.ts` is the one definition of "the
earliest open task", for the reason `currentVersion()` is the one definition of
a quote's current version: spelled inline, the surface that *shows* the date and
the control that *writes* it come to disagree about which task they mean. It
skips completed tasks — a bare `Math.min` over the panel's rows offers the date
of work already done, which is the fixture's `done` row and the trap it exists
for.

**The digest narrows by `agent_id` in application code, and that is not the rule
this repo otherwise follows.** `TaskIndexScope` in `lib/annotations-data.ts` is
the distinction: the standing "don't copy a policy into application code" rule
is about a query that means *everything I may see*; this means *a subset of it,
chosen by the page*. RLS hands an admin every task in the database and is right
to — `/tasks` shows them all — but an admin's own landing page listing the whole
company's work is not a digest. A company-wide view is a different feature with
a different shape. Because no policy expresses this, **no RLS test can see it**:
`e2e/followups.spec.ts` is the only place that promise is checked, and it checks
both halves (the admin's dashboard omits the rep's task; `/tasks` still shows it
to them), so a broken read cannot pass as correct scoping.

### The lead timeline merges five sources and widens none of them

`components/lead-timeline.tsx` on the lead detail page is one chronological
feed over notes, tasks, quote versions, marketing events and the audit trail.
(Documents were a sixth until 13 Oct 2026: once `documents` became
admin-read-only, a document source could only have shown on an admin's feed,
breaking the rep/admin cross-read below, so it was removed.) **It is a
re-projection, not a fifth set of reads**: the page already loads four of those
for its panels, so `lib/timeline.ts` is **pure** —
it takes rows and returns entries, which is what lets
`tests/unit/timeline.test.ts` import it with no database. `lib/timeline-data.ts`
holds the only genuinely new query. Extending `loadAnnotations()` instead would
have pushed a lead-only concern into a function four detail pages share, and a
`loadLeadTimeline()` doing its own five reads would have doubled every one of
them on the page's hot path.

**`audit_log` is admin-only with NO own-row branch, and that is the whole
scoping story.** Its single policy is `for select using (is_admin())`, so an
**agent reads zero audit rows — on their own lead as much as anyone else's** —
while `grant select on audit_log to authenticated` means the query *succeeds*
and returns nothing. A rep's feed therefore simply has no audit entries, and
the page says **nothing** about the gap: a permanent notice would be wallpaper
on every lead (the thing `followup-reconcile.tsx` renders nothing to avoid),
and a conditional one would announce that an admin had touched the record,
which is exactly what the policy conceals. No definer RPC and no service-role
client anywhere in the chain.

**The query still runs for a rep rather than being skipped on role**, and that
is deliberate: a role branch there is a copy of a policy in application code,
and if `audit_log` ever gains an own-row branch the feed should widen by itself
rather than keep showing nothing while nothing fails.

Four decisions worth knowing before changing any of it:

- **Quotes must NOT carry a byline.** `quotes.agent_id` is not whoever acted
  — it is the rep the proposal is FOR (an admin may make one on a rep's
  behalf), so printing it would attribute the act to the wrong person. The real actor is in `audit_log` and
  is therefore admin-only, which makes **no byline the honest rendering**.
  Notes, tasks and marketing events do carry theirs (`profile.id` is what the
  panels write).
- **Audit rows are matched on the `(table_name, row_id)` PAIR**, in one query
  per table. `row_id` is `text` and lead 7, quote 7 and pre-app 7 all plausibly
  exist, so a combined `.in("table_name", …).in("row_id", …)` would file one
  under another — and no policy would object, because an admin may read both.
  `leads`, `quotes` and `pre_apps` are covered; **`documents` is deliberately
  not** — its DELETE rows name a row that no longer exists, and since the table
  closed they are the purge's housekeeping, not a lead's story.
- **The ordering is a TOTAL order**, because exact ties are routine rather than
  freak: `created_at` defaults to `now()`, frozen for a whole transaction, so a
  quote and the audit row its own trigger writes tie to the microsecond. Rules
  are instant (parsed, **not** string-compared — a different offset is not a
  later time), then source rank with the audit *trace* after the act, then id
  descending. Without the tie-break the feed reshuffles when an unrelated
  source gains a row, since `Array.sort` is stable only against its input.
- **A task is placed at its CREATION**, which is why `tasks.created_at` joined
  `TASK_LIST_COLUMNS`. A due date is a plan, and dating the entry by it puts
  next Tuesday's task above everything that has actually happened. Completion
  is absent entirely: there is no `completed_at`, so there is no instant to
  place it at. And **`emailed` gets its own wording** — nothing in this
  codebase sends mail, and a row reading "Emailed" in a list of things that
  happened is how an admin comes to believe a proposal went out.

`e2e/lead-timeline.spec.ts` is where the scoping is actually checked, because
no RLS test can: it loads **one** lead in two real sessions and cross-reads
them, asserting the rep's four rows are *identical* to the admin's four rather
than merely fewer. "The admin sees more" is also true of a feed showing the two
roles unrelated things.
