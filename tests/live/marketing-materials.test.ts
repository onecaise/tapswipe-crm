// Real invocations of marketing-material-file-url against a running local stack
// (`supabase start` + `supabase functions serve`).
//
// Run with:  npm run test:live
//
// Not an RLS suite — tests/rls/marketing-materials.test.ts already proves what
// the policies do. What cannot live there is the thing this function exists
// for: its two modes have DIFFERENT authorization. An admin stocks the library,
// every active rep reads it. That asymmetry is a property of the Deno handler,
// not of a policy, and PGlite can execute none of it: no JWT, no Deno, no
// Storage, no signed URL.
//
// The round-trip assertions matter as much as the status codes. A signed upload
// URL that mints fine and then cannot be read back is the failure mode the
// documents suite had to learn to catch, so every success path here puts real
// bytes through Storage and reads them out again.
//
// Every case logs its real status and body, so a run is readable as evidence
// rather than a row of green ticks.
//
// The two "lets a REP download" cases are the ONLY ones here making a claim
// about who may read the library, and they were made so deliberately. Adding
// callerIsAdmin to the download branch -- the mistake copying
// residual-import-file-url wholesale would produce -- reddened six tests on the
// first draft, because four error-path cases happened to drive the endpoint as
// a rep. Those four now use the admin token, so each test fails for one reason
// and the rep-access claim has exactly two witnesses.

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  type Fixtures,
  MARKETING_BUCKET,
  adminClient,
  functionsAreServed,
  invoke,
  provisionFixtures,
  teardownFixtures,
  toReachableUrl,
  userClient,
  warmFunctions,
} from "./helpers/stack";

let fx: Fixtures;

/** Material ids created by this file, cleaned up in afterAll. */
const createdMaterialIds: number[] = [];

beforeAll(async () => {
  if (!(await functionsAreServed())) {
    throw new Error(
      "No Edge Function runtime answering on the local stack.\n" +
        "Run `npx supabase start` and `npx supabase functions serve` first.",
    );
  }
  // The CLI writes a `.npmrc` into a function's directory on its first
  // invocation, its watcher sees the write, and the runtime restarts — 502-ing
  // whatever is in flight. Without this a cold serve turns the file red with
  // "expected 502 to be 200", which says nothing about the function.
  await warmFunctions(["marketing-material-file-url"]);
  fx = await provisionFixtures();
});

afterAll(async () => {
  // Materials are not deleted by teardownFixtures unless their uploader is one
  // of the personas — which here they always are — but the storage objects are
  // this file's own litter either way, and an orphaned object is invisible
  // (private bucket), which is exactly why it has to be removed deliberately.
  const admin = adminClient();
  for (const id of createdMaterialIds) {
    const { data } = await admin
      .from("marketing_materials")
      .select("file_key")
      .eq("id", id)
      .maybeSingle();
    if (data?.file_key) {
      await admin.storage.from(MARKETING_BUCKET).remove([data.file_key as string]);
    }
  }
  await teardownFixtures();
});

/** Prints the verbatim response so the run output shows what actually came back. */
function report(label: string, status: number, body: unknown): void {
  console.log(`  ${label} -> ${status} ${JSON.stringify(body)}`);
}

/**
 * Creates a material and puts real bytes behind it, as an admin would.
 *
 * Returns the id, the key and the body, so a test can assert on the round trip
 * rather than on the mint alone.
 */
async function uploadMaterial(
  title: string,
  body: string,
  fileName = "sheet.txt",
): Promise<{ materialId: number; fileKey: string; body: string }> {
  const { status, body: minted } = await invoke(
    "marketing-material-file-url",
    {
      category: "Rate cards",
      title,
      file_name: fileName,
      mime_type: "text/plain",
    },
    fx.tokens.admin,
  );
  expect(status).toBe(200);

  const materialId = minted.material_id as number;
  createdMaterialIds.push(materialId);

  const put = await fetch(toReachableUrl(minted.signedUrl as string), {
    method: "PUT",
    headers: {
      "Content-Type": "text/plain",
      Authorization: `Bearer ${minted.token}`,
      "x-upsert": "true",
    },
    body,
  });
  expect(put.ok).toBe(true);

  return { materialId, fileKey: minted.fileKey as string, body };
}

describe("upload mode is admin-only", () => {
  it("mints an upload URL for an admin and keys it by material id", async () => {
    const { status, body } = await invoke(
      "marketing-material-file-url",
      {
        category: "Rate cards",
        title: "Retail rate card 2026",
        file_name: "retail rate card.pdf",
        mime_type: "application/pdf",
      },
      fx.tokens.admin,
    );
    report("admin mints upload", status, body);

    expect(status).toBe(200);
    expect(body.material_id).toBeGreaterThan(0);
    createdMaterialIds.push(body.material_id as number);

    // The key shape the CHECK constraint and fileKeyMatchesMaterial both
    // depend on — and the filename sanitised, since a space would otherwise
    // reach a storage path.
    expect(body.fileKey).toBe(`${body.material_id}/retail_rate_card.pdf`);
  });

  it("refuses a rep minting an upload", async () => {
    const { status, body } = await invoke(
      "marketing-material-file-url",
      { category: "Rate cards", title: "Forged", file_name: "x.pdf" },
      fx.tokens.owner,
    );
    report("rep mints upload", status, body);

    expect(status).toBe(403);
    expect(body.error).toBe("Admin only");
  });

  it("refuses a deactivated admin before it says 'admin only'", async () => {
    // Ordering assertion, not a duplicate of the one above: callerIsActive runs
    // before callerIsAdmin so a deactivated caller gets the accurate reason. A
    // deactivated AGENT would produce 403 either way, which is why this is
    // asserted on the message rather than the status.
    const { status, body } = await invoke(
      "marketing-material-file-url",
      { category: "Rate cards", title: "Forged", file_name: "x.pdf" },
      fx.tokens.deactivated,
    );
    report("deactivated mints upload", status, body);

    expect(status).toBe(403);
    expect(body.error).toBe("Account is not active");
  });

  it("refuses an unauthenticated caller", async () => {
    const { status } = await invoke("marketing-material-file-url", {
      category: "Rate cards",
      title: "Forged",
      file_name: "x.pdf",
    });
    // verify_jwt = false in config.toml, so this 401 is the function's own
    // doing rather than the platform's.
    expect(status).toBe(401);
  });

  it("rejects a missing category or title", async () => {
    for (const payload of [
      { title: "No category", file_name: "x.pdf" },
      { category: "Rate cards", file_name: "x.pdf" },
      { category: "Rate cards", title: "   ", file_name: "x.pdf" },
    ]) {
      const { status, body } = await invoke(
        "marketing-material-file-url",
        payload,
        fx.tokens.admin,
      );
      report(`bad payload ${JSON.stringify(payload)}`, status, body);
      expect(status).toBe(400);
    }
  });

  it("writes an audit_log row naming the admin and the material", async () => {
    const { materialId } = await uploadMaterial("Audited card", "audited");

    const { data } = await adminClient()
      .from("audit_log")
      .select("actor_id, action, table_name, row_id")
      .eq("action", "upload_marketing_material")
      .eq("row_id", String(materialId));

    expect(data).toEqual([
      {
        actor_id: fx.userIds.admin,
        action: "upload_marketing_material",
        table_name: "marketing_materials",
        row_id: String(materialId),
      },
    ]);
  });
});

describe("download mode is open to every active user", () => {
  it("lets a REP download a material an admin uploaded", async () => {
    // The assertion this whole file exists for. Copying residual-import-file-url
    // wholesale would have put callerIsAdmin on this branch too, and the library
    // would be invisible to the people it is for — with no policy failing,
    // because the policy is correct and the function would simply be stricter
    // than it.
    const { materialId, body: bytes } = await uploadMaterial(
      "Rep readable card",
      "rep can read this",
    );

    const { status, body } = await invoke(
      "marketing-material-file-url",
      { material_id: materialId },
      fx.tokens.owner,
    );
    report("rep downloads", status, body);

    expect(status).toBe(200);
    expect(body.fileName).toBe("sheet.txt");

    const got = await fetch(toReachableUrl(body.signedUrl as string));
    expect(got.status).toBe(200);
    expect(await got.text()).toBe(bytes);
  });

  it("lets a SECOND rep download the same material", async () => {
    // Separate from the first rep deliberately: a download path that compared
    // anything to auth.uid() could still pass for whichever persona the fixture
    // happened to favour.
    const { materialId } = await uploadMaterial("Shared card", "shared bytes");

    const { status, body } = await invoke(
      "marketing-material-file-url",
      { material_id: materialId },
      fx.tokens.intruder,
    );
    report("second rep downloads", status, body);

    expect(status).toBe(200);
    const got = await fetch(toReachableUrl(body.signedUrl as string));
    expect(await got.text()).toBe("shared bytes");
  });

  it("refuses a deactivated rep", async () => {
    // The one case where "every active user" does work. A deactivated rep holds
    // a working JWT until it expires; without callerIsActive they would keep
    // pulling the company's current rate cards after being let go.
    const { materialId } = await uploadMaterial("Post-exit card", "secret-ish");

    const { status, body } = await invoke(
      "marketing-material-file-url",
      { material_id: materialId },
      fx.tokens.deactivated,
    );
    report("deactivated downloads", status, body);

    expect(status).toBe(403);
    expect(body.error).toBe("Account is not active");
  });

  it("refuses an unauthenticated caller", async () => {
    const { materialId } = await uploadMaterial("Anon card", "nope");
    const { status } = await invoke("marketing-material-file-url", {
      material_id: materialId,
    });
    expect(status).toBe(401);
  });

  it("404s a material id that does not exist", async () => {
    // Admin token on purpose, even though a rep may download. This test is
    // about the error path, and driving it as a rep would make it fail for a
    // second reason the moment the download branch's authorization changed --
    // which is exactly what happened when that revert was tried: six tests
    // went red where only two were making a claim about rep access.
    const { status, body } = await invoke(
      "marketing-material-file-url",
      { material_id: 987654 },
      fx.tokens.admin,
    );
    report("missing material", status, body);

    expect(status).toBe(404);
    expect(body.error).toBe("Material not found");
  });

  it("409s a material whose upload never finished", async () => {
    // Its own answer rather than a 404: the row genuinely exists, and an admin
    // looking at the library needs to be told to re-upload rather than that the
    // material is missing.
    const { data: created } = await adminClient()
      .from("marketing_materials")
      .insert({
        category: "Rate cards",
        title: "Never uploaded",
        file_name: "ghost.pdf",
        uploaded_by: fx.userIds.admin,
      })
      .select("id")
      .single();
    createdMaterialIds.push(created!.id as number);

    const { status, body } = await invoke(
      "marketing-material-file-url",
      { material_id: created!.id },
      fx.tokens.admin,
    );
    report("unfinished upload", status, body);

    expect(status).toBe(409);
    expect(body.error).toBe("Material has no file yet");
  });

  it("rejects a non-integer material_id", async () => {
    const { status, body } = await invoke(
      "marketing-material-file-url",
      { material_id: "1; drop table marketing_materials" },
      fx.tokens.admin,
    );
    report("bad material_id", status, body);
    expect(status).toBe(400);
  });
});

describe("view and download are genuinely different", () => {
  // Without this the UI's four buttons would be two pairs of identical actions
  // wearing different labels and writing different log rows — which is worse
  // than three buttons, because the log would then claim a distinction the
  // product does not make.
  //
  // View and Print need the browser to RENDER the file; Download needs it to
  // save one. That is Content-Disposition, which is decided when the URL is
  // signed and cannot be changed afterwards by the caller.
  it("signs inline by default and attachment on request", async () => {
    const { materialId } = await uploadMaterial(
      "Disposition card",
      "disposition bytes",
    );

    const inline = await invoke(
      "marketing-material-file-url",
      { material_id: materialId },
      fx.tokens.owner,
    );
    report("inline read", inline.status, inline.body);
    expect(inline.status).toBe(200);
    expect(inline.body.disposition).toBe("inline");

    const attachment = await invoke(
      "marketing-material-file-url",
      { material_id: materialId, download: true },
      fx.tokens.owner,
    );
    report("attachment read", attachment.status, attachment.body);
    expect(attachment.status).toBe(200);
    expect(attachment.body.disposition).toBe("attachment");

    // The response headers, not just the field the function echoes back.
    // Asserting our own echo would pass with the download option dropped
    // entirely, which is exactly the regression worth catching — Storage is
    // what actually honours it.
    //
    // Measured, rather than assumed: the inline case sends NO
    // Content-Disposition header at all, it does not send "inline". So the
    // assertion is on absence, which is what makes a browser render the file.
    // Expecting /inline/i here fails with "toMatch() expects a string, but got
    // object" — a null header, reported as a type error three layers from the
    // cause.
    const inlineGet = await fetch(
      toReachableUrl(inline.body.signedUrl as string),
    );
    expect(inlineGet.headers.get("content-disposition")).toBeNull();

    const attachmentGet = await fetch(
      toReachableUrl(attachment.body.signedUrl as string),
    );
    // Filename included, because the function passes material.file_name rather
    // than a bare `true` — a download that saves as the storage uuid is a file
    // nobody can find again.
    expect(attachmentGet.headers.get("content-disposition")).toMatch(
      /^attachment; filename=sheet\.txt/i,
    );

    // Same bytes either way — the disposition changes how the browser treats
    // the response, not what is in it.
    expect(await inlineGet.text()).toBe("disposition bytes");
    expect(await attachmentGet.text()).toBe("disposition bytes");
  });
});

describe("the stored file_key is never trusted", () => {
  it("refuses to sign a key that does not match its material", async () => {
    // The database CHECK is validated here, so this cannot be set up through
    // PostgREST at all — which is itself worth asserting, because it proves the
    // two layers agree rather than one carrying the other. The constraint
    // refuses the forgery; fileKeyMatchesMaterial is what would refuse it if a
    // later migration relaxed the constraint or a repair bypassed it.
    const victim = await uploadMaterial("Victim card", "victim bytes");
    const attacker = await uploadMaterial("Attacker card", "attacker bytes");

    const { error } = await adminClient()
      .from("marketing_materials")
      .update({ file_key: victim.fileKey })
      .eq("id", attacker.materialId);

    report("repoint file_key via service role", error ? 400 : 200, {
      error: error?.message ?? null,
    });
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/marketing_materials_file_key_matches_id/);

    // And the attacker's material still serves its own bytes, not the victim's.
    const { body } = await invoke(
      "marketing-material-file-url",
      { material_id: attacker.materialId },
      fx.tokens.admin,
    );
    const got = await fetch(toReachableUrl(body.signedUrl as string));
    expect(await got.text()).toBe("attacker bytes");
  });
});

describe("event logging goes through PostgREST, not the function", () => {
  it("lets a rep log an event against their own lead", async () => {
    // The function deliberately does not log events: an event is an ordinary
    // insert the rep's own policy admits, so routing it through an Edge
    // Function would add a service-role hop to a write RLS already decides
    // correctly. Asserted here rather than only in the RLS suite because this
    // goes through PostgREST with a real JWT, which is where a missing grant
    // shows up and PGlite's role shim cannot.
    const { materialId } = await uploadMaterial("Logged card", "logged");
    const owner = userClient(fx.tokens.owner);

    const { error } = await owner.from("marketing_material_events").insert({
      material_id: materialId,
      lead_id: fx.ownerIds.owner.lead,
      agent_id: fx.userIds.owner,
      event_type: "downloaded",
    });
    report("rep logs own event", error ? 400 : 201, {
      error: error?.message ?? null,
    });
    expect(error).toBeNull();
  });

  it("refuses a rep logging against another rep's lead", async () => {
    // The documents.file_key lesson in its second form, proved over real HTTP:
    // lead_id is client-supplied and only the `exists` clause in the insert
    // policy reads it.
    const { materialId } = await uploadMaterial("Cross card", "cross");
    const owner = userClient(fx.tokens.owner);

    const { error } = await owner.from("marketing_material_events").insert({
      material_id: materialId,
      lead_id: fx.ownerIds.intruder.lead,
      agent_id: fx.userIds.owner,
      event_type: "emailed",
    });
    report("rep logs cross-lead event", error ? 403 : 201, {
      error: error?.message ?? null,
    });
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/row-level security|violates/i);
  });

  it("refuses a rep editing or deleting an event", async () => {
    // Append-only in the grant layer, which is what makes this "permission
    // denied" rather than a statement filtered to zero rows reporting a save
    // that did nothing.
    const { materialId } = await uploadMaterial("Immutable card", "immutable");
    const owner = userClient(fx.tokens.owner);

    await owner.from("marketing_material_events").insert({
      material_id: materialId,
      lead_id: fx.ownerIds.owner.lead,
      agent_id: fx.userIds.owner,
      event_type: "viewed",
    });

    const { error: updateError } = await owner
      .from("marketing_material_events")
      .update({ event_type: "printed" })
      .eq("material_id", materialId);
    report("rep edits event", updateError ? 403 : 200, {
      error: updateError?.message ?? null,
    });
    expect(updateError?.message).toMatch(/permission denied/i);

    const { error: deleteError } = await owner
      .from("marketing_material_events")
      .delete()
      .eq("material_id", materialId);
    report("rep deletes event", deleteError ? 403 : 200, {
      error: deleteError?.message ?? null,
    });
    expect(deleteError?.message).toMatch(/permission denied/i);
  });

  it("refuses a rep writing to marketing_materials", async () => {
    const owner = userClient(fx.tokens.owner);
    const { error } = await owner.from("marketing_materials").insert({
      category: "Rate cards",
      title: "Rep forged",
      uploaded_by: fx.userIds.owner,
    });
    report("rep inserts material", error ? 403 : 201, {
      error: error?.message ?? null,
    });
    expect(error).not.toBeNull();
  });

  it("lets every active rep read the library over PostgREST", async () => {
    await uploadMaterial("Readable by all", "all");
    for (const persona of ["owner", "intruder", "admin"] as const) {
      const client = userClient(fx.tokens[persona]);
      const { data, error } = await client
        .from("marketing_materials")
        .select("id")
        .limit(1);
      expect(error).toBeNull();
      expect((data ?? []).length).toBe(1);
    }
  });
});
