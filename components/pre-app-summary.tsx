import {
  type PreApp,
  type PreAppBusinessProfile,
  type PreAppOwner,
  type PreAppTerminal,
} from "@/lib/pre-apps";
import { TERMINAL_BOOLEANS } from "@/lib/pre-app-validation";
import {
  formatClockTime,
  formatDate,
  formatPct,
  formatText,
} from "@/lib/format";

/**
 * The read-only view of one pre-app, shared by two callers.
 *
 * It exists because those two disagreed. `/pre-apps/[id]` rendered Business,
 * Owners and Card mix; the wizard's review step rendered a blocker checklist and
 * nothing else, under a subtitle promising "everything below". So a rep could
 * only see what they were submitting *after* they had submitted it, and the
 * terminal section — every column of `pre_app_terminal` — was displayed nowhere
 * at all, including to the admin deciding whether to approve it.
 *
 * Presentational only: no data access, no "use client", pure props. That is what
 * lets the server detail page and the client review step share one component,
 * and it is why adding a field here cannot make the two drift again.
 *
 * `agentName` is omitted rather than null by callers who have no business
 * showing it — the wizard has no reason to, and a rep would only ever see their
 * own name.
 */
export function PreAppSummary({
  preApp,
  owners,
  terminal,
  cardMix,
  agentName,
}: {
  preApp: PreApp;
  owners: PreAppOwner[];
  terminal: PreAppTerminal | null;
  cardMix: PreAppBusinessProfile | null;
  agentName?: string | null;
}) {
  return (
    <>
      <Section title="Business">
        <Field label="DBA">{preApp.dba_name}</Field>
        <Field label="Legal name">
          {formatText(preApp.legal_business_name)}
        </Field>
        <Field label="Contact">{formatText(preApp.contact_name)}</Field>
        <Field label="Contact phone">{formatText(preApp.contact_phone)}</Field>
        <Field label="Business phone">{formatText(preApp.phone_number)}</Field>
        <Field label="Email">{formatText(preApp.email_address)}</Field>
        <Field label="Address">{formatText(preApp.physical_address)}</Field>
        <Field label="City">{formatText(preApp.city)}</Field>
        <Field label="State">{formatText(preApp.state)}</Field>
        <Field label="ZIP">{formatText(preApp.zip)}</Field>
        <Field label="Website">{formatText(preApp.website)}</Field>
        <Field label="Entity type">{formatText(preApp.legal_entity_type)}</Field>
        <Field label="EIN">{formatText(preApp.ein_number)}</Field>
        <Field label="Started">{formatDate(preApp.business_start_date)}</Field>
        <Field label="Goods sold">{formatText(preApp.goods_sold)}</Field>
        <Field label="Bank">{formatText(preApp.bank_name)}</Field>
        <Field label="Billing">{formatText(preApp.billing_type)}</Field>
        <Field label="Split (agent / company)">
          {formatPct(preApp.split_agent_pct)} /{" "}
          {formatPct(preApp.split_company_pct)}
        </Field>
        {agentName && <Field label="Agent">{formatText(agentName)}</Field>}
      </Section>

      <div className="flex flex-col gap-4">
        <h2 className="font-semibold text-lg">Owners ({owners.length})</h2>
        {owners.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No owners recorded yet. At least one owner holding 51% or more is
            required before this can be submitted.
          </p>
        ) : (
          <div className="flex flex-col gap-6">
            {owners.map((owner) => (
              <dl
                key={owner.id}
                className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3"
              >
                <Field label="Name">{formatText(owner.owner_name)}</Field>
                <Field label="Title">{formatText(owner.title)}</Field>
                <Field label="Ownership">
                  {formatPct(owner.percent_owned)}
                </Field>
                <Field label="Home phone">{formatText(owner.home_phone)}</Field>
                <Field label="Date of birth">{formatDate(owner.dob)}</Field>
                <Field label="Home state">{formatText(owner.home_state)}</Field>
              </dl>
            ))}
          </div>
        )}
      </div>

      <TerminalSection terminal={terminal} />

      <Section title="Card mix">
        <Field label="Swiped">{formatPct(cardMix?.card_swiped_pct)}</Field>
        <Field label="Keyed">{formatPct(cardMix?.card_keyed_pct)}</Field>
        <Field label="Card present">
          {formatPct(cardMix?.card_present_pct)}
        </Field>
        <Field label="Card not present">
          {formatPct(cardMix?.card_not_present_pct)}
        </Field>
        <Field label="MOTO">{formatPct(cardMix?.moto_pct)}</Field>
        <Field label="Internet">{formatPct(cardMix?.internet_pct)}</Field>
      </Section>
    </>
  );
}

/**
 * The eleven booleans are listed as the options that ARE set, not as eleven
 * rows of "No". A terminal order is read as "what did they ask for", and a wall
 * of negatives buries the two or three answers that matter.
 *
 * Labels come from TERMINAL_BOOLEANS, the same array the form renders, so a
 * wording change moves both at once.
 */
function TerminalSection({ terminal }: { terminal: PreAppTerminal | null }) {
  const selected = terminal
    ? TERMINAL_BOOLEANS.filter(([key]) => terminal[key]).map(
        ([, label]) => label,
      )
    : [];

  return (
    <div className="flex flex-col gap-4">
      <h2 className="font-semibold text-lg">Terminal</h2>

      {terminal === null ? (
        <p className="text-sm text-muted-foreground">
          No terminal details recorded yet.
        </p>
      ) : (
        <>
          <dl className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
            <Field label="Terminal type">
              {formatText(terminal.terminal_type)}
            </Field>
            <Field label="Communication">
              {formatText(terminal.communication_method)}
            </Field>
            <Field label="Batch-out time">
              {formatClockTime(terminal.batch_out_time)}
            </Field>
            <Field label="Tax rate">{formatPct(terminal.tax_rate)}</Field>
            <Field label="FNS number">{formatText(terminal.fns_number)}</Field>
            <Field label="Software / version">
              {formatText(terminal.software_name_version)}
            </Field>
            <Field label="Refund policy">
              {formatText(terminal.refund_policy)}
            </Field>
            <Field label="Receipt header">
              {formatText(terminal.receipt_header_message)}
            </Field>
            <Field label="Receipt footer">
              {formatText(terminal.receipt_footer_message)}
            </Field>
            <Field label="Pricing provided">
              {formatText(terminal.pricing_provided)}
            </Field>
            <Field label="Statement analysis">
              {formatText(terminal.statement_analysis)}
            </Field>
            <Field label="MP/AP name">{formatText(terminal.mp_ap_name)}</Field>
            <Field label="RP name">{formatText(terminal.rp_name)}</Field>
          </dl>

          <div className="flex flex-col gap-1">
            <p className="text-xs uppercase tracking-wide text-muted-foreground">
              Options
            </p>
            {selected.length === 0 ? (
              <p className="text-sm text-muted-foreground">None selected.</p>
            ) : (
              <ul className="flex flex-wrap gap-x-6 gap-y-1">
                {selected.map((label) => (
                  <li key={label} className="text-sm">
                    {label}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </>
      )}
    </div>
  );
}

function Field({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">
        {label}
      </dt>
      <dd className="text-sm">{children}</dd>
    </div>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-4">
      <h2 className="font-semibold text-lg">{title}</h2>
      <dl className="grid gap-6 sm:grid-cols-2 lg:grid-cols-3">{children}</dl>
    </div>
  );
}
