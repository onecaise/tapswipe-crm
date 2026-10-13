import { describe, expect, it } from "vitest";

import {
  POST_LOGIN_FALLBACK,
  nextFromDeepLink,
  postLoginPath,
} from "@/lib/login-redirect";

/**
 * C1a (D-03). The proxy carries a signed-out user's deep link to /auth/login as
 * `?next=`, and the login form follows it after sign-in. Both ends go through
 * safeNextPath(); this file re-runs QA-001's bypass table against each end, so
 * neither can become the open redirect /auth/confirm was.
 */
const BYPASSES: Array<string | null> = [
  "https://evil.com",
  "//evil.com",
  "///evil.com",
  "/\\evil.com",
  "/\\/evil.com",
  "\\\\evil.com",
  "%2F%2Fevil.com",
  "/%2F/evil.com",
  "/%5Cevil.com",
  "javascript:alert(1)",
  "data:text/html,x",
  " //evil.com",
  "/\t/evil.com",
  "/%09/evil.com",
  "http:evil.com",
  "",
  null,
  "/%252F/evil.com",
];

describe("postLoginPath — where the login form goes after sign-in", () => {
  it.each(BYPASSES.map((v) => [JSON.stringify(v), v]))("falls back for next=%s", (_l, value) => {
    const search = value === null ? "" : `?${new URLSearchParams({ next: value })}`;
    expect(postLoginPath(search)).toBe(POST_LOGIN_FALLBACK);
  });

  it.each(["/leads/123?tab=a", "/ok?x=https://evil.com", "/proposals/new"])(
    "follows next=%s",
    (value) => {
      expect(postLoginPath(`?${new URLSearchParams({ next: value })}`)).toBe(value);
    },
  );

  it("goes to the dashboard with no next at all", () => {
    expect(POST_LOGIN_FALLBACK).toBe("/dashboard");
    expect(postLoginPath("")).toBe("/dashboard");
    expect(postLoginPath("?other=1")).toBe("/dashboard");
  });
});

describe("nextFromDeepLink — what the proxy puts in ?next=", () => {
  it("keeps the path and query of a real deep link", () => {
    expect(nextFromDeepLink("/leads/7", "?tab=notes")).toBe("/leads/7?tab=notes");
    expect(nextFromDeepLink("/proposals/new", "")).toBe("/proposals/new");
  });

  it("drops Next's internal _rsc parameter", () => {
    expect(nextFromDeepLink("/leads", "?_rsc=abc123")).toBe("/leads");
    expect(nextFromDeepLink("/leads", "?status=new&_rsc=abc")).toBe("/leads?status=new");
  });

  it("returns null when there is nothing worth returning to", () => {
    expect(nextFromDeepLink("/dashboard", "")).toBeNull();
  });

  // A request path can itself be hostile: http://host//evil.com has pathname
  // "//evil.com". Whatever arrives, the proxy must not write it into ?next=.
  it.each(
    BYPASSES.filter((v): v is string => v !== null && v.startsWith("/")).map((v) => [v]),
  )("refuses a hostile request path %s", (value) => {
    expect(nextFromDeepLink(value, "")).toBeNull();
  });
});
