// Mints a signed URL for a business document, in the private
// `business-documents` bucket -- the company library behind /documents.
//
// Modelled on marketing-material-file-url, and the two modes have DIFFERENT
// authorization for the same reason they do there:
//
//   { category, title, file_name }  -> ADMIN ONLY. Creates the document row,
//                                      returns a signed UPLOAD url.
//   { document_id }                 -> ANY ACTIVE USER. Returns a signed READ
//                                      url. `download: true` asks Storage for
//                                      Content-Disposition: attachment; without
//                                      it the URL renders inline (View, Print).
//
// An admin stocks the library; every rep reads it. The download branch
// therefore deliberately does NOT call callerIsAdmin.
//
// One difference from marketing: an ARCHIVED document -- what the UI calls
// "deleted" -- is signed for nobody, admins included. A rep cannot even see
// the row (the select policy hides archived rows from non-admins), and the
// explicit check below covers an admin, whose policy branch still returns it.
// Marketing signs an archived material, because there an archived row is
// still history somebody reads; here it is gone.
//
// verify_jwt = false in config.toml, so this function authenticates the caller
// itself -- withSupabase({ auth: "user" }) rejects a missing or invalid JWT
// before the handler runs. Order: authenticated, then an active profile, then
// (upload only) an admin, and only then the service-role client, for the two
// things the caller genuinely may not do: write file_key and sign against a
// bucket with no storage policies.

import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";

import { callerIsActive, callerIsAdmin, json } from "../_shared/admin-users.ts";
import {
  BUSINESS_DOCUMENTS_BUCKET,
  buildBusinessDocumentKey,
  cleanLabel,
  fileKeyMatchesBusinessDocument,
  isPositiveInt,
  sanitizeFileName,
  sizeOrNull,
} from "../_shared/business-documents.ts";

/** How long a link stays valid: long enough to click, short enough that a
 *  leaked URL isn't a lasting grant. Matches marketing-material-file-url. */
const SIGNED_URL_TTL_SECONDS = 60;

/**
 * The only types signed for INLINE rendering; everything else is forced to
 * attachment whatever the caller asked. An inline response renders on the
 * STORAGE origin with a live window.opener back to the CRM tab, so this is an
 * allow-list of passive types. image/svg+xml is deliberately absent: an image
 * everywhere else, a script host in a browser. Same set as marketing.
 */
const INLINE_SAFE_TYPES = new Set([
  "application/pdf",
  "text/plain",
  "image/png",
  "image/jpeg",
  "image/gif",
  "image/webp",
]);

export default {
  fetch: withSupabase({ auth: "user" }, async (req, ctx) => {
    if (req.method !== "POST") {
      return json({ error: "Method not allowed" }, 405);
    }

    const userId = ctx.userClaims?.id;
    if (!userId) {
      return json({ error: "Not authenticated" }, 401);
    }

    // Before the admin split, so a deactivated admin gets the accurate reason.
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
    // No admin check, deliberately. The row is read through the CALLER-scoped
    // client, so the select policy -- every active user, live rows only, all
    // rows for an admin -- is what decides, rather than a restatement of it.
    if (body.document_id !== undefined) {
      if (!isPositiveInt(body.document_id)) {
        return json({ error: "document_id must be a positive integer" }, 400);
      }

      const { data: doc, error: docError } = await ctx.supabase
        .from("business_documents")
        .select("id, file_key, file_name, mime_type, archived_at")
        .eq("id", body.document_id)
        .maybeSingle();

      if (docError) {
        return json(
          { error: `Could not read the document: ${docError.message}` },
          500,
        );
      }

      // Missing, hidden by the policy, and deleted all read the same: "not
      // yours" and "doesn't exist" must be indistinguishable or this becomes
      // an id oracle, and a deleted document is, to everyone, not there.
      if (!doc || doc.archived_at !== null) {
        return json({ error: "Document not found" }, 404);
      }

      // An upload that was started and never finished: the row exists, and
      // an admin needs telling to re-upload rather than that it is missing.
      if (!doc.file_key) {
        return json({ error: "Document has no file yet" }, 409);
      }

      if (!fileKeyMatchesBusinessDocument(doc.file_key, doc.id)) {
        console.error(
          `[business-document-file-url] file_key does not match document ${doc.id}`,
        );
        return json({ error: "Document not found" }, 404);
      }

      const inlineSafe =
        typeof doc.mime_type === "string" &&
        INLINE_SAFE_TYPES.has(doc.mime_type.split(";")[0].trim().toLowerCase());
      const wantsAttachment = body.download === true || !inlineSafe;

      const { data, error } = await ctx.supabaseAdmin.storage
        .from(BUSINESS_DOCUMENTS_BUCKET)
        .createSignedUrl(
          doc.file_key as string,
          SIGNED_URL_TTL_SECONDS,
          wantsAttachment
            ? { download: (doc.file_name as string) ?? true }
            : undefined,
        );

      if (error || !data) {
        return json(
          { error: `Could not create download URL: ${error?.message ?? "unknown"}` },
          500,
        );
      }

      return json({
        signedUrl: data.signedUrl,
        fileName: doc.file_name,
        mimeType: doc.mime_type,
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

    // Archives a row this call created and could not finish. There is no
    // delete path on business_documents, and an archived row is invisible to
    // reps, so nothing half-made reaches the library.
    const archive = async (id: number): Promise<void> => {
      await ctx.supabaseAdmin
        .from("business_documents")
        .update({ archived_at: new Date().toISOString() })
        .eq("id", id);
    };

    const fileName = sanitizeFileName(body.file_name);
    const mimeType =
      typeof body.mime_type === "string" && body.mime_type.trim() !== ""
        ? body.mime_type.trim().slice(0, 255)
        : null;

    // file_key null for now: the CHECK only admits {this row's id}/..., and the
    // id does not exist until this insert returns.
    const { data: created, error: createError } = await ctx.supabaseAdmin
      .from("business_documents")
      .insert({
        category,
        title,
        file_key: null,
        file_name: fileName,
        mime_type: mimeType,
        size_bytes: sizeOrNull(body.size_bytes),
        uploaded_by: userId,
      })
      .select("id")
      .single();

    if (createError || !created) {
      return json(
        { error: `Could not create the document: ${createError?.message ?? "unknown"}` },
        500,
      );
    }

    const documentId = created.id as number;
    const fileKey = buildBusinessDocumentKey(documentId, fileName);

    const { error: keyError } = await ctx.supabaseAdmin
      .from("business_documents")
      .update({ file_key: fileKey })
      .eq("id", documentId);

    if (keyError) {
      await archive(documentId);
      return json(
        { error: `Could not record the file key: ${keyError.message}` },
        500,
      );
    }

    // Audited before the URL is minted, and fails closed: nothing has been
    // handed over yet, so refusing beats signing an upload with no record of
    // who stocked the library. The table's only audit surface -- it carries
    // no log_cross_agent_change() (no agent_id for it to read).
    const { error: auditError } = await ctx.supabaseAdmin
      .from("audit_log")
      .insert({
        actor_id: userId,
        action: "upload_business_document",
        table_name: "business_documents",
        row_id: String(documentId),
      });
    if (auditError) {
      console.error(
        `[business-document-file-url] audit write: ${auditError.message}`,
      );
      await archive(documentId);
      return json({ error: "Could not record the access" }, 500);
    }

    const { data, error } = await ctx.supabaseAdmin.storage
      .from(BUSINESS_DOCUMENTS_BUCKET)
      .createSignedUploadUrl(fileKey);

    if (error || !data) {
      // Archived, like the two failure paths above. The row already HAS a
      // file_key, so left live it would sit in every rep's library and answer
      // "Object not found" -- what a missing marketing bucket on dev produced,
      // one dead row per attempt.
      await archive(documentId);
      return json(
        { error: `Could not create upload URL: ${error?.message ?? "unknown"}` },
        500,
      );
    }

    return json({
      document_id: documentId,
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

  curl -i --location --request POST 'http://127.0.0.1:54321/functions/v1/business-document-file-url' \
    --header 'Authorization: Bearer <ADMIN_ACCESS_TOKEN>' \
    --header 'Content-Type: application/json' \
    --data '{"category":"Policies","title":"Chargeback policy","file_name":"chargebacks.pdf","size_bytes":2048}'

  Expected: 200 with { document_id, path, token, signedUrl, fileKey }
            403 "Admin only" for a rep

  curl -i --location --request POST 'http://127.0.0.1:54321/functions/v1/business-document-file-url' \
    --header 'Authorization: Bearer <ANY_ACTIVE_USER_TOKEN>' \
    --header 'Content-Type: application/json' \
    --data '{"document_id":1}'

  Expected: 200 with { signedUrl, fileName, mimeType, disposition } for a rep
            or an admin; add "download": true for an attachment.
            404 for a missing or deleted (archived) document
            409 if the upload never finished
            403 if the caller is deactivated
            401 with no valid JWT
*/
