// The document surface end to end, against a running local stack
// (`supabase start` + `supabase functions serve`).
//
// Run with:  npm run test:live
//
// document-urls.test.ts covers the authorization matrix for one owner type
// (merchant) and one function each way. This file covers everything that turned
// out not to follow from that:
//
//   * all FOUR owner types, because each one resolves its parent through a
//     different table and only merchant was ever exercised;
//   * the forged-file_key read, which was a live cross-agent leak;
//   * delete-document, which exists because a metadata-only delete left the
//     bytes in the bucket;
//   * signed-URL expiry, actually waited out rather than assumed;
//   * the file edge cases — zero bytes, over the size cap, duplicate names,
//     awkward characters, types that would be dangerous if served inline.
//
// Every case logs its real status and body, so a run reads as evidence.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  BUCKET,
  type Fixtures,
  MAX_DOCUMENT_BYTES,
  OWNER_TYPES,
  type OwnerType,
  adminClient,
  anonClient,
  functionsAreServed,
  invoke,
  provisionFixtures,
  teardownFixtures,
  toReachableUrl,
  userClient,
  warmFunctions,
} from "./helpers/stack";

let fx: Fixtures;

beforeAll(async () => {
  if (!(await functionsAreServed())) {
    throw new Error(
      "No Edge Function runtime answering on the local stack.\n" +
        "Run `npx supabase start` and `npx supabase functions serve` first.",
    );
  }
  await warmFunctions([
    "create-upload-url",
    "create-download-url",
    "delete-document",
  ]);
  fx = await provisionFixtures();
});

afterAll(async () => {
  await teardownFixtures();
});

function report(label: string, status: number, body: unknown): void {
  console.log(`  ${label} -> ${status} ${JSON.stringify(body)}`);
}

/**
 * Does what the browser does: sign, PUT the bytes, insert the metadata row.
 *
 * Deliberately assembled from the same three steps components/documents-panel.tsx
 * uses rather than short-cut with the service role — the point of most of these
 * assertions is what a real caller can and cannot do, and a fixture that wrote
 * the row as the platform owner would bypass both the insert policy and the
 * file_key constraint.
 */
async function uploadAsUser(
  token: string,
  ownerType: OwnerType,
  ownerId: number,
  file: { body: BodyInit; name: string; type?: string },
): Promise<{
  documentId: number | null;
  fileKey: string | null;
  putError: string | null;
  insertError: string | null;
  signStatus: number;
}> {
  const signed = await invoke(
    "create-upload-url",
    { owner_type: ownerType, owner_id: ownerId },
    token,
  );
  if (signed.status !== 200) {
    return {
      documentId: null,
      fileKey: null,
      putError: null,
      insertError: null,
      signStatus: signed.status,
    };
  }

  const fileKey = signed.body.fileKey as string;

  // Only the path + token are used, not the returned signedUrl — its host is the
  // container-internal one.
  const { error: putError } = await anonClient()
    .storage.from(BUCKET)
    .uploadToSignedUrl(fileKey, signed.body.token as string, file.body as Blob);
  if (putError) {
    return {
      documentId: null,
      fileKey,
      putError: putError.message,
      insertError: null,
      signStatus: 200,
    };
  }

  const { data: row, error: insertError } = await userClient(token)
    .from("documents")
    .insert({
      agent_id: signed.body.agentId as string,
      owner_type: ownerType,
      owner_id: ownerId,
      doc_type: "Statement",
      file_key: fileKey,
      file_name: file.name,
      mime_type: file.type ?? null,
    })
    .select("id")
    .single();

  return {
    documentId: (row?.id as number | undefined) ?? null,
    fileKey,
    putError: null,
    insertError: insertError?.message ?? null,
    signStatus: 200,
  };
}

/** True when the object is still in the bucket. */
async function objectExists(fileKey: string): Promise<boolean> {
  const parts = fileKey.split("/");
  const name = parts.pop() as string;
  const { data } = await adminClient()
    .storage.from(BUCKET)
    .list(parts.join("/"), { limit: 1000 });
  return (data ?? []).some((o) => o.name === name);
}

describe("every owner type round-trips", () => {
  // documents.owner_type has allowed four values since the initial schema, and
  // create-upload-url has a per-type table map to resolve each one's agent_id —
  // four code paths, of which the test suite exercised one. `support_ticket` had
  // no UI at all until this pass, so it had never been uploaded to from
  // anywhere.
  for (const ownerType of OWNER_TYPES) {
    it(`uploads and downloads against a ${ownerType}`, async () => {
      const payload = `bytes for ${ownerType}`;
      const result = await uploadAsUser(
        fx.tokens.owner,
        ownerType,
        fx.ownerIds.owner[ownerType],
        { body: new Blob([payload], { type: "text/plain" }), name: `${ownerType}.txt`, type: "text/plain" },
      );
      report(`owner -> own ${ownerType}`, result.signStatus, {
        fileKey: result.fileKey,
        putError: result.putError,
        insertError: result.insertError,
      });

      expect(result.signStatus).toBe(200);
      expect(result.putError).toBeNull();
      expect(result.insertError).toBeNull();
      expect(result.documentId).toBeGreaterThan(0);
      // The key encodes the owner triple, which is what
      // documents_file_key_matches_owner and fileKeyMatchesOwner both check.
      expect(result.fileKey).toMatch(
        new RegExp(
          `^${fx.userIds.owner}/${ownerType}/${fx.ownerIds.owner[ownerType]}/`,
        ),
      );

      const download = await invoke(
        "create-download-url",
        { document_id: result.documentId },
        fx.tokens.owner,
      );
      expect(download.status, download.raw).toBe(200);

      const fetched = await fetch(
        toReachableUrl(download.body.signedUrl as string),
      );
      expect(fetched.status).toBe(200);
      expect(await fetched.text()).toBe(payload);
    });

    it(`refuses an agent aiming at another agent's ${ownerType}`, async () => {
      const { status, body } = await invoke(
        "create-upload-url",
        { owner_type: ownerType, owner_id: fx.ownerIds.intruder[ownerType] },
        fx.tokens.owner,
      );
      report(`owner -> intruder's ${ownerType}`, status, body);

      // 404, not 403: "not yours" and "doesn't exist" have to be one answer.
      expect(status).toBe(404);
      expect(body.error).toBe("Owner record not found");
    });

    it(`refuses a deactivated agent against their own ${ownerType}`, async () => {
      const { status, body } = await invoke(
        "create-upload-url",
        { owner_type: ownerType, owner_id: fx.ownerIds.deactivated[ownerType] },
        fx.tokens.deactivated,
      );
      report(`deactivated -> own ${ownerType}`, status, body);

      // Their OWN record, so this is testing deactivation and not ownership.
      expect(status).toBe(403);
      expect(body.error).toBe("Account is not active");
    });

    it(`lets an admin upload against another agent's ${ownerType}`, async () => {
      const { status, body } = await invoke(
        "create-upload-url",
        { owner_type: ownerType, owner_id: fx.ownerIds.owner[ownerType] },
        fx.tokens.admin,
      );
      report(`admin -> owner's ${ownerType}`, status, body);

      expect(status).toBe(200);
      // Filed under the rep who owns the record, not the admin who uploaded —
      // otherwise the object lands outside the rep's prefix, the row is owned by
      // the wrong person, and (since the support ticket panel shows the parent's
      // documents) the rep cannot see what was uploaded for them.
      expect(body.agentId).toBe(fx.userIds.owner);
      expect(body.fileKey).toMatch(
        new RegExp(`^${fx.userIds.owner}/${ownerType}/`),
      );
    });
  }
});

describe("a forged documents row cannot be used to read", () => {
  it("refuses to store a row carrying another agent's file_key", async () => {
    // THE bug this pass found, reproduced at the layer that now stops it.
    //
    // Before documents_file_key_matches_owner: the intruder inserted a row with
    // agent_id = themselves (satisfying the insert policy, which is the only
    // thing that looked at anything) and file_key = an object belonging to the
    // owner. create-download-url resolved the row through the intruder's own
    // client, RLS said yes because the ROW was theirs, and it signed the key it
    // found with the service role. Measured: HTTP 200 and the owner's bytes.
    const { data: victim } = await adminClient()
      .from("documents")
      .select("file_key")
      .eq("id", fx.documentIds.owner)
      .single();
    const victimKey = victim?.file_key as string;
    expect(victimKey.startsWith(fx.userIds.owner)).toBe(true);

    const { error } = await userClient(fx.tokens.intruder)
      .from("documents")
      .insert({
        agent_id: fx.userIds.intruder,
        owner_type: "merchant",
        owner_id: fx.ownerIds.intruder.merchant,
        doc_type: "Forged",
        file_key: victimKey,
        file_name: "stolen.txt",
      });
    report("intruder inserts row with owner's file_key", error ? 400 : 201, {
      error: error?.message ?? null,
    });

    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/documents_file_key_matches_owner/);

    // And nothing landed, so there is no row for create-download-url to sign.
    const { count } = await adminClient()
      .from("documents")
      .select("id", { count: "exact", head: true })
      .eq("file_name", "stolen.txt");
    expect(count ?? 0).toBe(0);
  });

  it("refuses to store a row planted on another agent's record", async () => {
    // The same forgery aimed at owner_id rather than file_key. An admin reading
    // the victim's merchant page would have seen the planted document listed as
    // that rep's. Closed by the same constraint, because the key encodes
    // owner_id too.
    const signed = await invoke(
      "create-upload-url",
      { owner_type: "merchant", owner_id: fx.ownerIds.intruder.merchant },
      fx.tokens.intruder,
    );
    expect(signed.status, signed.raw).toBe(200);

    const { error } = await userClient(fx.tokens.intruder)
      .from("documents")
      .insert({
        agent_id: fx.userIds.intruder,
        owner_type: "merchant",
        // A key legitimately signed for their OWN merchant, filed against
        // somebody else's.
        owner_id: fx.ownerIds.owner.merchant,
        doc_type: "Planted",
        file_key: signed.body.fileKey as string,
        file_name: "planted.txt",
      });
    report("intruder plants row on owner's merchant", error ? 400 : 201, {
      error: error?.message ?? null,
    });

    expect(error?.message).toMatch(/documents_file_key_matches_owner/);
  });
});

describe("delete-document removes the bytes too", () => {
  it("deletes the row AND the storage object", async () => {
    const uploaded = await uploadAsUser(
      fx.tokens.owner,
      "merchant",
      fx.ownerIds.owner.merchant,
      { body: new Blob(["delete me"]), name: "deleteme.txt" },
    );
    expect(uploaded.documentId).toBeGreaterThan(0);
    expect(await objectExists(uploaded.fileKey as string)).toBe(true);

    const { status, body } = await invoke(
      "delete-document",
      { document_id: uploaded.documentId },
      fx.tokens.owner,
    );
    report("owner deletes own document", status, body);

    expect(status).toBe(200);
    expect(body.deleted).toBe(true);
    expect(body.storageDeleteFailed).toBeUndefined();

    const { count } = await adminClient()
      .from("documents")
      .select("id", { count: "exact", head: true })
      .eq("id", uploaded.documentId);
    expect(count ?? 0).toBe(0);

    // The assertion the old metadata-only delete could never have passed. It is
    // read through the SERVICE ROLE on purpose: an orphaned object is invisible
    // to every client, which is exactly why it went unnoticed.
    expect(await objectExists(uploaded.fileKey as string)).toBe(false);
  });

  it("refuses to delete another agent's document", async () => {
    const { status, body } = await invoke(
      "delete-document",
      { document_id: fx.documentIds.owner },
      fx.tokens.intruder,
    );
    report("intruder deletes owner's document", status, body);

    expect(status).toBe(404);
    expect(body.error).toBe("Document not found");

    // Still there — a 404 that had already deleted something would be worse than
    // a 200.
    const { count } = await adminClient()
      .from("documents")
      .select("id", { count: "exact", head: true })
      .eq("id", fx.documentIds.owner);
    expect(count).toBe(1);
  });

  it("refuses a deactivated agent deleting their own document", async () => {
    const { status, body } = await invoke(
      "delete-document",
      { document_id: fx.documentIds.deactivated },
      fx.tokens.deactivated,
    );
    report("deactivated deletes own document", status, body);

    expect(status).toBe(403);
    expect(body.error).toBe("Account is not active");
  });

  it("refuses an unauthenticated caller", async () => {
    const { status } = await invoke("delete-document", {
      document_id: fx.documentIds.owner,
    });
    // verify_jwt = false in config.toml, so this 401 is the function's own doing.
    expect(status).toBe(401);
  });

  it("lets an admin delete a rep's document, object and all", async () => {
    const uploaded = await uploadAsUser(
      fx.tokens.owner,
      "lead",
      fx.ownerIds.owner.lead,
      { body: new Blob(["admin will remove this"]), name: "admin-removes.txt" },
    );
    expect(uploaded.documentId).toBeGreaterThan(0);

    const { status, body } = await invoke(
      "delete-document",
      { document_id: uploaded.documentId },
      fx.tokens.admin,
    );
    report("admin deletes rep's document", status, body);

    expect(status).toBe(200);
    expect(await objectExists(uploaded.fileKey as string)).toBe(false);
  });

  it("records the deletion in audit_log", async () => {
    const uploaded = await uploadAsUser(
      fx.tokens.owner,
      "merchant",
      fx.ownerIds.owner.merchant,
      { body: new Blob(["audited"]), name: "audited-delete.txt" },
    );
    const documentId = uploaded.documentId as number;

    const { status } = await invoke(
      "delete-document",
      { document_id: documentId },
      // The admin, not the owner: a cross-agent removal is the one that has to
      // leave a trace.
      fx.tokens.admin,
    );
    expect(status).toBe(200);

    const { data } = await adminClient()
      .from("audit_log")
      .select("actor_id, action, table_name, row_id")
      .eq("action", "delete_document")
      .eq("row_id", String(documentId));

    expect(data).toEqual([
      {
        actor_id: fx.userIds.admin,
        action: "delete_document",
        table_name: "documents",
        row_id: String(documentId),
      },
    ]);
  });
});

describe("abandoned uploads can be cleaned up", () => {
  // The three-step upload is not atomic: sign, PUT, insert. A drop between the
  // PUT and the insert leaves bytes in the bucket that no row points at —
  // invisible to every page, and unreachable without the service role, so the
  // rep uploads again and the abandoned copy stays for good. The panel calls
  // this to clean up after its own failure.
  it("removes an object whose row was never written", async () => {
    const signed = await invoke(
      "create-upload-url",
      { owner_type: "merchant", owner_id: fx.ownerIds.owner.merchant },
      fx.tokens.owner,
    );
    const fileKey = signed.body.fileKey as string;
    await anonClient()
      .storage.from(BUCKET)
      .uploadToSignedUrl(fileKey, signed.body.token as string, new Blob(["orphan"]));
    expect(await objectExists(fileKey)).toBe(true);

    const { status, body } = await invoke(
      "delete-document",
      { file_key: fileKey },
      fx.tokens.owner,
    );
    report("owner abandons own upload", status, body);

    expect(status).toBe(200);
    expect(body.abandoned).toBe(true);
    expect(await objectExists(fileKey)).toBe(false);
  });

  it("refuses a key belonging to another agent's record", async () => {
    const signed = await invoke(
      "create-upload-url",
      { owner_type: "merchant", owner_id: fx.ownerIds.owner.merchant },
      fx.tokens.owner,
    );
    const fileKey = signed.body.fileKey as string;
    await anonClient()
      .storage.from(BUCKET)
      .uploadToSignedUrl(fileKey, signed.body.token as string, new Blob(["not yours"]));

    const { status, body } = await invoke(
      "delete-document",
      { file_key: fileKey },
      fx.tokens.intruder,
    );
    report("intruder abandons owner's upload", status, body);

    // Authorization comes from resolving the key's owner record through the
    // caller's own client, so this is the same 404 create-upload-url gives.
    // Without it, this mode would be a delete-anything primitive.
    expect(status).toBe(404);
    expect(await objectExists(fileKey)).toBe(true);

    await adminClient().storage.from(BUCKET).remove([fileKey]);
  });

  it("refuses a key that a live document still points at", async () => {
    const uploaded = await uploadAsUser(
      fx.tokens.owner,
      "merchant",
      fx.ownerIds.owner.merchant,
      { body: new Blob(["attached"]), name: "still-attached.txt" },
    );

    const { status, body } = await invoke(
      "delete-document",
      { file_key: uploaded.fileKey },
      fx.tokens.owner,
    );
    report("owner abandons an attached key", status, body);

    // Otherwise this is a way to destroy a live document's bytes while leaving
    // its row — a document that lists, offers a download, and 404s.
    expect(status).toBe(409);
    expect(await objectExists(uploaded.fileKey as string)).toBe(true);

    await invoke(
      "delete-document",
      { document_id: uploaded.documentId },
      fx.tokens.owner,
    );
  });

  it("rejects a key that is not a document key at all", async () => {
    for (const fileKey of [
      "not-a-key",
      "../../etc/passwd",
      `${fx.userIds.owner}/merchant/1`,
      `${fx.userIds.owner}/merchant/1/`,
    ]) {
      const { status, body } = await invoke(
        "delete-document",
        { file_key: fileKey },
        fx.tokens.owner,
      );
      report(`owner abandons "${fileKey}"`, status, body);
      // 400 for an unparseable key, 404 once it parses but names a record the
      // caller cannot see. Either way, never a 200.
      expect([400, 404]).toContain(status);
    }
  });

  it("refuses both modes at once", async () => {
    const { status, body } = await invoke(
      "delete-document",
      { document_id: fx.documentIds.owner, file_key: "x/y/1/z" },
      fx.tokens.owner,
    );
    report("owner sends both modes", status, body);

    // Ambiguous, and one of the two would silently win. The owner's real
    // document must still be there afterwards.
    expect(status).toBe(400);
    const { count } = await adminClient()
      .from("documents")
      .select("id", { count: "exact", head: true })
      .eq("id", fx.documentIds.owner);
    expect(count).toBe(1);
  });
});

describe("signed download URLs expire", () => {
  it(
    "serves the bytes now and refuses the same URL after the TTL",
    async () => {
      const download = await invoke(
        "create-download-url",
        { document_id: fx.documentIds.owner },
        fx.tokens.owner,
      );
      expect(download.status, download.raw).toBe(200);
      expect(download.body.expiresIn).toBe(60);

      const url = toReachableUrl(download.body.signedUrl as string);

      const now = await fetch(url);
      report("signed URL, immediately", now.status, {
        bytes: (await now.text()).length,
      });
      expect(now.status).toBe(200);

      // Actually waited out. The alternative — trusting `expiresIn` — proves
      // only that the function reports a number, and the number is not the
      // thing that expires: the JWT inside the URL is. If `createSignedUrl`
      // were ever called without a TTL, or with the wrong units, a reported 60
      // would sit above a link that works for hours.
      await new Promise((resolve) => setTimeout(resolve, 63_000));

      const later = await fetch(url);
      const body = await later.text();
      report("signed URL, after 63s", later.status, body.slice(0, 120));

      expect(later.status).toBe(400);
      // Storage refuses it on the token, not by serving a stale copy or an
      // empty 200.
      expect(body).toMatch(/exp|jwt/i);
    },
    // Longer than the suite's 60s default, because the wait is the test.
    120_000,
  );
});

describe("file edge cases", () => {
  it("stores and returns a zero-byte file (which is why the client refuses one)", async () => {
    // Storage is perfectly happy with an empty file, and so is the documents
    // row: it lists, badges and offers a download exactly like a real one, and
    // the only way to find out the driver's licence never made it is to open it.
    // Nothing server-side is going to catch that, so documentUploadProblem() in
    // lib/documents.ts refuses it before the upload starts. This asserts the
    // shape of the problem the client-side check exists for.
    const uploaded = await uploadAsUser(
      fx.tokens.owner,
      "merchant",
      fx.ownerIds.owner.merchant,
      { body: new Blob([]), name: "empty.txt" },
    );
    report("zero-byte upload", uploaded.signStatus, {
      putError: uploaded.putError,
      insertError: uploaded.insertError,
    });

    expect(uploaded.putError).toBeNull();
    expect(uploaded.insertError).toBeNull();

    const download = await invoke(
      "create-download-url",
      { document_id: uploaded.documentId },
      fx.tokens.owner,
    );
    const fetched = await fetch(toReachableUrl(download.body.signedUrl as string));
    expect(fetched.status).toBe(200);
    expect((await fetched.arrayBuffer()).byteLength).toBe(0);

    await invoke(
      "delete-document",
      { document_id: uploaded.documentId },
      fx.tokens.owner,
    );
  });

  it("refuses a file over the bucket's size limit", async () => {
    // The server-side half of the size ceiling. config.toml's
    // `[storage] file_size_limit` does NOT do this — measured, a 120 MiB PUT was
    // accepted with it set to 50MiB, and both buckets reported
    // file_size_limit = null. The per-bucket limit provisionFixtures() now sets
    // is what actually refuses this, and it has to be set out-of-band on the
    // hosted project too.
    const oversize = new Blob([new Uint8Array(MAX_DOCUMENT_BYTES + 1024)]);
    const uploaded = await uploadAsUser(
      fx.tokens.owner,
      "merchant",
      fx.ownerIds.owner.merchant,
      { body: oversize, name: "over.bin" },
    );
    report("over-limit upload", uploaded.signStatus, {
      putError: uploaded.putError,
    });

    expect(uploaded.putError).not.toBeNull();
    expect(uploaded.documentId).toBeNull();

    // And nothing was left behind by the rejected PUT.
    expect(await objectExists(uploaded.fileKey as string)).toBe(false);
  }, 120_000);

  it("accepts a file just under the limit", async () => {
    // The other side of the boundary, so "refuses over-limit" cannot be passing
    // because the upload path is broken for large files generally.
    const justUnder = new Blob([new Uint8Array(MAX_DOCUMENT_BYTES - 4096)]);
    const uploaded = await uploadAsUser(
      fx.tokens.owner,
      "merchant",
      fx.ownerIds.owner.merchant,
      { body: justUnder, name: "under.bin" },
    );
    report("under-limit upload", uploaded.signStatus, {
      putError: uploaded.putError,
      insertError: uploaded.insertError,
    });

    expect(uploaded.putError).toBeNull();
    expect(uploaded.insertError).toBeNull();

    await invoke(
      "delete-document",
      { document_id: uploaded.documentId },
      fx.tokens.owner,
    );
  }, 180_000);

  it("keeps duplicate file names apart", async () => {
    // Two files with the same name on the same record. The display name is not
    // part of the storage key — the key is a uuid — so this must produce two
    // distinct objects rather than one overwriting the other. Uploading the
    // same document twice by accident is the commonest way a rep gets here, and
    // silently replacing the first is the wrong answer when the second upload is
    // the truncated one.
    const first = await uploadAsUser(
      fx.tokens.owner,
      "merchant",
      fx.ownerIds.owner.merchant,
      { body: new Blob(["first copy"]), name: "duplicate.pdf" },
    );
    const second = await uploadAsUser(
      fx.tokens.owner,
      "merchant",
      fx.ownerIds.owner.merchant,
      { body: new Blob(["second copy"]), name: "duplicate.pdf" },
    );

    expect(first.documentId).not.toBe(second.documentId);
    expect(first.fileKey).not.toBe(second.fileKey);

    for (const [label, uploaded, expected] of [
      ["first", first, "first copy"],
      ["second", second, "second copy"],
    ] as const) {
      const download = await invoke(
        "create-download-url",
        { document_id: uploaded.documentId },
        fx.tokens.owner,
      );
      const fetched = await fetch(
        toReachableUrl(download.body.signedUrl as string),
      );
      report(`duplicate name, ${label}`, fetched.status, { expected });
      expect(await fetched.text()).toBe(expected);
    }

    for (const uploaded of [first, second]) {
      await invoke(
        "delete-document",
        { document_id: uploaded.documentId },
        fx.tokens.owner,
      );
    }
  });

  it("re-uploading the same token does not overwrite", async () => {
    // uploadToSignedUrl with an already-used token. Worth pinning because the
    // panel retries by asking for a NEW signed URL, and a replayable token would
    // mean a retry could land on top of a completed upload.
    const signed = await invoke(
      "create-upload-url",
      { owner_type: "merchant", owner_id: fx.ownerIds.owner.merchant },
      fx.tokens.owner,
    );
    const fileKey = signed.body.fileKey as string;
    const token = signed.body.token as string;

    const first = await anonClient()
      .storage.from(BUCKET)
      .uploadToSignedUrl(fileKey, token, new Blob(["original"]));
    const second = await anonClient()
      .storage.from(BUCKET)
      .uploadToSignedUrl(fileKey, token, new Blob(["replacement"]));

    report("token replay", second.error ? 409 : 200, {
      first: first.error?.message ?? null,
      second: second.error?.message ?? null,
    });

    expect(first.error).toBeNull();
    expect(second.error).not.toBeNull();
    expect(second.error?.message).toMatch(/exists/i);

    await adminClient().storage.from(BUCKET).remove([fileKey]);
  });

  it("serves awkward file names as an attachment without mangling the response", async () => {
    // Quotes and CRLF in a file name reach Storage as the `download` parameter,
    // which becomes a Content-Disposition header. If it were interpolated raw,
    // a CRLF would be response-header injection. Asserted rather than assumed.
    const names = [
      'we"ird.txt',
      "bad\r\nX-Injected: yes.txt",
      "фото-контракт-🔒.pdf",
      `${"L".repeat(296)}.txt`,
      "no-extension-at-all",
    ];

    for (const name of names) {
      const uploaded = await uploadAsUser(
        fx.tokens.owner,
        "merchant",
        fx.ownerIds.owner.merchant,
        { body: new Blob(["x"]), name },
      );
      expect(uploaded.insertError, name).toBeNull();

      const download = await invoke(
        "create-download-url",
        { document_id: uploaded.documentId },
        fx.tokens.owner,
      );
      expect(download.status, download.raw).toBe(200);

      const fetched = await fetch(
        toReachableUrl(download.body.signedUrl as string),
      );
      const disposition = fetched.headers.get("content-disposition") ?? "";
      report(`file name ${JSON.stringify(name.slice(0, 30))}`, fetched.status, {
        disposition: disposition.slice(0, 60),
      });

      expect(fetched.status).toBe(200);
      expect(disposition).toMatch(/^attachment/);
      // Percent-encoded on the way into the header, so nothing in a file name
      // can add a header of its own or terminate the value early.
      expect(disposition).not.toMatch(/[\r\n]/);
      expect(fetched.headers.get("x-injected")).toBeNull();

      await invoke(
        "delete-document",
        { document_id: uploaded.documentId },
        fx.tokens.owner,
      );
    }
  });

  it("serves an uploaded .html as a download, never inline", async () => {
    // This is what makes an accept-anything file input safe. create-download-url
    // passes `download`, so Storage answers Content-Disposition: attachment and
    // the browser saves the file instead of rendering it on the storage origin.
    // Drop that option and an uploaded page becomes stored XSS against a
    // *.supabase.co origin — which is why the check is here and not in a comment.
    const uploaded = await uploadAsUser(
      fx.tokens.owner,
      "merchant",
      fx.ownerIds.owner.merchant,
      {
        body: new Blob(["<script>alert(1)</script>"], { type: "text/html" }),
        name: "evil.html",
        type: "text/html",
      },
    );

    const download = await invoke(
      "create-download-url",
      { document_id: uploaded.documentId },
      fx.tokens.owner,
    );
    const fetched = await fetch(toReachableUrl(download.body.signedUrl as string));
    const disposition = fetched.headers.get("content-disposition") ?? "";
    report("html upload", fetched.status, { disposition });

    expect(disposition).toMatch(/^attachment/);

    await invoke(
      "delete-document",
      { document_id: uploaded.documentId },
      fx.tokens.owner,
    );
  });
});

describe("several uploads to one record", () => {
  it("keeps five concurrent uploads distinct", async () => {
    // The panel serialises uploads behind its own disabled input, so the real
    // shape of this is two tabs, or two people, on the same record at once. Every
    // key carries a fresh uuid, so nothing should collide — asserted because the
    // failure mode is silent: one upload overwriting another's object leaves two
    // rows whose downloads return the same bytes.
    const results = await Promise.all(
      [1, 2, 3, 4, 5].map((n) =>
        uploadAsUser(
          fx.tokens.owner,
          "support_ticket",
          fx.ownerIds.owner.support_ticket,
          { body: new Blob([`concurrent ${n}`]), name: `concurrent-${n}.txt` },
        ),
      ),
    );

    const keys = results.map((r) => r.fileKey);
    report("five concurrent uploads", 200, { distinctKeys: new Set(keys).size });

    expect(results.every((r) => r.insertError === null)).toBe(true);
    expect(new Set(keys).size).toBe(5);

    for (const [index, uploaded] of results.entries()) {
      const download = await invoke(
        "create-download-url",
        { document_id: uploaded.documentId },
        fx.tokens.owner,
      );
      const fetched = await fetch(
        toReachableUrl(download.body.signedUrl as string),
      );
      expect(await fetched.text()).toBe(`concurrent ${index + 1}`);
    }

    for (const uploaded of results) {
      await invoke(
        "delete-document",
        { document_id: uploaded.documentId },
        fx.tokens.owner,
      );
    }
  }, 120_000);
});
