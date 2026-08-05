// Mints a short-lived signed upload URL for the private `documents` bucket.
//
// verify_jwt = false in config.toml, so this function authenticates the caller
// itself — withSupabase({ auth: "user" }) rejects a missing or invalid JWT
// before the handler runs.
//
// Order matters here. The caller must be (1) authenticated, (2) an active
// profile, and (3) able to see the parent record they're attaching to, before
// the admin client is used for anything. supabaseAdmin bypasses RLS, so it's
// only reached once authorization is settled, and only to mint the URL.

import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";

import {
  STORAGE_BUCKET,
  buildFileKey,
  callerIsActive,
  isOwnerType,
  isPositiveInt,
  json,
  resolveParentAgentId,
} from "../_shared/documents.ts";

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

    const ownerType = body.owner_type;
    const ownerId = body.owner_id;

    if (!isOwnerType(ownerType)) {
      return json({ error: "Unknown owner_type" }, 400);
    }
    if (!isPositiveInt(ownerId)) {
      return json({ error: "owner_id must be a positive integer" }, 400);
    }

    // A valid JWT proves who the caller is, not that their account is still
    // enabled — a deactivated agent's token keeps working until it expires.
    if (!(await callerIsActive(ctx.supabase))) {
      return json({ error: "Account is not active" }, 403);
    }

    // Per-owner_type ownership check, through the RLS-scoped client so the
    // agent_id comparison and is_active_agent() gating come from the same
    // policies the rest of the app uses. documents.owner_id has no foreign key,
    // so without this an agent could attach a file to another agent's merchant.
    const parentAgentId = await resolveParentAgentId(
      ctx.supabase,
      ownerType,
      ownerId,
    );
    if (!parentAgentId) {
      // Not found and not yours are the same answer, so this can't be used to
      // discover which ids exist.
      return json({ error: "Owner record not found" }, 404);
    }

    const fileKey = buildFileKey(
      parentAgentId,
      ownerType,
      ownerId,
      crypto.randomUUID(),
    );

    // Only now is the service-role client used, and only to sign.
    const { data, error } = await ctx.supabaseAdmin.storage
      .from(STORAGE_BUCKET)
      .createSignedUploadUrl(fileKey);

    if (error || !data) {
      return json(
        { error: `Could not create upload URL: ${error?.message ?? "unknown"}` },
        500,
      );
    }

    // agentId is returned so the caller writes the same value into
    // documents.agent_id that appears in the key — otherwise an admin uploading
    // for a rep would file the object under the rep but own the row themselves.
    return json({
      path: data.path,
      token: data.token,
      signedUrl: data.signedUrl,
      fileKey,
      agentId: parentAgentId,
    });
  }),
};

/* To invoke locally:

  1. Run `supabase start`
  2. Sign in to get a user access token, then:

  curl -i --location --request POST 'http://127.0.0.1:54321/functions/v1/create-upload-url' \
    --header 'Authorization: Bearer <USER_ACCESS_TOKEN>' \
    --header 'Content-Type: application/json' \
    --data '{"owner_type":"merchant","owner_id":1}'

  Expected: 200 with { path, token, signedUrl, fileKey, agentId }
            404 if that merchant isn't yours (same as if it didn't exist)
            403 if your profile is deactivated
*/
