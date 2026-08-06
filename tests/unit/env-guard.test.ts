import { describe, expect, it } from "vitest";

import {
  ALLOW_REMOTE_ENV_VAR,
  checkSupabaseEnv,
  isLocalSupabaseUrl,
} from "@/lib/env-guard";

const HOSTED = "https://vdjtosofrimipklbdjbi.supabase.co";
const LOCAL = "http://127.0.0.1:54321";

describe("isLocalSupabaseUrl", () => {
  it("accepts the hosts a local stack actually uses", () => {
    expect(isLocalSupabaseUrl("http://127.0.0.1:54321")).toBe(true);
    expect(isLocalSupabaseUrl("http://localhost:54321")).toBe(true);
    expect(isLocalSupabaseUrl("http://0.0.0.0:54321")).toBe(true);
    expect(isLocalSupabaseUrl("http://host.docker.internal:54321")).toBe(true);
  });

  it("rejects a hosted project", () => {
    expect(isLocalSupabaseUrl(HOSTED)).toBe(false);
  });

  it("is not fooled by a hostname that merely contains 'localhost'", () => {
    // The reason this matches on host rather than substring. A naive
    // url.includes("localhost") would call this local and wave it through.
    expect(isLocalSupabaseUrl("https://localhost.evil.example.com")).toBe(false);
    expect(isLocalSupabaseUrl("https://not-127.0.0.1.example.com")).toBe(false);
  });

  it("treats an unparseable URL as not local", () => {
    // The safe direction: the guard exists to catch mistakes, so ambiguity
    // should trip it rather than pass.
    expect(isLocalSupabaseUrl("127.0.0.1:54321")).toBe(false);
    expect(isLocalSupabaseUrl("")).toBe(false);
  });
});

describe("checkSupabaseEnv", () => {
  it("passes in development against the local stack", () => {
    expect(
      checkSupabaseEnv({
        url: LOCAL,
        nodeEnv: "development",
        allowRemote: false,
      }),
    ).toEqual({ ok: true });
  });

  it("fails in development against the hosted project", () => {
    const result = checkSupabaseEnv({
      url: HOSTED,
      nodeEnv: "development",
      allowRemote: false,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("remote");
    // The message has to name the offending URL and the way out, or it just
    // replaces one confusing symptom with another.
    expect(result.message).toContain(HOSTED);
    expect(result.message).toContain("supabase start");
    expect(result.message).toContain(ALLOW_REMOTE_ENV_VAR);
  });

  it("fails in development when the URL is missing entirely", () => {
    for (const url of [undefined, "", "   "]) {
      const result = checkSupabaseEnv({
        url,
        nodeEnv: "development",
        allowRemote: false,
      });
      expect(result.ok, `url=${JSON.stringify(url)}`).toBe(false);
      if (!result.ok) expect(result.reason).toBe("missing");
    }
  });

  it("allows a remote project when explicitly opted in", () => {
    // Debugging something that only reproduces against the hosted project is a
    // real need; it just has to be deliberate.
    expect(
      checkSupabaseEnv({ url: HOSTED, nodeEnv: "development", allowRemote: true }),
    ).toEqual({ ok: true });
  });

  it("does not constrain production, where hosted is correct", () => {
    expect(
      checkSupabaseEnv({
        url: HOSTED,
        nodeEnv: "production",
        allowRemote: false,
      }),
    ).toEqual({ ok: true });
  });

  it("does not constrain test, which targets its own stacks explicitly", () => {
    expect(
      checkSupabaseEnv({ url: HOSTED, nodeEnv: "test", allowRemote: false }),
    ).toEqual({ ok: true });
    expect(
      checkSupabaseEnv({ url: undefined, nodeEnv: "test", allowRemote: false }),
    ).toEqual({ ok: true });
  });
});
