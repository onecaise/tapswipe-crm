// Real invocations of create-upload-url and create-download-url against a
// running local stack (`supabase start` + `supabase functions serve`).
//
// Run with:  npm run test:live
//
// These are not RLS tests. tests/rls/documents.test.ts already proves what the
// policies do, including the gap they deliberately leave open: the insert policy
// checks documents.agent_id and says nothing about whether owner_id points at a
// record the uploader owns. Closing that gap is the create-upload-url function's
// only reason to exist, and it lives in Deno, behind JWT verification, in front
// of Storage — none of which PGlite can execute. So the assertions here are on
// HTTP status codes and response bodies from the actual endpoints.
//
// Every case logs its real status and body, so a run is readable as evidence
// rather than just a row of green ticks.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  BUCKET,
  type Fixtures,
  functionsAreServed,
  adminClient,
  anonClient,
  invoke,
  provisionFixtures,
  warmFunctions,
  teardownFixtures,
  toReachableUrl,
  userClient,
} from "./helpers/stack";

let fx: Fixtures;

/**
 * Fails loudly rather than skipping when the stack is down.
 *
 * A live suite that silently reports "0 failed" because nothing was listening
 * is worse than no suite at all, so this file is excluded from the default
 * `npm test` (see vitest.live.config.mts) and hard-errors when invoked without
 * its dependencies.
 */
beforeAll(async () => {
  if (!(await functionsAreServed())) {
    throw new Error(
      "No Edge Function runtime answering on the local stack.\n" +
        "Run `npx supabase start` and `npx supabase functions serve` first.",
    );
  }
  // Before any status-code assertion: the CLI writes a `.npmrc` into a
  // function's directory on its first invocation, its watcher sees the write,
  // and the runtime restarts — 502-ing whatever is in flight. On a cold
  // `functions serve` that turns this whole file red with "expected 502 to be
  // 200", which says nothing about the functions themselves.
  await warmFunctions(["create-upload-url", "create-download-url"]);
  fx = await provisionFixtures();
});

afterAll(async () => {
  await teardownFixtures();
});

/** Prints the verbatim response so the run output shows what actually came back. */
function report(label: string, status: number, body: unknown): void {
  console.log(`  ${label} -> ${status} ${JSON.stringify(body)}`);
}

describe("auth config", () => {
  // These two settings look like a pair and are not. [auth].enable_signup is
  // what blocks self-service accounts; [auth.email].enable_signup is the email
  // provider's on/off switch, so turning it off to "double-lock" sign-up takes
  // password LOGIN down with it — the whole app, since that's the only way in.
  // Both halves are asserted here because the mistake is invisible in review.
  it("accepts password sign-in for a provisioned user", async () => {
    const { data, error } = await anonClient().auth.signInWithPassword({
      email: "live-owner@tapswipe.test",
      password: "live-test-password-123",
    });
    report("signInWithPassword", error ? 0 : 200, {
      error: error?.message ?? null,
      hasSession: Boolean(data.session),
    });

    expect(error).toBeNull();
    expect(data.session?.access_token).toBeTruthy();
  });

  it("refuses self-service sign-up", async () => {
    const { data, error } = await anonClient().auth.signUp({
      email: "live-walkup@tapswipe.test",
      password: "live-test-password-123",
    });
    report("signUp", error?.status ?? 200, {
      error: error?.message ?? null,
      user: data.user?.id ?? null,
    });

    // Accounts come from the create-user Edge Function only. A walk-up signup
    // would produce an auth.users row with no profiles row: able to log in,
    // able to see nothing, with no way to self-heal.
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/signups not allowed|disabled/i);
    expect(data.user).toBeNull();
  });
});

describe("create-upload-url", () => {
  it("mints a URL for the owner agent against their own merchant", async () => {
    const { status, body, raw } = await invoke(
      "create-upload-url",
      { owner_type: "merchant", owner_id: fx.merchantIds.owner },
      fx.tokens.owner,
    );
    report("owner -> own merchant", status, body);

    expect(status, raw).toBe(200);
    expect(body.token).toBeTruthy();
    expect(body.signedUrl).toBeTruthy();
    expect(body.agentId).toBe(fx.userIds.owner);
    // The key encodes the parent record's owner, so ownership is auditable from
    // the storage path alone.
    expect(body.fileKey).toMatch(
      new RegExp(`^${fx.userIds.owner}/merchant/${fx.merchantIds.owner}/`),
    );
  });

  it("rejects an agent pointing at another agent's merchant", async () => {
    const { status, body, raw } = await invoke(
      "create-upload-url",
      { owner_type: "merchant", owner_id: fx.merchantIds.owner },
      fx.tokens.intruder,
    );
    report("intruder -> owner's merchant", status, body);

    // 404, not 403: "not yours" and "doesn't exist" have to be the same answer
    // or the endpoint becomes an id oracle.
    expect(status, raw).toBe(404);
    expect(body.error).toBe("Owner record not found");
  });

  it("rejects a deactivated agent against their own merchant", async () => {
    const { status, body, raw } = await invoke(
      "create-upload-url",
      { owner_type: "merchant", owner_id: fx.merchantIds.deactivated },
      fx.tokens.deactivated,
    );
    report("deactivated -> own merchant", status, body);

    // Their own merchant on purpose. Aimed at someone else's it would 404 for
    // the wrong reason and the deactivation check could rot unnoticed.
    expect(status, raw).toBe(403);
    expect(body.error).toBe("Account is not active");
  });

  it("rejects an owner_id that does not exist", async () => {
    const { status, body, raw } = await invoke(
      "create-upload-url",
      { owner_type: "merchant", owner_id: fx.missingId },
      fx.tokens.owner,
    );
    report("owner -> nonexistent merchant", status, body);

    expect(status, raw).toBe(404);
    expect(body.error).toBe("Owner record not found");
  });

  it("lets an admin upload against any agent's merchant", async () => {
    const { status, body, raw } = await invoke(
      "create-upload-url",
      { owner_type: "merchant", owner_id: fx.merchantIds.intruder },
      fx.tokens.admin,
    );
    report("admin -> another agent's merchant", status, body);

    expect(status, raw).toBe(200);
    // Filed under the rep who owns the merchant, not under the admin who
    // uploaded it — otherwise the object lands outside the rep's prefix and the
    // documents row would be owned by the wrong person.
    expect(body.agentId).toBe(fx.userIds.intruder);
    expect(body.fileKey).toMatch(new RegExp(`^${fx.userIds.intruder}/merchant/`));
  });

  it("rejects an unauthenticated caller", async () => {
    const { status, body } = await invoke("create-upload-url", {
      owner_type: "merchant",
      owner_id: fx.merchantIds.owner,
    });
    report("no token -> owner's merchant", status, body);

    // verify_jwt = false in config.toml, so this 401 is the function's own doing.
    expect(status).toBe(401);
  });

  it("rejects a malformed body before touching the database", async () => {
    const bad = await invoke(
      "create-upload-url",
      { owner_type: "ghost_sheet", owner_id: fx.merchantIds.owner },
      fx.tokens.owner,
    );
    report("owner -> unsupported owner_type", bad.status, bad.body);
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe("Unknown owner_type");

    const negative = await invoke(
      "create-upload-url",
      { owner_type: "merchant", owner_id: -1 },
      fx.tokens.owner,
    );
    report("owner -> owner_id = -1", negative.status, negative.body);
    expect(negative.status).toBe(400);
  });
});

describe("create-download-url", () => {
  it("mints a URL for the owner agent against their own document", async () => {
    const { status, body, raw } = await invoke(
      "create-download-url",
      { document_id: fx.documentIds.owner },
      fx.tokens.owner,
    );
    report("owner -> own document", status, body);

    expect(status, raw).toBe(200);
    expect(String(body.signedUrl)).toContain("/object/sign/");
    expect(body.expiresIn).toBe(60);
    expect(body.fileName).toBe("live-owner.txt");
  });

  it("rejects an agent pointing at another agent's document", async () => {
    const { status, body, raw } = await invoke(
      "create-download-url",
      { document_id: fx.documentIds.owner },
      fx.tokens.intruder,
    );
    report("intruder -> owner's document", status, body);

    expect(status, raw).toBe(404);
    expect(body.error).toBe("Document not found");
  });

  it("rejects a deactivated agent against their own document", async () => {
    const { status, body, raw } = await invoke(
      "create-download-url",
      { document_id: fx.documentIds.deactivated },
      fx.tokens.deactivated,
    );
    report("deactivated -> own document", status, body);

    expect(status, raw).toBe(403);
    expect(body.error).toBe("Account is not active");
  });

  it("rejects a document_id that does not exist", async () => {
    const { status, body, raw } = await invoke(
      "create-download-url",
      { document_id: fx.missingId },
      fx.tokens.owner,
    );
    report("owner -> nonexistent document", status, body);

    expect(status, raw).toBe(404);
    expect(body.error).toBe("Document not found");
  });

  it("lets an admin download any agent's document", async () => {
    const { status, body, raw } = await invoke(
      "create-download-url",
      { document_id: fx.documentIds.intruder },
      fx.tokens.admin,
    );
    report("admin -> another agent's document", status, body);

    expect(status, raw).toBe(200);
    expect(String(body.signedUrl)).toContain("/object/sign/");
  });

  it("rejects an unauthenticated caller", async () => {
    const { status, body } = await invoke("create-download-url", {
      document_id: fx.documentIds.owner,
    });
    report("no token -> owner's document", status, body);

    expect(status).toBe(401);
  });
});

describe("document access is audited", () => {
  // §10 promises an audit trail for sensitive-data access, and until the security
  // audit these two functions were the gap: an admin could mint a signed URL for
  // any rep's driver's licence or voided cheque and leave no trace. The bytes
  // leave through the URL, so the mint is the event worth recording — auditing
  // only the documents row would miss every read.
  it("records who was granted a download URL", async () => {
    const admin = adminClient();
    await admin
      .from("audit_log")
      .delete()
      .eq("action", "download_document")
      .eq("row_id", String(fx.documentIds.owner));

    const { status, raw } = await invoke(
      "create-download-url",
      { document_id: fx.documentIds.owner },
      // The admin, not the owner: the cross-agent case is the one that matters.
      fx.tokens.admin,
    );
    expect(status, raw).toBe(200);

    const { data } = await admin
      .from("audit_log")
      .select("actor_id, action, table_name, row_id")
      .eq("action", "download_document")
      .eq("row_id", String(fx.documentIds.owner));

    expect(data).toEqual([
      {
        actor_id: fx.userIds.admin,
        action: "download_document",
        table_name: "documents",
        row_id: String(fx.documentIds.owner),
      },
    ]);
  });

  it("records who was granted an upload URL", async () => {
    const admin = adminClient();
    // Cleared first: an earlier case in this file already minted an upload URL
    // for the SAME merchant as the owner, so without this the assertion below
    // reads that row and reports the owner's id where the admin's was expected.
    await admin
      .from("audit_log")
      .delete()
      .eq("action", "upload_document:merchant")
      .eq("row_id", String(fx.merchantIds.owner));

    const { status, raw } = await invoke(
      "create-upload-url",
      { owner_type: "merchant", owner_id: fx.merchantIds.owner },
      fx.tokens.admin,
    );
    expect(status, raw).toBe(200);

    // row_id is the owner record, not a documents id: the documents row does not
    // exist yet and may never be inserted, so what actually happened here is a
    // grant of write access to a parent record.
    const { data } = await admin
      .from("audit_log")
      .select("actor_id, action, row_id")
      .eq("action", "upload_document:merchant")
      .eq("row_id", String(fx.merchantIds.owner));

    expect(data?.length ?? 0).toBeGreaterThan(0);
    expect(data?.[0].actor_id).toBe(fx.userIds.admin);
  });
});

describe("round trip through Storage", () => {
  it("uploads bytes with the minted token and reads them back", async () => {
    // 1. Ask for an upload URL as the owning agent.
    const upload = await invoke(
      "create-upload-url",
      { owner_type: "merchant", owner_id: fx.merchantIds.owner },
      fx.tokens.owner,
    );
    report("round trip: create-upload-url", upload.status, {
      fileKey: upload.body.fileKey,
    });
    expect(upload.status, upload.raw).toBe(200);

    // 2. PUT the bytes with the token. Only the path + token are used, not the
    //    returned signedUrl, whose host is the container-internal one.
    const payload = "round-trip bytes written by the live suite";
    const { error: putError } = await anonClient()
      .storage.from(BUCKET)
      .uploadToSignedUrl(
        upload.body.fileKey as string,
        upload.body.token as string,
        new Blob([payload], { type: "text/plain" }),
      );
    report("round trip: uploadToSignedUrl", putError ? 0 : 200, {
      error: putError?.message ?? null,
    });
    expect(putError).toBeNull();

    // 3. Record the metadata the way the app does — through the agent's own
    //    client, so the documents insert policy applies.
    const { data: row, error: insertError } = await userClient(fx.tokens.owner)
      .from("documents")
      .insert({
        agent_id: upload.body.agentId as string,
        owner_type: "merchant",
        owner_id: fx.merchantIds.owner,
        doc_type: "Signed application",
        file_key: upload.body.fileKey as string,
        file_name: "round-trip.txt",
        mime_type: "text/plain",
      })
      .select("id")
      .single();
    report("round trip: insert documents row", insertError ? 0 : 201, {
      id: row?.id ?? null,
      error: insertError?.message ?? null,
    });
    expect(insertError).toBeNull();

    // 4. Sign a download for it and fetch the bytes back.
    const download = await invoke(
      "create-download-url",
      { document_id: row!.id },
      fx.tokens.owner,
    );
    expect(download.status, download.raw).toBe(200);

    const fetched = await fetch(toReachableUrl(download.body.signedUrl as string));
    const text = await fetched.text();
    report("round trip: GET signed download", fetched.status, {
      bytes: text.length,
    });

    expect(fetched.status).toBe(200);
    expect(text).toBe(payload);
  });

  it("does not let another agent use a signed download URL's document id", async () => {
    // The signed URL itself is a bearer capability once minted — the control is
    // that a stranger can never get one. Proven by asking as the intruder for
    // the document the previous test created.
    const { data: rows } = await userClient(fx.tokens.owner)
      .from("documents")
      .select("id")
      .eq("file_name", "round-trip.txt");
    const documentId = rows?.[0]?.id as number;
    expect(documentId).toBeGreaterThan(0);

    const { status, body } = await invoke(
      "create-download-url",
      { document_id: documentId },
      fx.tokens.intruder,
    );
    report("intruder -> round-trip document", status, body);

    expect(status).toBe(404);
  });
});
