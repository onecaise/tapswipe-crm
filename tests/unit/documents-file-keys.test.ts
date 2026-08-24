// The pure half of the document security fix, exercised without Deno, Docker or
// a running stack.
//
// Same arrangement as tests/unit/residuals-parse.test.ts and for the same
// reason: supabase/functions/_shared/documents.ts is deliberately
// dependency-free, so Node can import it directly even though tsconfig excludes
// `supabase` from its roots (a file reached by an import is still type-checked,
// which is how `npx tsc --noEmit` covers this module).
//
// These two functions are what stands between a client-supplied file_key and a
// service-role signing call, so they get exercised at the boundary rather than
// only through the happy path. The end-to-end story is in
// tests/live/document-lifecycle.test.ts; the reason it cannot cover the
// mismatch branch is that documents_file_key_matches_owner now refuses to store
// a mismatched row in the first place, so the only rows the branch can ever see
// are legacy ones predating the constraint — unreachable from a test that only
// has PostgREST.

import { describe, expect, it } from "vitest";

import {
  buildFileKey,
  fileKeyMatchesOwner,
  parseFileKey,
} from "../../supabase/functions/_shared/documents";
import { reachableStorageUrl } from "../../lib/documents";

const AGENT = "11111111-2222-4333-8444-555555555555";
const OTHER = "99999999-8888-4777-8666-555555555555";
const UUID = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

describe("buildFileKey / parseFileKey round trip", () => {
  it("parses back exactly what it built, for every owner type", () => {
    for (const ownerType of [
      "merchant",
      "lead",
      "pre_app",
      "support_ticket",
    ] as const) {
      const key = buildFileKey(AGENT, ownerType, 42, UUID);
      expect(parseFileKey(key)).toEqual({
        agentId: AGENT,
        ownerType,
        ownerId: 42,
        uuid: UUID,
      });
    }
  });

  it("rejects keys that are not four non-empty segments", () => {
    // The orphan-cleanup path in delete-document parses owner_type and owner_id
    // straight out of a caller-supplied key, so a half-understood key is the
    // thing to avoid. Everything here has to be a flat no, not a partial parse.
    expect(parseFileKey("")).toBeNull();
    expect(parseFileKey(`${AGENT}/merchant/42`)).toBeNull();
    expect(parseFileKey(`${AGENT}/merchant/42/${UUID}/extra`)).toBeNull();
    expect(parseFileKey(`${AGENT}/merchant/42/`)).toBeNull();
    expect(parseFileKey(`/merchant/42/${UUID}`)).toBeNull();
    expect(parseFileKey(`${AGENT}//42/${UUID}`)).toBeNull();
  });

  it("rejects an owner_id that is not a positive integer", () => {
    expect(parseFileKey(`${AGENT}/merchant/0/${UUID}`)).toBeNull();
    expect(parseFileKey(`${AGENT}/merchant/-1/${UUID}`)).toBeNull();
    expect(parseFileKey(`${AGENT}/merchant/4.2/${UUID}`)).toBeNull();
    expect(parseFileKey(`${AGENT}/merchant/1e3/${UUID}`)).toBeNull();
    expect(parseFileKey(`${AGENT}/merchant/abc/${UUID}`)).toBeNull();
    // Would round to a different number, so it must not be accepted as one.
    expect(
      parseFileKey(`${AGENT}/merchant/99999999999999999999/${UUID}`),
    ).toBeNull();
  });

  it("rejects a traversal attempt rather than resolving it", () => {
    // A `..` segment would be a real key on the Storage side, so nothing here
    // tries to normalise it — the segment count and the integer check are what
    // make it unrepresentable.
    expect(parseFileKey(`${AGENT}/merchant/../${UUID}`)).toBeNull();
    expect(parseFileKey(`../../../${UUID}`)).toBeNull();
  });
});

describe("fileKeyMatchesOwner", () => {
  it("accepts the key create-upload-url would have signed", () => {
    expect(
      fileKeyMatchesOwner(
        buildFileKey(AGENT, "merchant", 7, UUID),
        AGENT,
        "merchant",
        7,
      ),
    ).toBe(true);
  });

  it("refuses another agent's key on your own row", () => {
    // THE bug. Insert a row with agent_id = you (so the insert policy passes)
    // and file_key = somebody else's object; create-download-url used to sign
    // it with the service role because RLS said the row was yours.
    expect(
      fileKeyMatchesOwner(
        buildFileKey(OTHER, "merchant", 7, UUID),
        AGENT,
        "merchant",
        7,
      ),
    ).toBe(false);
  });

  it("refuses a key whose owner_type or owner_id disagrees with the row", () => {
    const key = buildFileKey(AGENT, "merchant", 7, UUID);
    expect(fileKeyMatchesOwner(key, AGENT, "lead", 7)).toBe(false);
    expect(fileKeyMatchesOwner(key, AGENT, "merchant", 8)).toBe(false);
    // 7 vs 70: the trailing slash in the prefix is what stops a prefix of a
    // longer id from matching. Without it, owner 7's key would satisfy owner 70.
    expect(fileKeyMatchesOwner(buildFileKey(AGENT, "merchant", 70, UUID), AGENT, "merchant", 7)).toBe(false);
  });

  it("refuses a bare prefix with no object after it", () => {
    expect(
      fileKeyMatchesOwner(`${AGENT}/merchant/7`, AGENT, "merchant", 7),
    ).toBe(false);
    // The prefix itself ends in the slash, so this is a directory and would sign
    // a URL that can never resolve.
    expect(
      fileKeyMatchesOwner(`${AGENT}/merchant/7/`, AGENT, "merchant", 7),
    ).toBe(false);
  });

  it("refuses anything that is not the four expected strings", () => {
    // Fail closed on shape: a null file_key or a missing agent_id must not
    // become a match by way of string coercion.
    expect(fileKeyMatchesOwner(null, AGENT, "merchant", 7)).toBe(false);
    expect(fileKeyMatchesOwner(undefined, AGENT, "merchant", 7)).toBe(false);
    expect(
      fileKeyMatchesOwner(buildFileKey(AGENT, "merchant", 7, UUID), null, "merchant", 7),
    ).toBe(false);
    expect(
      fileKeyMatchesOwner(buildFileKey(AGENT, "merchant", 7, UUID), AGENT, null, 7),
    ).toBe(false);
    expect(
      fileKeyMatchesOwner(buildFileKey(AGENT, "merchant", 7, UUID), AGENT, "merchant", null),
    ).toBe(false);
  });

  it("accepts owner_id as the string PostgREST may hand back", () => {
    // documents.owner_id is `int`, and supabase-js gives a number — but the same
    // helper is called with a value straight off a JSON body elsewhere, and a
    // numeric string that agrees with the key is not a mismatch.
    expect(
      fileKeyMatchesOwner(buildFileKey(AGENT, "merchant", 7, UUID), AGENT, "merchant", "7"),
    ).toBe(true);
  });
});

describe("reachableStorageUrl", () => {
  // The signed URL an Edge Function returns carries the function's OWN
  // SUPABASE_URL as its origin, and on the local stack that is the
  // container-internal `http://kong:8000`. The download button navigated to it
  // verbatim, which in development meant navigating to a host that does not
  // resolve — no error, no download, a button that appeared to work. The live
  // suite has always rewritten the same way to fetch a signed URL from Node,
  // which is the clue that the browser needed it too.
  const SIGNED =
    "http://kong:8000/storage/v1/object/sign/documents/a/merchant/1/uuid?token=abc.def.ghi&download=x.pdf";

  it("re-points the origin at the client's API URL", () => {
    expect(reachableStorageUrl(SIGNED, "http://127.0.0.1:54321")).toBe(
      "http://127.0.0.1:54321/storage/v1/object/sign/documents/a/merchant/1/uuid?token=abc.def.ghi&download=x.pdf",
    );
  });

  it("leaves the path and token untouched", () => {
    // The token IS the signature. Rewriting the origin is only safe because it
    // is not bound to a hostname.
    const rewritten = new URL(
      reachableStorageUrl(SIGNED, "https://abc.supabase.co"),
    );
    expect(rewritten.pathname).toBe(new URL(SIGNED).pathname);
    expect(rewritten.searchParams.get("token")).toBe("abc.def.ghi");
    expect(rewritten.searchParams.get("download")).toBe("x.pdf");
  });

  it("is a no-op when the origins already agree", () => {
    // Which is production. The rewrite must not perturb the string at all
    // there — a re-serialised URL is a different URL to a signature check that
    // happened to depend on it.
    const same =
      "https://abc.supabase.co/storage/v1/object/sign/documents/k?token=t";
    expect(reachableStorageUrl(same, "https://abc.supabase.co")).toBe(same);
  });

  it("returns the URL unchanged rather than mangling it", () => {
    // A URL that might work beats one this function decided to rewrite badly.
    expect(reachableStorageUrl(SIGNED, undefined)).toBe(SIGNED);
    expect(reachableStorageUrl(SIGNED, "not a url")).toBe(SIGNED);
    expect(reachableStorageUrl("not a url", "http://127.0.0.1:54321")).toBe(
      "not a url",
    );
  });
});
