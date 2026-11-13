// Stages the ISO Hub merchants export (CSV or XLSX) into merchant_import_rows,
// creating the batch on the way. Phase 14 of docs/design/intake-and-reports.md.
//
// verify_jwt = false in config.toml, so this function authenticates the caller
// itself. Admin-only, and the order is the house order: authenticated, active
// profile, admin, and only then the service-role client.
//
// The user bulk import's shape (stage-user-import): the file travels in the
// request body and is kept on the batch row, so there is no bucket, and "Read
// again" re-reads the stored file against a database that has changed since.
// IDEMPOTENT ON PURPOSE: a re-read deletes the batch's staging rows first.
//
// This function only MARKS problems, for the review page. The commit,
// commit_merchant_import(), re-derives every refusal from the staged cells in
// SQL, so nothing here is the last word. All the judgement is in
// _shared/merchant-imports.ts (pure, unit-tested); SheetJS stays here, as in
// parse-residual-import, because a _shared module with a dependency would need
// an import map of its own.

import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";
import * as XLSX from "xlsx";

import {
  callerIsActive,
  callerIsAdmin,
  json,
} from "../_shared/admin-users.ts";
import {
  MAX_SOURCE_BYTES,
  csvCells,
  parseMerchantSheet,
  sniffSource,
  validateMerchantRows,
  type ImportProfile,
} from "../_shared/merchant-imports.ts";
import { isPositiveInt } from "../_shared/user-imports.ts";

/** Display only; the batch's CHECK says the same. */
const MAX_FILE_NAME_LENGTH = 200;

/** PostgREST caps a response at [api] max_rows; read and write in pages. */
const PAGE_SIZE = 500;

function toHex(bytes: Uint8Array): string {
  let out = "\\x";
  for (const byte of bytes) out += byte.toString(16).padStart(2, "0");
  return out;
}

function fromHex(value: string): Uint8Array {
  const hex = value.startsWith("\\x") ? value.slice(2) : value;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

function fromBase64(value: string): Uint8Array | null {
  try {
    const binary = atob(value);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) out[i] = binary.charCodeAt(i);
    return out;
  } catch {
    return null;
  }
}

type Cells = { cells: unknown[][]; formatted?: unknown[][] };

/** Bytes to cells, or a sentence for the admin. */
function readCells(bytes: Uint8Array): { ok: true; kind: "csv" | "xlsx"; value: Cells } | { ok: false; error: string } {
  const source = sniffSource(bytes);
  if (source.kind === "xls") {
    return {
      ok: false,
      error: "That is an old-style .xls workbook. Open it in Excel and save it as .xlsx or CSV, or use the original CSV export.",
    };
  }
  if (source.kind === "csv") {
    return { ok: true, kind: "csv", value: { cells: csvCells(source.text) } };
  }
  try {
    const workbook = XLSX.read(bytes, { type: "array" });
    const first = workbook.SheetNames[0];
    if (first === undefined) return { ok: false, error: "That file has no sheets." };
    // Only the first sheet, as for residuals: which merchants are imported must
    // not depend on tab order.
    const options = { header: 1 as const, defval: null, blankrows: true };
    return {
      ok: true,
      kind: "xlsx",
      value: {
        // Values (a number stays a number, which is how a Merchant ID that may
        // have lost digits is recognised) and the displayed text.
        cells: XLSX.utils.sheet_to_json(workbook.Sheets[first], { ...options, raw: true }) as unknown[][],
        formatted: XLSX.utils.sheet_to_json(workbook.Sheets[first], { ...options, raw: false }) as unknown[][],
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: `That file could not be read as a spreadsheet: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    };
  }
}

export default {
  fetch: withSupabase({ auth: "user" }, async (req, ctx) => {
    if (req.method !== "POST") {
      return json({ error: "Method not allowed" }, 405);
    }

    const actorId = ctx.userClaims?.id;
    if (!actorId) {
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

    const isReread = body.batch_id !== undefined && body.batch_id !== null;
    if (isReread && body.file_base64 !== undefined) {
      return json(
        { error: "Send either batch_id to read a stored file again, or file_base64 to start a new import — not both." },
        400,
      );
    }

    let batchId: number;
    let bytes: Uint8Array;

    if (isReread) {
      if (!isPositiveInt(body.batch_id)) {
        return json({ error: "batch_id must be a positive integer" }, 400);
      }
      batchId = body.batch_id;

      // Caller-scoped, so RLS decides: a batch that is not visible is one that
      // does not exist.
      const { data: batch, error } = await ctx.supabase
        .from("merchant_import_batches")
        .select("id, status, source_bytes")
        .eq("id", batchId)
        .maybeSingle();
      if (error) return json({ error: `Could not read the import: ${error.message}` }, 500);
      if (!batch) return json({ error: "Import not found" }, 404);
      if (batch.status !== "review") {
        return json({ error: `This import is ${String(batch.status)} and cannot be read again` }, 409);
      }
      bytes = fromHex(String(batch.source_bytes ?? ""));
    } else {
      const { file_name: fileName, file_base64: encoded } = body;
      if (typeof fileName !== "string" || fileName.trim() === "") {
        return json({ error: "file_name is required" }, 400);
      }
      if (typeof encoded !== "string" || encoded === "") {
        return json({ error: "file_base64 is required" }, 400);
      }
      // Checked on the encoded length first, so an absurd body is refused before
      // it is decoded.
      if (encoded.length > Math.ceil(MAX_SOURCE_BYTES / 3) * 4 + 4) {
        return json({ error: `That file is too large to import. The limit is ${MAX_SOURCE_BYTES / (1024 * 1024)} MB.` }, 400);
      }
      const decoded = fromBase64(encoded);
      if (decoded === null || decoded.length === 0) {
        return json({ error: "file_base64 is not a readable file" }, 400);
      }
      if (decoded.length > MAX_SOURCE_BYTES) {
        return json({ error: `That file is too large to import. The limit is ${MAX_SOURCE_BYTES / (1024 * 1024)} MB.` }, 400);
      }
      bytes = decoded;

      // Read BEFORE the batch exists, so a file that cannot be read leaves
      // nothing behind (the stage-user-import rule).
      const preflight = readCells(bytes);
      if (!preflight.ok) return json({ error: preflight.error }, 400);
      const preparsed = parseMerchantSheet(preflight.value.cells, preflight.value.formatted);
      if (!preparsed.ok) return json({ error: preparsed.error }, 400);

      const { data: created, error: createError } = await ctx.supabaseAdmin
        .from("merchant_import_batches")
        .insert({
          file_name: fileName.trim().slice(0, MAX_FILE_NAME_LENGTH),
          file_kind: preflight.kind,
          source_bytes: toHex(bytes),
        })
        .select("id")
        .single();
      if (createError || !created) {
        return json({ error: `Could not start the import: ${createError?.message ?? "unknown error"}` }, 500);
      }
      batchId = created.id as number;
    }

    // ---- Parse --------------------------------------------------------------
    const read = readCells(bytes);
    if (!read.ok) return json({ error: read.error, batch_id: batchId }, 400);
    const parsed = parseMerchantSheet(read.value.cells, read.value.formatted);
    if (!parsed.ok) return json({ error: parsed.error, batch_id: batchId }, 400);

    // ---- Lookups ------------------------------------------------------------
    // Through the ADMIN client, as stage-user-import and parse-residual-import
    // do: the caller is a verified active admin, who may read all of this
    // anyway, and nothing below branches on privilege. It decides nothing:
    // the commit re-derives every check.
    const profiles: ImportProfile[] = [];
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data, error } = await ctx.supabaseAdmin
        .from("profiles")
        .select("id, full_name, llc_legal_name, role, is_active, split_rate_pct")
        .order("id")
        .range(from, from + PAGE_SIZE - 1);
      if (error) return json({ error: `Could not read the reps: ${error.message}` }, 500);
      profiles.push(...((data ?? []) as ImportProfile[]));
      if ((data ?? []).length < PAGE_SIZE) break;
    }

    const { data: processorData, error: processorError } = await ctx.supabaseAdmin
      .from("processors")
      .select("code, label");
    if (processorError) {
      return json({ error: `Could not read the processors: ${processorError.message}` }, 500);
    }

    const existingMids: string[] = [];
    for (let from = 0; ; from += PAGE_SIZE) {
      const { data, error } = await ctx.supabaseAdmin
        .from("merchants")
        .select("mid")
        .not("mid", "is", null)
        .order("id")
        .range(from, from + PAGE_SIZE - 1);
      if (error) return json({ error: `Could not read the merchants: ${error.message}` }, 500);
      for (const row of data ?? []) existingMids.push(String(row.mid));
      if ((data ?? []).length < PAGE_SIZE) break;
    }

    const staged = validateMerchantRows(parsed.rows, {
      profiles,
      processors: (processorData ?? []) as { code: string; label: string }[],
      existingMids,
    }).map((row) => ({ batch_id: batchId, ...row }));

    // ---- Replace this batch's staging rows ------------------------------------
    const { error: clearError } = await ctx.supabaseAdmin
      .from("merchant_import_rows")
      .delete()
      .eq("batch_id", batchId);
    if (clearError) {
      return json({ error: `Could not clear the previous read: ${clearError.message}` }, 500);
    }

    for (let i = 0; i < staged.length; i += PAGE_SIZE) {
      const { error } = await ctx.supabaseAdmin
        .from("merchant_import_rows")
        .insert(staged.slice(i, i + PAGE_SIZE));
      if (error) return json({ error: `Could not stage the rows: ${error.message}` }, 500);
    }

    const { error: countError } = await ctx.supabaseAdmin
      .from("merchant_import_batches")
      .update({ row_count: staged.length })
      .eq("id", batchId);
    if (countError) {
      return json({ error: `Could not update the import: ${countError.message}` }, 500);
    }

    // Counts only: the review page reads the staged rows itself.
    const refused = staged.filter((row) => row.blockers.length > 0).length;
    const merchants = staged.filter((row) => row.merged_into === null && row.blockers.length === 0).length;

    return json({
      batch_id: batchId,
      row_count: staged.length,
      refused_count: refused,
      merchant_count: merchants,
      ready: refused === 0,
    });
  }),
};

/* To invoke locally:

  1. Run `supabase start` and `supabase functions serve`
  2. Sign in as an admin to get an access token, then:

  curl -i --location --request POST 'http://127.0.0.1:54321/functions/v1/stage-merchant-import' \
    --header 'Authorization: Bearer <ADMIN_ACCESS_TOKEN>' \
    --header 'Content-Type: application/json' \
    --data '{"file_name":"merchants.csv","file_base64":"<base64 of the file>"}'

  Read a stored file again:   --data '{"batch_id":1}'

  Expected: 200 with { batch_id, row_count, refused_count, merchant_count, ready }
            400 unreadable, wrong columns, empty, over 2000 rows or 2 MB, or both modes
            404 the batch does not exist
            409 the batch is no longer in review
            403 the caller is not an active admin
            401 no valid JWT
*/
