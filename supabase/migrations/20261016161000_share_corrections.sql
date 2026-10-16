-- post_share_correction(), the two phase-5 preview flags, and the count of
-- adjustment rows a re-import ignored. Phase 5 of
-- docs/design/residual-splits.md.
--
-- Matches docs/tapswipe_crm_schema.sql, updated first; the block below is
-- copied from it verbatim.
--
-- =====================================================================
-- SHARE CORRECTIONS (20261016161000) — post_share_correction(), the two
-- phase-5 preview flags, and the count of adjustment rows a re-import
-- ignored. Phase 5 of docs/design/residual-splits.md, §6 and §7.
--
-- post_share_correction(merchant_id_input int, original_period_input date,
--                       partner_agent_id_input uuid,
--                       primary_rep_pct_input numeric,
--                       secondary_rep_pct_input numeric,
--                       note_input text) returns jsonb
--   {"posting_period": "YYYY-MM-DD", "amount": x,
--    "partner_line_id": n, "signer_line_id": m}
--
-- A SHARE AGREED AFTER ITS MONTH WAS COMMITTED. The month rule forbids
-- back-dating a share (design §3.5), so the money is moved instead, by an
-- adjustment PAIR posted in an open month. No committed line is edited.
--
--   1. The month being corrected must hold exactly one import line for the
--      merchant's MID -- the rep who was paid it, called the signer here --
--      and it must be an ordinary line (a shared month needs no correction)
--      whose payout is worked out: rep_payout NULL ("not worked out yet")
--      is refused, because there is nothing final to divide.
--   2. x = shared_part(T, secondary, primary + secondary), where T is that
--      line's rep_payout: the partner's part of T under exactly the cent rule
--      the shared lines use (design §4) -- the nearest cent, an exact
--      half-cent tie toward zero, odd in T, so a clawback month is shared in
--      the same ratio.
--   3. Two lines with line_kind 'adjustment', on the same MID, in the
--      POSTING MONTH: the partner's at +x and the signer's at -x, both with
--      adjusts_period = the corrected month and the admin's note.
--
--   THE PAIR NETS TO ZERO, so the company's 50% is untouched; the signer
--   keeps T - x and the partner receives x, across the two months, which is
--   exactly what the shared lines would have paid had the share existed
--   (signer T - x, partner x, summing to T). An x of $0.00 -- a T of zero,
--   or one too small to divide into a whole cent -- is refused: two
--   zero lines would record an agreement while moving nothing.
--
-- THE POSTING MONTH IS COMPUTED, NOT CHOSEN: the month after the latest
-- month holding ANY import line, across every MID. Payouts are paid per
-- month company-wide, so a month with any committed line counts as closed,
-- and an adjustment must never land in one. The caller does not pass it;
-- the function returns it. Posting again before the next month is
-- committed posts into the same month, which is fine: adjustment lines sit
-- outside the merge key (20261016160000). Once that month is committed the
-- adjustment is simply part of how it was paid.
--
-- Refused, by name (PT409 unless shown): a missing merchant or rep (PT404),
-- a merchant with no MID, a deactivated partner (as a new share would be,
-- design Q10), the partner being the signer (22023), no import line that
-- month (PT404), more than one, a shared month, a NULL payout, a zero x,
-- and a SECOND correction of the same MID and month -- a double click must
-- not pay twice, and the first correction is the record. Bad arguments are
-- 22023: any NULL, a blank note, a note over 500 characters, a month not on
-- the 1st, shares not each above 0 in hundredths summing to 50.
--
-- It does NOT create the share. Shares for future months are set the normal
-- way; the two calls are independent, and 20261016160000 made sure the
-- share RPCs do not mistake this function's lines for a committed month.
--
-- `security definer`: the ledger has no INSERT policy or grant, and
-- audit_log no INSERT for any client. Hand-written is_admin() guard as the
-- first statement, search_path pinned, and the share lock --
-- pg_advisory_xact_lock(hashtext('tapswipe.merchant_rep_shares')), which both
-- commits take -- so the "latest committed month" it reads cannot move under
-- it: a commit in flight is waited for, and its month is then closed. One
-- audit_log row, action 'post_share_correction', row_id the partner's line,
-- with no exception block: it FAILS CLOSED. No history row: history records
-- edits of the two typed figures, and an adjustment line has neither.
--
-- What reps see follows from RLS with no new policy: each rep reads their
-- own line of the pair, note included -- so the note is written for them.
--
-- PREVIEW FLAGS, two more (design §7; they widen the CHECK on
-- rep_payout_import_rows.preview_flag, and like the others never block):
--
--   share_not_in_force  a share exists on this MID's merchant but none covers
--                       the row's month (ended, or starts later). v2 imports
--                       the row as an ordinary line, paying the rep the file
--                       names the whole rep side -- silently, without this.
--   looks_shared        no share exists on the MID, and ANOTHER rep is paid
--                       on it within the six months before the row's month
--                       or in that month itself: a committed import line, or
--                       another row of this same file. Advisory and
--                       heuristic. The CRM owner (merchants.agent_id) is
--                       deliberately not a signal: it is often not the payee.
--
-- Precedence on a row, one flag at most: the three share flags first (a
-- share covers the month), then share_not_in_force, then looks_shared.
--
-- rep_payout_batches.adjustment_rows_ignored. The export marks adjustment
-- lines in a `Line` column, and parse-residual-import does NOT stage a row
-- marked `Adjustment`: re-imported, it would become an import line, or be
-- merged into one. The count is kept on the batch (written by the service
-- role; the authenticated UPDATE grant stops at status) so the review screen
-- can say "N adjustment lines ignored" after a reload.
-- =====================================================================

alter table rep_payout_import_rows
  drop constraint rep_payout_import_rows_preview_flag_check;

alter table rep_payout_import_rows
  add constraint rep_payout_import_rows_preview_flag_check check (
    preview_flag in ('share_not_applied', 'partner_named', 'line_not_shared',
                     'share_not_in_force', 'looks_shared')
  );

alter table rep_payout_batches
  add column adjustment_rows_ignored int not null default 0
    check (adjustment_rows_ignored >= 0);

create or replace function post_share_correction(
  merchant_id_input       int,
  original_period_input   date,
  partner_agent_id_input  uuid,
  primary_rep_pct_input   numeric,
  secondary_rep_pct_input numeric,
  note_input              text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  m           merchants;
  partner     profiles;
  signer      rep_payout_rows;
  note        text := btrim(note_input);
  lines       int;
  latest      date;
  posting     date;
  amount      numeric(14,2);
  partner_row int;
  signer_row  int;
begin
  if not is_admin() then
    raise exception 'admin only' using errcode = 'PT403';
  end if;

  perform pg_advisory_xact_lock(hashtext('tapswipe.merchant_rep_shares'));

  if merchant_id_input is null or original_period_input is null
     or partner_agent_id_input is null or primary_rep_pct_input is null
     or secondary_rep_pct_input is null or note_input is null then
    raise exception 'Every field is required to post a correction.'
      using errcode = '22023';
  end if;

  if note = '' then
    raise exception 'A correction needs a note saying what was agreed. Both reps see it on their statements.'
      using errcode = '22023';
  end if;

  if length(note) > 500 then
    raise exception 'The note can be at most 500 characters.'
      using errcode = '22023';
  end if;

  if extract(day from original_period_input) <> 1 then
    raise exception 'The month being corrected is given as its first day.'
      using errcode = '22023';
  end if;

  if primary_rep_pct_input <> round(primary_rep_pct_input, 2)
     or secondary_rep_pct_input <> round(secondary_rep_pct_input, 2)
     or primary_rep_pct_input <= 0 or secondary_rep_pct_input <= 0
     or primary_rep_pct_input + secondary_rep_pct_input <> 50 then
    raise exception 'The two shares must each be above 0, in hundredths at most, and add up to the rep side: 50.'
      using errcode = '22023';
  end if;

  select * into m from merchants where id = merchant_id_input;
  if not found then
    raise exception 'merchant not found' using errcode = 'PT404';
  end if;

  if m.mid is null or btrim(m.mid) = '' then
    raise exception 'This merchant has no MID, so it has no committed month to correct.'
      using errcode = 'PT409';
  end if;

  select * into partner from profiles where id = partner_agent_id_input;
  if not found then
    raise exception 'rep not found' using errcode = 'PT404';
  end if;

  if not partner.is_active then
    raise exception '% is deactivated, so a correction cannot name them.', partner.full_name
      using errcode = 'PT409';
  end if;

  select count(*) into lines
    from rep_payout_rows
   where period = original_period_input and mid = m.mid
     and line_kind = 'import';

  if lines = 0 then
    raise exception '% has no committed line for MID %, so there is nothing to correct.',
      to_char(original_period_input, 'FMMonth YYYY'), m.mid
      using errcode = 'PT404';
  end if;

  if lines > 1 then
    raise exception '% has % lines for MID %. A correction divides one rep''s month, so that month must have exactly one.',
      to_char(original_period_input, 'FMMonth YYYY'), lines, m.mid
      using errcode = 'PT409';
  end if;

  select * into signer
    from rep_payout_rows
   where period = original_period_input and mid = m.mid
     and line_kind = 'import'
   for update;

  if signer.share_role is not null then
    raise exception '% is already a shared month for MID %, so there is nothing to correct.',
      to_char(original_period_input, 'FMMonth YYYY'), m.mid
      using errcode = 'PT409';
  end if;

  if signer.agent_id = partner_agent_id_input then
    raise exception 'The partner must be a different rep from the one paid for that month.'
      using errcode = '22023';
  end if;

  if signer.rep_payout is null then
    raise exception 'The payout for % is not worked out yet: its residual or rate is blank. Fill it in first.',
      to_char(original_period_input, 'FMMonth YYYY')
      using errcode = 'PT409';
  end if;

  if exists (
    select 1 from rep_payout_rows
     where line_kind = 'adjustment' and mid = m.mid
       and adjusts_period = original_period_input
  ) then
    raise exception 'A correction for MID %, % has already been posted.',
      m.mid, to_char(original_period_input, 'FMMonth YYYY')
      using errcode = 'PT409';
  end if;

  amount := shared_part(signer.rep_payout, secondary_rep_pct_input,
                        primary_rep_pct_input + secondary_rep_pct_input);

  if amount = 0 then
    raise exception 'The partner''s share of that month rounds to $0.00, so there is nothing to move.'
      using errcode = 'PT409';
  end if;

  select max(period) into latest
    from rep_payout_rows
   where line_kind = 'import';

  posting := (latest + interval '1 month')::date;

  insert into rep_payout_rows (
    agent_id, period, mid, merchant_name, merchant_id,
    line_kind, adjustment_amount, adjusts_period, adjustment_note
  )
  values (
    partner_agent_id_input, posting, m.mid, signer.merchant_name, m.id,
    'adjustment', amount, original_period_input, note
  )
  returning id into partner_row;

  insert into rep_payout_rows (
    agent_id, period, mid, merchant_name, merchant_id,
    line_kind, adjustment_amount, adjusts_period, adjustment_note
  )
  values (
    signer.agent_id, posting, m.mid, signer.merchant_name, m.id,
    'adjustment', -amount, original_period_input, note
  )
  returning id into signer_row;

  insert into audit_log (actor_id, action, table_name, row_id)
  values (auth.uid(), 'post_share_correction', 'rep_payout_rows',
          partner_row::text);

  return jsonb_build_object(
    'posting_period', to_char(posting, 'YYYY-MM-DD'),
    'amount', amount,
    'partner_line_id', partner_row,
    'signer_line_id', signer_row
  );
end;
$$;

revoke all on function post_share_correction(int, date, uuid, numeric, numeric, text)
  from public;
grant execute on function post_share_correction(int, date, uuid, numeric, numeric, text)
  to authenticated, service_role;
