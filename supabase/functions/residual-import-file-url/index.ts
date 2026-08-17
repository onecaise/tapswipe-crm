// Mints a signed URL for a residual import file, in the private
// `residual-imports` bucket. Two modes, both admin-only:
//
//   { file_name }  -> creates the batch row, returns a signed UPLOAD url
//   { batch_id }   -> returns a signed DOWNLOAD url for that batch's file
//
// verify_jwt = false in config.toml, so this function authenticates the caller
// itself — withSupabase({ auth: "user" }) rejects a missing or invalid JWT before
// the handler runs.
//
// Order matters, as in create-upload-url: authenticated, then an active profile,
// then an admin, and only then the service-role client — which is reached for two
// things the caller genuinely may not do, namely inserting a rep_payout_batches
// row (that table has no INSERT policy) and signing against a bucket with no
// storage policies at all.
//
// Why the batch row is created BEFORE the upload: the Storage key is
// {batch_id}/{file_name}, so the id has to exist before the key can be built. A
// batch whose file never arrives is a harmless `review` row with row_count 0, and
// the import page offers to abandon it.

import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";

import {
  callerIsActive,
  callerIsAdmin,
  json,
} from "../_shared/admin-users.ts";
import {
  RESIDUAL_BUCKET,
  buildBatchKey,
  isPositiveInt,
  sanitizeFileName,
} from "../_shared/residual-imports.ts";

export default {
  fetch: withSupabase({ auth: "user" }, async (req, ctx) => {
    if (req.method !== "POST") {
      return json({ error: "Method not allowed" }, 405);
    }

    const userId = ctx.userClaims?.id;
    if (!userId) {
      return json({ error: "Not authenticated" }, 401);
    }

    // Both checks through the CALLER-scoped client, so the database decides.
    // callerIsActive first, so a deactivated admin gets an accurate reason rather
    // than "admin only".
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

    // ---- Download mode -------------------------------------------------
    if (body.batch_id !== undefined) {
      if (!isPositiveInt(body.batch_id)) {
        return json({ error: "batch_id must be a positive integer" }, 400);
      }

      // Read the batch through the caller-scoped client, so RLS is what decides
      // whether it is visible. A batch that does not exist and one the policy
      // hides give the same 404 — "not yours" and "doesn't exist" must be
      // indistinguishable or the endpoint becomes an id oracle.
      const { data: batch, error: batchError } = await ctx.supabase
        .from("rep_payout_batches")
        .select("id, file_key, file_name")
        .eq("id", body.batch_id)
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

      const { data, error } = await ctx.supabaseAdmin.storage
        .from(RESIDUAL_BUCKET)
        .createSignedUrl(batch.file_key as string, 60);

      if (error || !data) {
        return json(
          {
            error: `Could not create download URL: ${
              error?.message ?? "unknown"
            }`,
          },
          500,
        );
      }

      return json({
        signedUrl: data.signedUrl,
        fileName: batch.file_name,
      });
    }

    // ---- Upload mode ---------------------------------------------------
    if (typeof body.file_name !== "string" || body.file_name.trim() === "") {
      return json({ error: "file_name is required" }, 400);
    }

    const fileName = sanitizeFileName(body.file_name);

    // Placeholder key: the real one needs the id this insert is about to produce.
    // Updated immediately below, in the only window where a batch row exists with
    // a key that does not match its id — which is why the update is checked.
    const { data: created, error: createError } = await ctx.supabaseAdmin
      .from("rep_payout_batches")
      .insert({
        imported_by: userId,
        file_key: "pending",
        file_name: fileName,
        status: "review",
        row_count: 0,
      })
      .select("id")
      .single();

    if (createError || !created) {
      return json(
        {
          error: `Could not start the import: ${
            createError?.message ?? "unknown"
          }`,
        },
        500,
      );
    }

    const batchId = created.id as number;
    const fileKey = buildBatchKey(batchId, fileName);

    const { error: keyError } = await ctx.supabaseAdmin
      .from("rep_payout_batches")
      .update({ file_key: fileKey })
      .eq("id", batchId);

    if (keyError) {
      // The row would otherwise be left pointing at "pending" forever, and the
      // parse step would 404 on a file it could never find. Abandoned rather than
      // deleted, so the import page shows what happened instead of the batch
      // silently never having existed.
      await ctx.supabaseAdmin
        .from("rep_payout_batches")
        .update({ status: "abandoned" })
        .eq("id", batchId);

      return json(
        { error: `Could not record the file key: ${keyError.message}` },
        500,
      );
    }

    const { data, error } = await ctx.supabaseAdmin.storage
      .from(RESIDUAL_BUCKET)
      .createSignedUploadUrl(fileKey);

    if (error || !data) {
      return json(
        { error: `Could not create upload URL: ${error?.message ?? "unknown"}` },
        500,
      );
    }

    return json({
      batch_id: batchId,
      path: data.path,
      token: data.token,
      signedUrl: data.signedUrl,
      fileKey,
    });
  }),
};

/* To invoke locally:

  1. Run `supabase start` and `supabase functions serve`
  2. Sign in as an admin to get an access token, then:

  curl -i --location --request POST 'http://127.0.0.1:54321/functions/v1/residual-import-file-url' \
    --header 'Authorization: Bearer <ADMIN_ACCESS_TOKEN>' \
    --header 'Content-Type: application/json' \
    --data '{"file_name":"July-2026.xlsx"}'

  Expected: 200 with { batch_id, path, token, signedUrl, fileKey }
            200 with { signedUrl, fileName } when given { batch_id } instead
            404 for a batch id that does not exist
            403 if the caller is not an active admin
            401 if there is no valid JWT
*/
