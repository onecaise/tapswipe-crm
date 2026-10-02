// Mints a signed URL for a marketing material file, in the private `marketing`
// bucket. Two modes, and unlike residual-import-file-url they have DIFFERENT
// authorization — which is the whole shape of this feature:
//
//   { category, title, file_name }  -> ADMIN ONLY. Creates the material row,
//                                      returns a signed UPLOAD url.
//   { material_id }                 -> ANY ACTIVE USER. Returns a signed
//                                      READ url for that material's file.
//                                      `download: true` asks Storage for
//                                      Content-Disposition: attachment; without
//                                      it the URL renders inline, which is what
//                                      "View" and "Print" need.
//
// An admin stocks the library; every rep reads it. That asymmetry is the reason
// this is not simply modelled on residual-import-file-url, where both
// directions are admin-only, and the reason the download branch deliberately
// does NOT call callerIsAdmin.
//
// verify_jwt = false in config.toml, so this function authenticates the caller
// itself — withSupabase({ auth: "user" }) rejects a missing or invalid JWT
// before the handler runs.
//
// Order matters, as in create-upload-url: authenticated, then an active
// profile, then (on the upload branch only) an admin, and only then the
// service-role client — reached for the two things the caller genuinely may not
// do, namely writing file_key (no grant admits it) and signing against a bucket
// with no storage policies at all.
//
// Why the material row is created BEFORE the upload: the Storage key is
// {material_id}/{file_name}, so the id has to exist before the key can be
// built. A material whose file never arrives is a harmless row with a null
// file_key, which the admin list shows as incomplete rather than offering a
// download that would 404.

import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";

import { callerIsActive, callerIsAdmin, json } from "../_shared/admin-users.ts";
import {
  MARKETING_BUCKET,
  buildMaterialKey,
  cleanLabel,
  fileKeyMatchesMaterial,
  isPositiveInt,
  sanitizeFileName,
} from "../_shared/marketing-materials.ts";

/** How long a download link stays valid. Long enough to click, short enough
 *  that a leaked URL isn't a lasting grant. Matches create-download-url. */
const SIGNED_URL_TTL_SECONDS = 60;

export default {
  fetch: withSupabase({ auth: "user" }, async (req, ctx) => {
    if (req.method !== "POST") {
      return json({ error: "Method not allowed" }, 405);
    }

    const userId = ctx.userClaims?.id;
    if (!userId) {
      return json({ error: "Not authenticated" }, 401);
    }

    // A valid JWT proves who the caller is, not that their account is still
    // enabled — a deactivated rep's token keeps working until it expires. This
    // is checked on BOTH branches, before the admin split, so a deactivated
    // admin gets an accurate reason rather than "admin only".
    if (!(await callerIsActive(ctx.supabase))) {
      return json({ error: "Account is not active" }, 403);
    }

    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return json({ error: "Body must be JSON" }, 400);
    }

    // ---- Download mode -------------------------------------------------
    //
    // No admin check, deliberately. The library is company reference data and
    // every active rep may read all of it; marketing_materials' select policy
    // says exactly that, and reading the row through the CALLER-scoped client
    // is what makes this function honour it rather than restate it.
    if (body.material_id !== undefined) {
      if (!isPositiveInt(body.material_id)) {
        return json({ error: "material_id must be a positive integer" }, 400);
      }

      const { data: material, error: materialError } = await ctx.supabase
        .from("marketing_materials")
        .select("id, file_key, file_name, mime_type, archived_at")
        .eq("id", body.material_id)
        .maybeSingle();

      if (materialError) {
        return json(
          { error: `Could not read the material: ${materialError.message}` },
          500,
        );
      }
      // A material that does not exist and one the policy hides give the same
      // 404 — "not yours" and "doesn't exist" must be indistinguishable or the
      // endpoint becomes an id oracle. Here the policy only hides rows from a
      // deactivated caller, who was already turned away above, but the shape is
      // kept because it is the shape every other function in this repo uses.
      if (!material) {
        return json({ error: "Material not found" }, 404);
      }

      // An upload that was started and never finished. Reported as its own
      // thing rather than as a 404: the row genuinely exists and an admin
      // looking at the library needs to be told to re-upload, not that the
      // material is missing.
      if (!material.file_key) {
        return json({ error: "Material has no file yet" }, 409);
      }

      // Re-derive rather than trust the column. The CHECK constraint already
      // enforces this and is VALIDATED, so unlike create-download-url there are
      // no legacy rows to cover — this is here so the signing step never trusts
      // a stored value, which is what keeps a relaxed constraint or a
      // hand-written repair from becoming a signed URL for an arbitrary object.
      if (!fileKeyMatchesMaterial(material.file_key, material.id)) {
        console.error(
          `[marketing-material-file-url] file_key does not match material ${material.id}`,
        );
        return json({ error: "Material not found" }, 404);
      }

      // Inline by default, attachment on request, and the difference is the
      // whole reason the UI can offer four distinct actions instead of two
      // buttons that do the same thing with different log entries. "View" and
      // "Print" need the browser to RENDER a PDF; "Download" needs it to save
      // one. create-download-url always passes `download`, because a document
      // is never meant to be read in the tab — an uploaded .html rendering on
      // the storage origin is the problem that option exists to avoid. The
      // marketing bucket holds collateral an admin curated, not rep-supplied
      // files, so rendering it is the point rather than the risk.
      const wantsAttachment = body.download === true;
      const { data, error } = await ctx.supabaseAdmin.storage
        .from(MARKETING_BUCKET)
        .createSignedUrl(
          material.file_key as string,
          SIGNED_URL_TTL_SECONDS,
          wantsAttachment
            ? { download: (material.file_name as string) ?? true }
            : undefined,
        );

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
        fileName: material.file_name,
        mimeType: material.mime_type,
        disposition: wantsAttachment ? "attachment" : "inline",
      });
    }

    // ---- Upload mode ---------------------------------------------------
    if (!(await callerIsAdmin(ctx.supabase))) {
      return json({ error: "Admin only" }, 403);
    }

    const category = cleanLabel(body.category);
    const title = cleanLabel(body.title);
    if (!category) {
      return json({ error: "category is required" }, 400);
    }
    if (!title) {
      return json({ error: "title is required" }, 400);
    }
    if (typeof body.file_name !== "string" || body.file_name.trim() === "") {
      return json({ error: "file_name is required" }, 400);
    }

    const fileName = sanitizeFileName(body.file_name);
    const mimeType =
      typeof body.mime_type === "string" && body.mime_type.trim() !== ""
        ? body.mime_type.trim().slice(0, 255)
        : null;

    // file_key is left null here rather than set to a placeholder, because
    // marketing_materials_file_key_matches_id would reject anything that is not
    // already {this row's id}/... — and the id does not exist yet. That is why
    // the column is nullable and why the constraint spells out `file_key is
    // null or ...`. rep_payout_batches uses "pending" instead only because its
    // file_key is NOT NULL and carries no such CHECK.
    const { data: created, error: createError } = await ctx.supabaseAdmin
      .from("marketing_materials")
      .insert({
        category,
        title,
        file_key: null,
        file_name: fileName,
        mime_type: mimeType,
        uploaded_by: userId,
      })
      .select("id")
      .single();

    if (createError || !created) {
      return json(
        {
          error: `Could not create the material: ${
            createError?.message ?? "unknown"
          }`,
        },
        500,
      );
    }

    const materialId = created.id as number;
    const fileKey = buildMaterialKey(materialId, fileName);

    const { error: keyError } = await ctx.supabaseAdmin
      .from("marketing_materials")
      .update({ file_key: fileKey })
      .eq("id", materialId);

    if (keyError) {
      // The row would otherwise sit in the library forever with a null file_key
      // and no upload in flight. Archived rather than deleted, so the admin
      // page shows what happened instead of the material silently never having
      // existed — and because there is no delete path on this table at all.
      await ctx.supabaseAdmin
        .from("marketing_materials")
        .update({ archived_at: new Date().toISOString() })
        .eq("id", materialId);

      return json(
        { error: `Could not record the file key: ${keyError.message}` },
        500,
      );
    }

    // Audited before the URL is minted, matching create-upload-url and
    // read-pre-app-secrets. This is the table's only audit surface: neither
    // marketing table carries log_cross_agent_change(), because
    // marketing_materials has no agent_id for it to read (the
    // support_ticket_replies trap) and marketing_material_events is already a
    // trail of its own.
    //
    // Fails closed. Nothing has been handed over at this point — no URL minted,
    // no bytes moved — so refusing is strictly better than signing an upload
    // whose record of who stocked the library does not exist.
    const { error: auditError } = await ctx.supabaseAdmin
      .from("audit_log")
      .insert({
        actor_id: userId,
        action: "upload_marketing_material",
        table_name: "marketing_materials",
        row_id: String(materialId),
      });
    if (auditError) {
      console.error(
        `[marketing-material-file-url] audit write: ${auditError.message}`,
      );
      await ctx.supabaseAdmin
        .from("marketing_materials")
        .update({ archived_at: new Date().toISOString() })
        .eq("id", materialId);
      return json({ error: "Could not record the access" }, 500);
    }

    const { data, error } = await ctx.supabaseAdmin.storage
      .from(MARKETING_BUCKET)
      .createSignedUploadUrl(fileKey);

    if (error || !data) {
      return json(
        { error: `Could not create upload URL: ${error?.message ?? "unknown"}` },
        500,
      );
    }

    return json({
      material_id: materialId,
      path: data.path,
      token: data.token,
      signedUrl: data.signedUrl,
      fileKey,
    });
  }),
};

/* To invoke locally:

  1. Run `supabase start` and `supabase functions serve`
  2. Sign in to get a user access token, then:

  curl -i --location --request POST 'http://127.0.0.1:54321/functions/v1/marketing-material-file-url' \
    --header 'Authorization: Bearer <ADMIN_ACCESS_TOKEN>' \
    --header 'Content-Type: application/json' \
    --data '{"category":"Rate cards","title":"Retail 2026","file_name":"retail.pdf"}'

  Expected: 200 with { material_id, path, token, signedUrl, fileKey }
            403 if the caller is not an active admin

  curl -i --location --request POST 'http://127.0.0.1:54321/functions/v1/marketing-material-file-url' \
    --header 'Authorization: Bearer <ANY_ACTIVE_USER_TOKEN>' \
    --header 'Content-Type: application/json' \
    --data '{"material_id":1}'

  Expected: 200 with { signedUrl, fileName, mimeType, disposition } — for a
            REP as well as an admin, which is the point of the library.
            Add "download": true for Content-Disposition: attachment.
            409 if the upload was never finished
            404 for a material id that does not exist
            403 if the caller's profile is deactivated
            401 if there is no valid JWT
*/
