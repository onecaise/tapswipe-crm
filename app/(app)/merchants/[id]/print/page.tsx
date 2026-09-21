import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";

import { PageShell } from "@/components/page-shell";
import { PrintButton } from "@/components/print-button";
import { PrintLetterhead } from "@/components/print-letterhead";
import { formatDate, formatPct, formatText } from "@/lib/format";
import { loadAnnotations } from "@/lib/annotations-data";
import { taskIsOverdue } from "@/lib/annotations";
import { DOCUMENT_LIST_COLUMNS, type DocumentRow } from "@/lib/documents";
import { requireUser } from "@/lib/auth";
import { createClient } from "@/lib/supabase/server";
import { type Merchant } from "@/lib/merchants";

/**
 * One merchant's record, laid out to be printed or filed.
 *
 * Its own route rather than print CSS on /merchants/[id], following the payout
 * summary. The detail page's Notes, Tasks and Documents panels are interactive
 * components — textareas, remove buttons, confirm pairs — so printing it in
 * place would mean putting `print:` classes inside those shared panels, which
 * would quietly change printing on leads, pre-apps and support tickets too.
 *
 * Nothing sensitive is on this page, and that is a property of the schema
 * rather than of this file being careful: `merchants` has fourteen columns and
 * not one of them is an SSN, a routing number or an account number.
 * `approve_pre_app` copies seven non-sensitive columns out of a pre-app and
 * never reads a secrets table. So there is nothing here to redact, and
 * read-pre-app-secrets is deliberately not called — wiring it in would add a
 * decryption surface, and an audit_log row, to a page built to be photocopied.
 *
 * Documents are listed by NAME only. The bytes live in a private bucket behind
 * a signed URL, and a filename is metadata the rep can already see.
 */
export default function MerchantPrintPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return (
    <PageShell width="detail">
      <Suspense
        fallback={
          <p className="text-sm text-muted-foreground">Loading merchant…</p>
        }
      >
        <MerchantPrint params={params} />
      </Suspense>
    </PageShell>
  );
}

async function MerchantPrint({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const profile = await requireUser();
  const supabase = await createClient();

  const merchantId = Number(id);
  if (!Number.isInteger(merchantId)) {
    notFound();
  }

  const { data, error } = await supabase
    .from("merchants")
    .select("*")
    .eq("id", merchantId)
    .maybeSingle();

  // The same 404 the detail page gives, and for the same reason: a merchant
  // that does not exist and one belonging to another agent are both zero rows
  // under RLS, and telling them apart would make this URL an id oracle.
  if (error || !data) {
    notFound();
  }

  const merchant = data as Merchant;

  let agentName: string | null = null;
  if (profile.role === "admin") {
    const { data: agent } = await supabase
      .from("profiles")
      .select("full_name")
      .eq("id", merchant.agent_id)
      .maybeSingle();
    agentName = (agent?.full_name as string | undefined) ?? null;
  }

  const { data: docs } = await supabase
    .from("documents")
    .select(DOCUMENT_LIST_COLUMNS)
    .eq("owner_type", "merchant")
    .eq("owner_id", merchant.id)
    .order("uploaded_at", { ascending: false });
  const documents = (docs ?? []) as DocumentRow[];

  // owner_type is a literal, never from the URL — owner_id has no foreign key,
  // so a mismatched pair is not something the database would catch.
  const { notes, tasks } = await loadAnnotations("merchant", merchant.id);

  return (
    <>
      <div className="flex items-start justify-between gap-4 print:hidden">
        <div>
          <h1 className="text-[22px] font-bold leading-tight tracking-tight">
            {merchant.dba}
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            The full record, laid out for printing.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Link
            href={`/merchants/${merchant.id}`}
            className="text-sm text-primary underline-offset-4 hover:underline"
          >
            Back to merchant
          </Link>
          <PrintButton />
        </div>
      </div>

      <article className="flex flex-col gap-6 rounded-xl border bg-card p-6 print:rounded-none print:border-0 print:p-0">
        <header className="border-b pb-4">
          <PrintLetterhead />
          <h2 className="text-xl font-bold tracking-tight">{merchant.dba}</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Merchant record
            {merchant.mid !== null && merchant.mid !== ""
              ? ` · MID ${merchant.mid}`
              : ""}
          </p>
        </header>

        {/* The same nine fields the detail page shows, through the same
            formatters, so a printed value never disagrees with the screen. */}
        <dl className="grid grid-cols-2 gap-x-8 gap-y-3">
          <Row label="Legal business name">
            {formatText(merchant.legal_business_name)}
          </Row>
          <Row label="MID">{formatText(merchant.mid)}</Row>
          <Row label="Status">{formatText(merchant.status)}</Row>
          <Row label="Processor">{formatText(merchant.processor)}</Row>
          <Row label="Agent split">{formatPct(merchant.split_agent_pct)}</Row>
          <Row label="Company split">
            {formatPct(merchant.split_company_pct)}
          </Row>
          <Row label="Date added">{formatDate(merchant.date_added)}</Row>
          {agentName !== null && <Row label="Agent">{agentName}</Row>}
          <Row label="Last updated">{formatDate(merchant.updated_at)}</Row>
          {merchant.pre_app_id !== null && (
            <Row label="Approved from">Pre-app #{merchant.pre_app_id}</Row>
          )}
        </dl>

        <Block title="Tasks" count={tasks.length}>
          {tasks.map((task) => (
            <li key={task.id} className="break-inside-avoid py-1.5 text-sm">
              <span className="font-medium">{task.title}</span>
              <span className="text-muted-foreground">
                {" — "}
                {task.completed
                  ? "completed"
                  : taskIsOverdue(task)
                    ? `due ${formatDate(task.due_date)}, overdue`
                    : task.due_date !== null
                      ? `due ${formatDate(task.due_date)}`
                      : "open"}
                {task.author_name !== null ? ` · ${task.author_name}` : ""}
              </span>
            </li>
          ))}
        </Block>

        <Block title="Notes" count={notes.length}>
          {notes.map((note) => (
            <li key={note.id} className="break-inside-avoid py-1.5 text-sm">
              <span className="text-[11px] uppercase tracking-wide text-muted-foreground">
                {formatDate(note.created_at)}
                {note.author_name !== null ? ` · ${note.author_name}` : ""}
              </span>
              {/* whitespace-pre-wrap: a note is typed prose and its line breaks
                  are part of what someone wrote. */}
              <span className="block whitespace-pre-wrap">{note.body}</span>
            </li>
          ))}
        </Block>

        <Block title="Documents" count={documents.length}>
          {documents.map((doc) => (
            <li key={doc.id} className="break-inside-avoid py-1.5 text-sm">
              <span className="font-medium">
                {formatText(doc.file_name)}
              </span>
              <span className="text-muted-foreground">
                {" — "}
                {formatText(doc.doc_type)} · uploaded{" "}
                {formatDate(doc.uploaded_at)}
              </span>
            </li>
          ))}
        </Block>
      </article>
    </>
  );
}

function Row({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="break-inside-avoid">
      <dt className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

/**
 * A titled list, or an explicit "none" line.
 *
 * The empty case is printed rather than skipped: on paper, a missing section is
 * indistinguishable from a section someone forgot to include, and "No notes."
 * is the answer a reader actually needs.
 */
function Block({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h3 className="border-b pb-1 text-base font-bold tracking-tight">
        {title}
        {count > 0 && (
          <span className="font-normal text-muted-foreground"> ({count})</span>
        )}
      </h3>
      {count === 0 ? (
        <p className="pt-2 text-sm text-muted-foreground">
          No {title.toLowerCase()}.
        </p>
      ) : (
        <ul className="divide-y pt-1">{children}</ul>
      )}
    </section>
  );
}
