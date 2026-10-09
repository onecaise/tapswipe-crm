import { FunctionsFetchError, FunctionsHttpError } from "@supabase/supabase-js";
import { describe, expect, it } from "vitest";

import { edgeFunctionErrorMessage } from "@/lib/edge-functions";

describe("edgeFunctionErrorMessage — what a person reads when a function fails", () => {
  it("prefers the function's own { error } body", async () => {
    const error = new FunctionsHttpError(
      new Response(JSON.stringify({ error: "That record is not yours." }), { status: 404 }),
    );
    expect(await edgeFunctionErrorMessage(error, "fallback")).toBe("That record is not yours.");
  });

  it("uses the caller's fallback for a non-JSON 5xx, never supabase-js's string (QA-008)", async () => {
    const error = new FunctionsHttpError(new Response("upstream connect error", { status: 503 }));
    expect(await edgeFunctionErrorMessage(error, "Could not open that document.")).toBe(
      "Could not open that document.",
    );
  });

  it("uses the fallback when the function could not be reached at all (QA-008)", async () => {
    const error = new FunctionsFetchError(new TypeError("fetch failed"));
    expect(await edgeFunctionErrorMessage(error, "Could not open that document.")).toBe(
      "Could not open that document.",
    );
  });

  it("still passes through a message from something that is not a supabase-js error", async () => {
    expect(await edgeFunctionErrorMessage(new Error("Choose a file first."), "x")).toBe(
      "Choose a file first.",
    );
  });
});
