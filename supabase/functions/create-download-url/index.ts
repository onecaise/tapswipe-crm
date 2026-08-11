// Mints a short-lived signed download URL for an object in the private
// `documents` bucket.
//
// verify_jwt = false in config.toml, so this function authenticates the caller
// itself — withSupabase({ auth: "user" }) rejects a missing or invalid JWT
// before the handler runs.
//
// Simpler than the upload side: the documents row already exists, so RLS on that
// row *is* the authorization check. The admin client is used only to sign, after
// the row has been resolved through the caller's own client.

import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";

import {
  STORAGE_BUCKET,
  callerIsActive,
  isPositiveInt,
  json,
} from "../_shared/documents.ts";

/** How long a download link stays valid. Long enough to click, short enough
 *  that a leaked URL isn't a lasting grant. */
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

    let body: Record<string, unknown>;
    try {
      body = await req.json();
    } catch {
      return json({ error: "Body must be JSON" }, 400);
    }

    const documentId = body.document_id;
    if (!isPositiveInt(documentId)) {
      return json({ error: "document_id must be a positive integer" }, 400);
    }

    if (!(await callerIsActive(ctx.supabase))) {
      return json({ error: "Account is not active" }, 403);
    }

    // Through the caller-scoped client on purpose: the documents select policy
    // is `(agent_id = auth.uid() and is_active_agent()) or is_admin()`, so this
    // returns nothing unless the caller is genuinely entitled to the row. Doing
    // the same lookup with supabaseAdmin would return every row and put the
    // whole authorization decision on hand-written code here.
    const { data: document, error } = await ctx.supabase
      .from("documents")
      .select("file_key, file_name")
      .eq("id", documentId)
      .maybeSingle();

    if (error || !document) {
      // Not found and not yours, indistinguishable.
      return json({ error: "Document not found" }, 404);
    }

    // Audited BEFORE the URL is minted, and a failed write blocks the download.
    //
    // Same ordering and the same trade as read-pre-app-secrets: for data this
    // sensitive — driver's licences, voided cheques, business verification — an
    // audit outage refusing access is the right failure, whereas handing out a
    // signed URL with no record of who asked is not. Note it is not enough to
    // audit the documents row: bytes leave through the URL, so the mint is the
    // event worth recording.
    const { error: auditError } = await ctx.supabaseAdmin
      .from("audit_log")
      .insert({
        actor_id: userId,
        action: "download_document",
        table_name: "documents",
        row_id: String(documentId),
      });
    if (auditError) {
      console.error(`[create-download-url] audit write: ${auditError.message}`);
      return json({ error: "Could not record the access" }, 500);
    }

    const { data, error: signError } = await ctx.supabaseAdmin.storage
      .from(STORAGE_BUCKET)
      .createSignedUrl(document.file_key as string, SIGNED_URL_TTL_SECONDS, {
        download: (document.file_name as string | null) ?? undefined,
      });

    if (signError || !data) {
      return json(
        {
          error: `Could not create download URL: ${signError?.message ?? "unknown"}`,
        },
        500,
      );
    }

    return json({
      signedUrl: data.signedUrl,
      expiresIn: SIGNED_URL_TTL_SECONDS,
      fileName: document.file_name ?? null,
    });
  }),
};

/* To invoke locally:

  1. Run `supabase start`
  2. Sign in to get a user access token, then:

  curl -i --location --request POST 'http://127.0.0.1:54321/functions/v1/create-download-url' \
    --header 'Authorization: Bearer <USER_ACCESS_TOKEN>' \
    --header 'Content-Type: application/json' \
    --data '{"document_id":1}'

  Expected: 200 with { signedUrl, expiresIn, fileName }
            404 if that document isn't yours (same as if it didn't exist)
            403 if your profile is deactivated
*/
