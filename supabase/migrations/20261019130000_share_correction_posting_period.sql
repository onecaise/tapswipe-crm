-- share_correction_posting_period(), and post_share_correction() refusing a
-- posting month the admin did not confirm. Phase 6 of
-- docs/design/residual-splits.md (§6).
--
-- Matches docs/tapswipe_crm_schema.sql, updated first; the block below is
-- copied from it verbatim.

-- =====================================================================
-- SHARE CORRECTION POSTING MONTH (20261019130000) — what the admin is
-- shown before a correction is posted, and the guarantee that it is where
-- the correction lands. Phase 6 of docs/design/residual-splits.md, §6.
--
-- share_correction_posting_period() returns date
--   The month post_share_correction() would post into right now: the month
--   after the latest month holding ANY import line, across every MID (the
--   rule 20261016161000 set and Owen confirmed on 16 Oct 2026). NULL when the
--   ledger holds no import line at all -- and then there is nothing to
--   correct either. Read-only, `stable`, `security definer` with a
--   hand-written is_admin() guard first (an agent asking would get an
--   answer computed from their own rows under invoker, which is a different
--   and wrong month) and search_path pinned. Not audited: it writes nothing.
--
-- THE RULE EXISTS ONCE. post_share_correction() is re-created to CALL this
-- function instead of computing the month itself, so the preview and the
-- post cannot drift apart: there is no second copy of the rule to update.
--
-- post_share_correction(..., expected_posting_period_input date default null)
--   gains one optional argument: the month the admin confirmed. When given
--   and it no longer matches -- a residual import committed a later month
--   between the preview and the click -- the correction is REFUSED (PT409)
--   rather than posted into a month nobody confirmed. NULL keeps the old
--   behaviour, so a caller passing the original six arguments by name is
--   unaffected.
--
-- The six-argument signature is DROPPED, not left beside the new one: with a
-- default on the seventh, a six-argument call would otherwise have two
-- candidates -- an ambiguity Postgres reports at call time, from the
-- browser (the dashboard_counts() and create_quote_version() trap; same
-- answer, same name-resolves-once assertion). Privilege lines are restated
-- for the new signature. Everything else in the body is unchanged,
-- including the second-correction refusal ("A correction for MID %, % has
-- already been posted."), which the merchant page shows verbatim.
-- =====================================================================

create or replace function share_correction_posting_period()
returns date
language plpgsql
stable
security definer
set search_path = public
as $$
begin
  if not is_admin() then
    raise exception 'admin only' using errcode = 'PT403';
  end if;

  return (select (max(period) + interval '1 month')::date
            from rep_payout_rows
           where line_kind = 'import');
end;
$$;

revoke all on function share_correction_posting_period() from public;
grant execute on function share_correction_posting_period()
  to authenticated, service_role;

drop function post_share_correction(int, date, uuid, numeric, numeric, text);

create or replace function post_share_correction(
  merchant_id_input       int,
  original_period_input   date,
  partner_agent_id_input  uuid,
  primary_rep_pct_input   numeric,
  secondary_rep_pct_input numeric,
  note_input              text,
  expected_posting_period_input date default null
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

  -- The one rule for the posting month, shared with the admin's preview.
  posting := share_correction_posting_period();

  -- What the admin confirmed. A commit landing between the preview and this
  -- call would otherwise post into a different month than the one shown.
  if expected_posting_period_input is not null
     and expected_posting_period_input is distinct from posting then
    raise exception 'A month was committed after this correction was reviewed, so it would now post to %, not %. Review it again.',
      to_char(posting, 'FMMonth YYYY'),
      to_char(expected_posting_period_input, 'FMMonth YYYY')
      using errcode = 'PT409';
  end if;

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

revoke all on function post_share_correction(int, date, uuid, numeric, numeric, text, date)
  from public;
grant execute on function post_share_correction(int, date, uuid, numeric, numeric, text, date)
  to authenticated, service_role;
