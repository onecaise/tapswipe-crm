// Parses a batch's uploaded XLSX into rep_payout_import_rows.
//
// verify_jwt = false in config.toml, so this function authenticates the caller
// itself. Admin-only, and the order is the house order: authenticated, active
// profile, admin, and only then the service-role client.
//
// IDEMPOTENT ON PURPOSE. Re-parsing deletes the batch's existing staging rows
// first, so "add the merchant, then Read again" is an ordinary action rather
// than a duplicate import. That is the whole mechanism behind the review
// screen's Read again button: there is one code path into staging, and a fix
// simply runs it again with one more merchant in the database.
//
// THE FILE AND THE PAYEE (phase 7 of docs/design/intake-and-reports.md). The
// file has six columns (Processor, Merchant Number, Merchant Name, Income Type,
// Volume, Residual); the month and processor are the BATCH's, chosen at upload.
// Each row's payee is the owner of the merchant its Merchant Number names.
// Agent # is not read: profiles.agent_number is a display code only.
//
// SheetJS is imported here rather than in _shared/, because a _shared module with
// a dependency would need an import map of its own. All the parsing JUDGEMENT is
// in _shared/residuals.ts, which stays dependency-free and is unit-tested under
// vitest without Deno; this file only turns bytes into rows of cells and does the
// database lookups the parser cannot.

import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";
import * as XLSX from "xlsx";

import {
  callerIsActive,
  callerIsAdmin,
  json,
} from "../_shared/admin-users.ts";
import {
  RESIDUAL_BUCKET,
  isPositiveInt,
} from "../_shared/residual-imports.ts";
import {
  blockerMessage,
  isSpreadsheetContainer,
  midKey,
  midsInOtherBatches,
  monthsBefore,
  orderBlockers,
  parseResidualSheet,
  payeeChangedNote,
  previewUnsharedRow,
  previousPayees,
  rowWarnings,
  unsharedPreviewNote,
  type LastMonthLine,
  type MerchantByMid,
  type MonthLine,
  type PreviewShare,
  type ResidualBlocker,
} from "../_shared/residuals.ts";

/** PostgREST caps a response at [api] max_rows; read in pages under that. */
const PAGE_SIZE = 500;

/** PostgREST's `in` filter goes in the URL; keep each list well under its limit. */
const IN_CHUNK = 200;

function chunks<T>(items: readonly T[], size = IN_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

export default {
  fetch: withSupabase({ auth: "user" }, async (req, ctx) => {
    if (req.method !== "POST") {
      return json({ error: "Method not allowed" }, 405);
    }

    const userId = ctx.userClaims?.id;
    if (!userId) {
      return json({ error: "Not authenticated" }, 401);
    }

    if (!(await callerIsActive(ctx.supabase))) {
      return json({ error: "Account is not active" }, 403);
    }
    if (!(await callerIsAdmin(ctx.supabase))) {
      return json({ error: "Admin only" }, 403);
    }

    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return json({ error: "Body must be JSON" }, 400);
    }

    if (!isPositiveInt(body.batch_id)) {
      return json({ error: "batch_id must be a positive integer" }, 400);
    }
    const batchId = body.batch_id;

    // Through the caller-scoped client, so RLS decides visibility and a missing
    // batch is indistinguishable from one that is not the caller's.
    const { data: batch, error: batchError } = await ctx.supabase
      .from("rep_payout_batches")
      .select("id, file_key, status, processor, period")
      .eq("id", batchId)
      .maybeSingle();

    if (batchError) {
      return json(
        { error: `Could not read the batch: ${batchError.message}` },
        500,
      );
    }
    if (!batch) {
      return json({ error: "Batch not found" }, 404);
    }
    if (batch.status !== "review") {
      // Re-parsing a committed batch would rebuild staging rows for a period that
      // has already landed, and the next commit would import it twice.
      return json(
        { error: `This batch is ${String(batch.status)} and cannot be parsed` },
        409,
      );
    }
    if (batch.processor === null || batch.period === null) {
      // A batch started before the upload page asked for them
      // (20261030140000). Its month and processor are not in the file any
      // more, so there is nothing to read it against.
      return json(
        {
          error:
            "This import was started before the processor and month were chosen at upload, so it cannot be read again. Abandon it and upload the file again.",
        },
        409,
      );
    }
    const batchProcessor = batch.processor as string;
    const batchPeriod = batch.period as string;

    // ---- Read the file -------------------------------------------------
    const { data: blob, error: downloadError } = await ctx.supabaseAdmin.storage
      .from(RESIDUAL_BUCKET)
      .download(batch.file_key as string);

    if (downloadError || !blob) {
      return json(
        {
          error:
            "That batch has no uploaded file yet. Upload one, or abandon the batch.",
        },
        404,
      );
    }

    let sheet: unknown[][];
    let formatted: unknown[][];
    // A CSV: SheetJS keeps each cell's own text in `w`, so a long or
    // lettered Merchant Number is read as written (parseMidCell).
    let textFile = false;
    try {
      const bytes = new Uint8Array(await blob.arrayBuffer());
      textFile = !isSpreadsheetContainer(bytes);
      const workbook = XLSX.read(bytes, { type: "array" });

      const first = workbook.SheetNames[0];
      if (first === undefined) {
        return json({ error: "That file has no sheets." }, 400);
      }

      // Only the first sheet. A residual report is one table; picking a sheet by
      // guessing would make which numbers got imported depend on tab order.
      const options = {
        // Arrays of cells rather than objects keyed by header, so
        // _shared/residuals.ts owns the header mapping and can report exactly
        // which column is missing.
        header: 1 as const,
        // A gap inside a sheet must not shift every row number after it, which is
        // what an admin counts when told "row 22".
        defval: null,
        blankrows: true,
      };
      // Twice: the values (a number stays a number, for the figures) and the
      // displayed text, which is the only place a stored-as-number Merchant
      // Number keeps its leading zeros (parseMidCell).
      sheet = XLSX.utils.sheet_to_json(workbook.Sheets[first], {
        ...options,
        raw: true,
      }) as unknown[][];
      formatted = XLSX.utils.sheet_to_json(workbook.Sheets[first], {
        ...options,
        raw: false,
      }) as unknown[][];
    } catch (error) {
      // A .csv renamed to .xlsx, a corrupt upload, a password-protected workbook.
      // Reported rather than thrown, so the review screen can say so.
      return json(
        {
          error: `That file could not be read as a spreadsheet: ${
            error instanceof Error ? error.message : "unknown error"
          }`,
        },
        400,
      );
    }

    const parsed = parseResidualSheet(sheet, formatted, { textFile });
    if (!parsed.ok) {
      return json({ error: parsed.error }, 400);
    }

    // ---- The lookups ---------------------------------------------------
    //
    // Through the ADMIN client, and this is the one place in the module that
    // reaches for it before authorization is "complete" in the usual sense.
    // Justified narrowly: the caller is already a verified active admin, checked
    // above through the caller-scoped client, and an admin may read every
    // merchants, ledger, share and profiles row anyway. So the admin client buys
    // only fewer round trips. It must not be used to DECIDE anything, and it is
    // not -- nothing below branches on privilege.
    const mids = [
      ...new Set(
        parsed.rows
          .filter((row) => !row.blockers.includes("missing_mid"))
          .map((row) => row.mid_raw)
          .filter((value): value is string => value !== null),
      ),
    ];

    // The payee lookup: MID -> merchant -> owner (memo §2.1, "kept and
    // widened"). Case-insensitive (20261106140000): `ilike` with no wildcard
    // is equality ignoring case, and a MID here is letters and digits only
    // (parseMidCell), so nothing in it is a pattern. merchants is unique on
    // mid_key(), so a key finds at most one; the map is keyed by midKey().
    const merchants = new Map<string, MerchantByMid>();
    for (const part of chunks(mids)) {
      const { data, error } = await ctx.supabaseAdmin
        .from("merchants")
        .select("id, mid, agent_id, status, processor")
        .ilikeAnyOf("mid", part);
      if (error) {
        return json({ error: `Could not look up MIDs: ${error.message}` }, 500);
      }
      for (const merchant of data ?? []) {
        merchants.set(midKey(merchant.mid as string), {
          id: merchant.id as number,
          mid: merchant.mid as string,
          agentId: merchant.agent_id as string,
          status: (merchant.status as string | null) ?? null,
          processor: (merchant.processor as string | null) ?? null,
        });
      }
    }

    // Import lines already in the ledger for the batch's month (for
    // mid_in_other_batch) and for the month before (for payee_changed), in
    // pages: a large file can pass PostgREST's max_rows, and a truncated read
    // would drop a refusal silently.
    const readLines = async (period: string) => {
      const lines: {
        mid: string;
        processor: string | null;
        agent_id: string;
        share_role: string | null;
      }[] = [];
      for (const part of chunks(mids)) {
        for (let page = 0; ; page += 1) {
          const { data, error } = await ctx.supabaseAdmin
            .from("rep_payout_rows")
            .select("mid, processor, agent_id, share_role")
            .eq("line_kind", "import")
            .eq("period", period)
            .ilikeAnyOf("mid", part)
            .order("id", { ascending: true })
            .range(page * PAGE_SIZE, page * PAGE_SIZE + PAGE_SIZE - 1);
          if (error) return { error: error.message, lines };
          lines.push(...((data ?? []) as typeof lines));
          if ((data ?? []).length < PAGE_SIZE) break;
        }
      }
      return { error: null, lines };
    };

    const thisMonth = await readLines(batchPeriod);
    if (thisMonth.error !== null) {
      return json({ error: `Could not read the ledger: ${thisMonth.error}` }, 500);
    }
    const otherBatchMids = midsInOtherBatches(
      thisMonth.lines.map((line): MonthLine => ({
        mid: line.mid,
        processor: line.processor,
      })),
      batchProcessor,
    );

    const lastMonth = await readLines(monthsBefore(batchPeriod, 1));
    if (lastMonth.error !== null) {
      return json({ error: `Could not read the ledger: ${lastMonth.error}` }, 500);
    }
    const lastMonthLines: LastMonthLine[] = lastMonth.lines.map((line) => ({
      mid: line.mid,
      agentId: line.agent_id,
      shareRole: line.share_role,
    }));

    // ---- Shares on the file's merchants ---------------------------------
    //
    // For share_not_in_force only: the three v2 share flags went with v2
    // (phase 8), because v3 pays a share's signer, who is the owner, and the
    // partner directly. Advisory, never a blocker; the commit recomputes from
    // the shares in force then.
    const shares: PreviewShare[] = [];
    const midOfMerchant = new Map<number, string>(
      [...merchants.values()].map((merchant) => [merchant.id, merchant.mid]),
    );
    for (const part of chunks([...midOfMerchant.keys()])) {
      const { data, error } = await ctx.supabaseAdmin
        .from("merchant_rep_shares")
        .select(
          "id, merchant_id, primary_agent_id, secondary_agent_id, effective_from, effective_to",
        )
        .in("merchant_id", part);

      if (error) {
        return json(
          { error: `Could not look up shared accounts: ${error.message}` },
          500,
        );
      }
      for (const share of data ?? []) {
        shares.push({
          id: share.id as number,
          mid: midOfMerchant.get(share.merchant_id as number) as string,
          primaryAgentId: share.primary_agent_id as string,
          secondaryAgentId: share.secondary_agent_id as string,
          effectiveFrom: share.effective_from as string,
          effectiveTo: (share.effective_to as string | null) ?? null,
        });
      }
    }

    // ---- Names, for the notes ------------------------------------------
    const names = new Map<string, string>();
    const people = [
      ...new Set([
        ...[...merchants.values()].map((merchant) => merchant.agentId),
        ...shares.flatMap((share) => [
          share.primaryAgentId,
          share.secondaryAgentId,
        ]),
        ...lastMonthLines.map((line) => line.agentId),
      ]),
    ];
    for (const part of chunks(people)) {
      const { data, error } = await ctx.supabaseAdmin
        .from("profiles")
        .select("id, full_name")
        .in("id", part);

      if (error) {
        return json(
          { error: `Could not look up rep names: ${error.message}` },
          500,
        );
      }
      for (const person of data ?? []) {
        names.set(person.id as string, person.full_name as string);
      }
    }
    const nameOf = (id: string) => names.get(id) ?? "an unknown rep";

    // ---- The staged rows -----------------------------------------------
    const staged = parsed.rows.map((row) => {
      const merchant =
        row.mid_raw === null || row.blockers.includes("missing_mid")
          ? null
          : (merchants.get(midKey(row.mid_raw)) ?? null);

      const codes: ResidualBlocker[] = [...row.blockers];
      const messages = { ...row.messages };
      if (!row.blockers.includes("missing_mid") && row.mid_raw !== null) {
        if (merchant === null) {
          codes.push("unknown_mid");
          messages.unknown_mid = blockerMessage("unknown_mid", { mid: row.mid_raw });
        }
        if (otherBatchMids.has(midKey(row.mid_raw))) {
          codes.push("mid_in_other_batch");
          messages.mid_in_other_batch = blockerMessage("mid_in_other_batch", {
            mid: row.mid_raw,
            period: batchPeriod,
          });
        }
      }
      const blockers = orderBlockers(codes);
      const blocker = blockers[0] ?? null;

      const warnings = rowWarnings({
        fileProcessor: row.processor_raw,
        batchProcessor,
        merchant,
        volume: row.volume,
        residual: row.residual_income,
      });

      // Notes: a changed payee (A10), then a share that does not cover the
      // month. One flag per row, by that precedence; every applicable sentence
      // in the note.
      const previewRow = {
        period: batchPeriod,
        agentId: merchant?.agentId ?? null,
        mid: row.mid_raw,
        blocked: blocker !== null,
      };
      const notes: { flag: string; note: string }[] = [];
      const ownerName = merchant ? nameOf(merchant.agentId) : "";
      if (blocker === null && merchant !== null && row.mid_raw !== null) {
        const before = previousPayees(lastMonthLines, row.mid_raw, merchant.agentId);
        if (before !== null) {
          notes.push({
            flag: "payee_changed",
            note: payeeChangedNote({
              mid: row.mid_raw,
              period: batchPeriod,
              previousNames: before.map(nameOf),
              ownerName,
            }),
          });
        }
      }
      const unshared = previewUnsharedRow(previewRow, shares);
      if (unshared !== null) {
        notes.push({
          flag: unshared.flag,
          note: unsharedPreviewNote(unshared, {
            mid: row.mid_raw ?? "",
            period: batchPeriod,
            ownerName,
            nameOf,
          }),
        });
      }

      return {
        batch_id: batchId,
        row_number: row.row_number,
        processor_raw: row.processor_raw,
        mid_raw: row.mid_raw,
        merchant_name_raw: row.merchant_name_raw,
        income_type_raw: row.income_type_raw,
        volume_raw: row.volume_raw,
        residual_income_raw: row.residual_income_raw,
        // The month is the batch's: the file has no Period column.
        period: batchPeriod,
        agent_id: merchant?.agentId ?? null,
        merchant_id: merchant?.id ?? null,
        volume: row.volume,
        residual_income: row.residual_income,
        // Not read from the file, and not decided here: the rate is the
        // merchant's, written at commit (phase 8, memo §0b.4).
        rep_split_pct: null,
        blocker,
        blockers,
        warnings,
        preview_flag: notes[0]?.flag ?? null,
        preview_note: notes.length > 0 ? notes.map((n) => n.note).join(" ") : null,
        error:
          blocker === null
            ? null
            : blockers
              .map((code) => messages[code])
              .filter((text): text is string => Boolean(text))
              .join(" "),
      };
    });

    // ---- Replace this batch's staging rows -----------------------------
    const { error: clearError } = await ctx.supabaseAdmin
      .from("rep_payout_import_rows")
      .delete()
      .eq("batch_id", batchId);

    if (clearError) {
      return json(
        { error: `Could not clear the previous parse: ${clearError.message}` },
        500,
      );
    }

    const { error: insertError } = await ctx.supabaseAdmin
      .from("rep_payout_import_rows")
      .insert(staged);

    if (insertError) {
      return json(
        { error: `Could not stage the rows: ${insertError.message}` },
        500,
      );
    }

    const blockedCount = staged.filter((row) => row.blocker !== null).length;
    const flaggedCount = staged.filter((row) => row.preview_flag !== null)
      .length;
    const warningCounts: Record<string, number> = {};
    for (const row of staged) {
      for (const warning of row.warnings) {
        warningCounts[warning] = (warningCounts[warning] ?? 0) + 1;
      }
    }

    const { error: countError } = await ctx.supabaseAdmin
      .from("rep_payout_batches")
      .update({ row_count: staged.length, adjustment_rows_ignored: 0 })
      .eq("id", batchId);

    if (countError) {
      return json(
        { error: `Could not update the batch: ${countError.message}` },
        500,
      );
    }

    // Counts only. The review screen reads the staging rows itself -- it holds
    // SELECT on them -- so shaping the whole review payload here would be a second
    // copy of that grouping to keep in step with the first.
    return json({
      batch_id: batchId,
      row_count: staged.length,
      blocked_count: blockedCount,
      flagged_count: flaggedCount,
      warning_counts: warningCounts,
    });
  }),
};

/* To invoke locally:

  1. Run `supabase start` and `supabase functions serve`
  2. Create a batch and upload a file via residual-import-file-url, then:

  curl -i --location --request POST 'http://127.0.0.1:54321/functions/v1/parse-residual-import' \
    --header 'Authorization: Bearer <ADMIN_ACCESS_TOKEN>' \
    --header 'Content-Type: application/json' \
    --data '{"batch_id":1}'

  Expected: 200 with { batch_id, row_count, blocked_count, flagged_count,
            warning_counts }
            400 if the file is unreadable, a required column is missing or
                repeated, or it is a CRM export
            404 if the batch does not exist, or has no uploaded file
            409 if the batch is not in review, or has no processor and month
            403 if the caller is not an active admin
*/
