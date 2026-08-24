// Deletes a document: the metadata row AND the object behind it.
//
// Why this function exists at all. Removing a document used to be a plain
// `supabase.from("documents").delete()` from the browser, which is a perfectly
// good authorization story — the delete policy is
// `(agent_id = auth.uid() and is_active_agent()) or is_admin()` — but it can
// only ever reach the metadata. The bucket is private and has no storage
// policies, so nothing the browser holds can remove an object; that needs the
// service role. Measured on the running stack: after a delete the row was gone
// and `storage.list()` still showed the file.
//
// It was documented as a deliberate trade ("an orphaned object isn't exposed;
// it's a storage-cost cleanup task, not a leak"), and the cost argument is true
// as far as it goes. What it misses is what these documents are. A rep who
// attaches the wrong customer's driver's licence or a voided cheque to the wrong
// merchant and clicks Remove has been told the document is gone. It was not
// gone. It sat in the bucket indefinitely, still readable by anything holding
// the service role, and — until documents_file_key_matches_owner landed —
// re-readable by the uploader simply by inserting a fresh row with the same key.
// "Delete" has to mean delete for that kind of data.
//
// Same shape as every other function here: authenticate, check the account is
// active, authorize through the caller-scoped client so RLS decides, and only
// then reach for supabaseAdmin, and only for the privileged step.

import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";

import {
  type QueryClient,
  STORAGE_BUCKET,
  callerIsActive,
  fileKeyMatchesOwner,
  isOwnerType,
  isPositiveInt,
  json,
  parseFileKey,
  resolveParentAgentId,
} from "../_shared/documents.ts";

/**
 * The slice of the service-role client abandonOrphan() needs.
 *
 * Structural rather than the real SupabaseClient type, matching QueryClient in
 * _shared/documents.ts and for the same reason: that module is deliberately
 * dependency-free so it needs no import map entry of its own.
 */
type AdminSurface = {
  from: (table: string) => {
    insert: (
      row: Record<string, unknown>,
    ) => PromiseLike<{ error: { message: string } | null }>;
  };
  storage: {
    from: (bucket: string) => {
      remove: (
        paths: string[],
      ) => PromiseLike<{ error: { message: string } | null }>;
    };
  };
};

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
    const abandonedKey = body.file_key;

    // Two modes, and exactly one of them per call. `document_id` removes a
    // document the app is showing. `file_key` cleans up an object whose metadata
    // row was never written — see abandonOrphan() below for why that state
    // exists and why it needs its own door.
    if (documentId !== undefined && abandonedKey !== undefined) {
      return json({ error: "Send document_id or file_key, not both" }, 400);
    }

    if (!(await callerIsActive(ctx.supabase))) {
      return json({ error: "Account is not active" }, 403);
    }

    if (typeof abandonedKey === "string") {
      return abandonOrphan(
        ctx.supabase,
        ctx.supabaseAdmin as unknown as AdminSurface,
        userId,
        abandonedKey,
      );
    }

    if (!isPositiveInt(documentId)) {
      return json({ error: "document_id must be a positive integer" }, 400);
    }

    // Caller-scoped, so the select policy decides visibility. Read before the
    // delete because the delete is what makes file_key unfindable, and the
    // object cannot be removed without it.
    const { data: document, error } = await ctx.supabase
      .from("documents")
      .select("file_key, file_name, agent_id, owner_type, owner_id")
      .eq("id", documentId)
      .maybeSingle();

    if (error || !document) {
      // Not found and not yours, indistinguishable — as everywhere else here.
      return json({ error: "Document not found" }, 404);
    }

    // Load-bearing, and for a sharper reason than in create-download-url. There,
    // a forged file_key leaked someone else's file; here it would DESTROY it.
    // file_key is written by the browser, so without this check an agent could
    // insert a row of their own carrying another agent's key and delete that
    // agent's object — the same forgery, but not recoverable.
    if (
      !fileKeyMatchesOwner(
        document.file_key,
        document.agent_id,
        document.owner_type,
        document.owner_id,
      )
    ) {
      console.error(
        `[delete-document] file_key does not match its row: document ${documentId}`,
      );
      return json({ error: "Document not found" }, 404);
    }

    // Audited before anything is destroyed, and it fails closed: nothing has
    // been handed over or removed yet, so refusing is the safe answer. Same
    // reasoning as create-download-url and read-pre-app-secrets.
    const { error: auditError } = await ctx.supabaseAdmin
      .from("audit_log")
      .insert({
        actor_id: userId,
        action: "delete_document",
        table_name: "documents",
        row_id: String(documentId),
      });
    if (auditError) {
      console.error(`[delete-document] audit write: ${auditError.message}`);
      return json({ error: "Could not record the deletion" }, 500);
    }

    // The row first, through the CALLER's client, so the delete policy is what
    // authorizes it rather than a hand-written role branch here. (It also fires
    // log_cross_agent_change(), which is how an admin removing a rep's document
    // gets into the trail.)
    //
    // Row-then-object, not object-then-row. If the object removal fails the
    // result is an orphaned object: invisible, unreachable without the service
    // role, and no worse than what this function was written to fix. The other
    // order can leave a row whose bytes are gone — a document that lists, opens
    // a download and 404s, which looks like a broken app rather than a cleanup
    // task.
    const { error: rowError, count } = await ctx.supabase
      .from("documents")
      .delete({ count: "exact" })
      .eq("id", documentId);

    if (rowError) {
      return json({ error: `Could not remove: ${rowError.message}` }, 500);
    }
    if (count === 0) {
      // Visible under the select policy but not deletable under the delete
      // policy. The two are identical today, so this is unreachable — it is here
      // because the alternative is reporting a deletion that did not happen.
      return json({ error: "Document not found" }, 404);
    }

    const { error: objectError } = await ctx.supabaseAdmin.storage
      .from(STORAGE_BUCKET)
      .remove([document.file_key as string]);

    // Reported rather than raised. The row is already gone and a retry cannot
    // put it back, so a 500 here would tell the rep the removal failed when the
    // part they can see succeeded. Named the same way submit-pre-app-secrets
    // reports auditWriteFailed: the caller gets to know the operation was
    // partial without being told it failed.
    if (objectError) {
      console.error(`[delete-document] storage remove: ${objectError.message}`);
      return json({
        deleted: true,
        fileName: document.file_name ?? null,
        storageDeleteFailed: true,
      });
    }

    return json({ deleted: true, fileName: document.file_name ?? null });
  }),
};

/**
 * Removes an object whose metadata row was never written.
 *
 * Uploading is three steps — sign, PUT the bytes, insert the row — and only the
 * middle one is atomic. If the browser dies or the network drops between the PUT
 * and the insert, the bytes are in the bucket with nothing pointing at them: an
 * orphan, invisible to every page and unreachable without the service role. The
 * document simply never appears, so the rep uploads it again, and the abandoned
 * copy stays for the life of the project. Without this the panel has no way to
 * clean up after its own failure, because deleting an object needs a privilege
 * the browser does not have.
 *
 * Authorization comes from the key itself, which is safe only because the key is
 * structured: {agent_id}/{owner_type}/{owner_id}/{uuid}. So the parent record is
 * looked up through the CALLER's client — RLS answers "may you touch this
 * record?" exactly as it does on the upload path — and the key's agent segment
 * must be that record's owner. A caller who cannot see the parent gets the same
 * 404 they would get from create-upload-url.
 *
 * The two guards that keep this from being a delete-anything primitive:
 *
 *   1. The parent record must be visible to the caller AND own the key's prefix,
 *      so the reachable keys are exactly the ones create-upload-url would sign
 *      for this caller.
 *   2. No documents row may reference the key. Otherwise this becomes a way to
 *      destroy a live document's bytes while leaving its row behind — a
 *      document that lists, offers a download and 404s. Deleting a real document
 *      goes through the document_id path, where the row goes first.
 */
async function abandonOrphan(
  supabase: QueryClient,
  supabaseAdmin: AdminSurface,
  userId: string,
  fileKey: string,
): Promise<Response> {
  const parsed = parseFileKey(fileKey);
  if (!parsed || !isOwnerType(parsed.ownerType)) {
    return json({ error: "Not a document key" }, 400);
  }

  const parentAgentId = await resolveParentAgentId(
    supabase,
    parsed.ownerType,
    parsed.ownerId,
  );
  // Not visible, doesn't exist, or the key claims an agent who does not own the
  // record — one answer for all three, so this can't be used to probe either
  // ids or keys.
  if (!parentAgentId || parentAgentId !== parsed.agentId) {
    return json({ error: "Owner record not found" }, 404);
  }

  // Read as the caller: a row they cannot see is still a row, and the point is
  // that this key must belong to NO row at all.
  const { data: claiming } = await supabase
    .from("documents")
    .select("id")
    .eq("file_key", fileKey)
    .maybeSingle();
  if (claiming) {
    return json(
      { error: "That file is attached to a document — remove the document" },
      409,
    );
  }

  const { error: auditError } = await supabaseAdmin
    .from("audit_log")
    .insert({
      actor_id: userId,
      action: "abandon_document_upload",
      table_name: "documents",
      // No documents id to name, so the owner record is recorded instead —
      // exactly the choice create-upload-url makes, and about the same event
      // seen from the other end.
      row_id: String(parsed.ownerId),
    });
  if (auditError) {
    console.error(`[delete-document] audit write: ${auditError.message}`);
    return json({ error: "Could not record the deletion" }, 500);
  }

  const { error: objectError } = await supabaseAdmin.storage
    .from(STORAGE_BUCKET)
    .remove([fileKey]);
  if (objectError) {
    console.error(`[delete-document] storage remove: ${objectError.message}`);
    return json({ error: "Could not remove the file" }, 500);
  }

  return json({ deleted: true, abandoned: true });
}

/* To invoke locally:

  1. Run `supabase start`
  2. Sign in to get a user access token, then:

  curl -i --location --request POST 'http://127.0.0.1:54321/functions/v1/delete-document' \
    --header 'Authorization: Bearer <USER_ACCESS_TOKEN>' \
    --header 'Content-Type: application/json' \
    --data '{"document_id":1}'

  Expected: 200 with { deleted: true, fileName }
            404 if that document isn't yours (same as if it didn't exist)
            403 if your profile is deactivated
*/
