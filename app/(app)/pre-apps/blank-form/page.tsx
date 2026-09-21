import Link from "next/link";

import { PageShell } from "@/components/page-shell";
import { PrintButton } from "@/components/print-button";
import { PrintLetterhead } from "@/components/print-letterhead";
import {
  BUSINESS_SECTION,
  OWNER_SECTION,
  OWNER_SSN_FIELD,
  PAPER_COMPLETENESS_CHECKLIST,
  PAPER_OWNER_BLOCKS,
  PROFILE_SECTION,
  SECRET_FIELDS,
  TERMINAL_SECTION,
  type PaperFieldEntry,
  type PaperGroup,
  type PaperSection,
} from "@/lib/pre-app-form-fields";

/**
 * The merchant application, blank, to be printed and filled in by hand.
 *
 * For a merchant with no computer: they write it out, the rep keys it into the
 * wizard afterwards. That only works if the paper asks for exactly what the
 * wizard asks for, which is why every field here comes from
 * lib/pre-app-form-fields.ts rather than from a hand-written list — see the note
 * there for how a new column becomes a build error instead of a silent gap.
 *
 * Deliberately NOT a form. There is not one `input`, `select` or `textarea` on
 * the page: fields print as a label above a ruled box, because the thing being
 * produced is paper. That also keeps the route free of client JS, of autosave,
 * and of any path that could submit a half-filled application by accident.
 *
 * It needs no data, so it is fully static — no `requireUser()`, no Suspense
 * boundary, nothing for cacheComponents to object to. It still lives inside the
 * (app) route group, which costs nothing on paper: the sidebar, topbar and
 * bug-report bubble each carry their own `print:hidden`, so the chrome takes
 * itself off the page.
 */
export default function BlankFormPage() {
  return (
    <PageShell width="detail">
      {/* The screen-only control row, exactly as the payout summary does it. */}
      <div className="flex items-start justify-between gap-4 print:hidden">
        <div>
          <h1 className="text-[22px] font-bold leading-tight tracking-tight">
            Blank application
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Print this for a merchant to fill in by hand, then enter it as a
            pre-app afterwards.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Link
            href="/pre-apps"
            className="text-sm text-primary underline-offset-4 hover:underline"
          >
            Back to pre-apps
          </Link>
          <PrintButton />
        </div>
      </div>

      <article className="flex flex-col gap-6 rounded-xl border bg-card p-6 print:rounded-none print:border-0 print:p-0">
        <header className="border-b pb-4">
          <PrintLetterhead />
          <h2 className="text-xl font-bold tracking-tight">
            Merchant application
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Please complete in ink. Leave blank anything that does not apply —
            the checklist on the last page shows what has to be filled in before
            the application can be submitted.
          </p>
          <div className="mt-4 grid grid-cols-2 gap-4">
            <RuledBox label="Representative" />
            <RuledBox label="Date" hint="MM/DD/YYYY" />
          </div>
        </header>

        <Section section={BUSINESS_SECTION} />

        {/* Owners are unbounded in the schema; paper commits to a number. */}
        {Array.from({ length: PAPER_OWNER_BLOCKS }, (_, index) => (
          <OwnerBlock key={index} ordinal={index + 1} />
        ))}

        <p className="text-xs text-muted-foreground">
          Attach a further sheet for any additional owners. At least one owner
          must hold 51% or more.
        </p>

        <Section section={TERMINAL_SECTION} />
        <Section section={PROFILE_SECTION} />

        <SensitiveSection />

        <section className="break-inside-avoid border-t pt-4">
          <h3 className="text-base font-bold tracking-tight">
            Before this can be submitted
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            Everything below is checked again when the application is entered.
          </p>
          <ul className="mt-3 flex flex-col gap-1.5">
            {PAPER_COMPLETENESS_CHECKLIST.map((item) => (
              <li key={item} className="flex items-start gap-2 text-sm">
                <Tick />
                <span>{item}</span>
              </li>
            ))}
          </ul>
        </section>
      </article>
    </PageShell>
  );
}

/** One step of the wizard, as a printed section with its fieldset groups. */
function Section({ section }: { section: PaperSection }) {
  return (
    <section className="flex flex-col gap-4">
      <h3 className="border-b pb-1 text-base font-bold tracking-tight">
        {section.title}
      </h3>
      {section.groups.map((group) => (
        <Group key={group.title} group={group} />
      ))}
    </section>
  );
}

function Group({ group }: { group: PaperGroup }) {
  const ticks = group.fields.every((field) => field.kind === "checkbox");

  return (
    // break-inside-avoid so a group's heading never prints alone at the foot of
    // a sheet with its fields overleaf.
    <div className="break-inside-avoid">
      <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {group.title}
      </h4>
      <div
        className={
          ticks
            ? "mt-2 grid grid-cols-2 gap-x-6 gap-y-1.5"
            : "mt-2 grid grid-cols-2 gap-x-6 gap-y-3"
        }
      >
        {group.fields.map((field) => (
          <Field key={field.key} field={field} />
        ))}
      </div>
    </div>
  );
}

/**
 * One field, sized by what it holds.
 *
 * `long` and `select` span both columns — prose needs the width, and a row of
 * tick boxes wraps badly in half of one.
 */
function Field({ field }: { field: PaperFieldEntry }) {
  if (field.kind === "checkbox") {
    return (
      <label className="flex items-center gap-2 text-sm">
        <Tick />
        {field.label}
      </label>
    );
  }

  if (field.kind === "select") {
    return (
      <div className="col-span-2">
        <FieldLabel field={field} />
        <div className="mt-1 flex flex-wrap items-center gap-x-5 gap-y-1.5">
          {(field.options ?? []).map((option) => (
            <span key={option} className="flex items-center gap-2 text-sm">
              <Tick />
              {option}
            </span>
          ))}
          <span className="flex flex-1 items-center gap-2 text-sm">
            <Tick />
            <span className="whitespace-nowrap">Other</span>
            <span className="h-5 min-w-24 flex-1 border-b border-foreground/40" />
          </span>
        </div>
      </div>
    );
  }

  const tall = field.kind === "long";

  return (
    <div className={tall ? "col-span-2" : undefined}>
      <RuledBox
        label={field.label}
        hint={field.kind === "state" ? "two-letter code" : field.hint}
        required={field.required}
        tall={tall}
      />
    </div>
  );
}

function FieldLabel({ field }: { field: PaperFieldEntry }) {
  return (
    <span className="text-xs font-medium">
      {field.label}
      {field.required === true && (
        <span className="text-destructive" aria-hidden>
          {" *"}
        </span>
      )}
      {field.hint !== undefined && (
        <span className="font-normal text-muted-foreground">
          {" "}
          ({field.hint})
        </span>
      )}
    </span>
  );
}

/**
 * A label over a writing space.
 *
 * A bordered box rather than a bare underline: on a photocopy an underline is
 * easy to mistake for a rule in the layout, and a box tells the person filling
 * it in how much room they have.
 */
function RuledBox({
  label,
  hint,
  required,
  tall,
}: {
  label: string;
  hint?: string;
  required?: boolean;
  tall?: boolean;
}) {
  return (
    <div className="break-inside-avoid">
      <FieldLabel
        field={{ key: label, label, hint, required, kind: "text", group: "" }}
      />
      <div
        className={`mt-1 w-full rounded border border-foreground/40 ${
          tall === true ? "h-14" : "h-8"
        }`}
      />
    </div>
  );
}

/** An empty square to tick. Decorative — the label beside it carries meaning. */
function Tick() {
  return (
    <span
      className="mt-0.5 inline-block h-3.5 w-3.5 shrink-0 rounded-[2px] border border-foreground/50"
      aria-hidden
    />
  );
}

/**
 * One owner, with that owner's SSN attached.
 *
 * The SSN prints here rather than in the sensitive section below because it
 * belongs to a specific person — the schema stores it against
 * `pre_app_owners.id`, and a sheet listing three SSNs away from three names is
 * how they get transcribed onto the wrong owner.
 */
function OwnerBlock({ ordinal }: { ordinal: number }) {
  return (
    <section className="flex flex-col gap-4">
      <h3 className="border-b pb-1 text-base font-bold tracking-tight">
        Owner {ordinal}
      </h3>
      {OWNER_SECTION.groups.map((group) => (
        <Group key={group.title} group={group} />
      ))}
      <div className="break-inside-avoid">
        <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Sensitive
        </h4>
        <div className="mt-2 grid grid-cols-2 gap-x-6">
          <RuledBox
            label={OWNER_SSN_FIELD.label}
            hint={OWNER_SSN_FIELD.hint}
          />
        </div>
      </div>
    </section>
  );
}

/**
 * Banking and the terminal password.
 *
 * Separated from the rest the way the schema separates them — these three
 * values live in their own tables, encrypted, and are the only part of this
 * form that is not ordinary business information.
 */
function SensitiveSection() {
  const banking = SECRET_FIELDS.filter((field) => field.group === "Banking");
  const terminal = SECRET_FIELDS.filter((field) => field.group === "Terminal");

  return (
    <section className="flex flex-col gap-4 break-inside-avoid">
      <h3 className="border-b pb-1 text-base font-bold tracking-tight">
        Sensitive data
      </h3>
      <p className="text-xs text-muted-foreground">
        These values are encrypted once entered and are stored separately from
        the rest of the application. Keep this sheet secure until it has been
        entered, then dispose of it appropriately.
      </p>

      <div className="break-inside-avoid">
        <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Banking
        </h4>
        <div className="mt-2 grid grid-cols-2 gap-x-6 gap-y-3">
          {banking.map((field) => (
            <RuledBox key={field.key} label={field.label} hint={field.hint} />
          ))}
        </div>
        <p className="mt-2 text-xs text-muted-foreground">
          Enter both — the routing and account numbers are stored as a pair, and
          one without the other cannot be submitted.
        </p>
      </div>

      <div className="break-inside-avoid">
        <h4 className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          Terminal
        </h4>
        <div className="mt-2 grid grid-cols-2 gap-x-6 gap-y-3">
          {terminal.map((field) => (
            <RuledBox key={field.key} label={field.label} hint={field.hint} />
          ))}
        </div>
      </div>
    </section>
  );
}
