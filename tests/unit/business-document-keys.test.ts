import { describe, expect, it } from "vitest";

import {
  BUSINESS_DOCUMENTS_BUCKET,
  buildBusinessDocumentKey,
  fileKeyMatchesBusinessDocument,
  parseBusinessDocumentKey,
  sanitizeFileName,
  sizeOrNull,
} from "../../supabase/functions/_shared/business-documents";
import { BUSINESS_DOCUMENTS_BUCKET as BROWSER_BUCKET } from "../../lib/business-documents";

/**
 * The key rules business-document-file-url applies before it signs anything,
 * runnable under Node because the module is dependency-free. They must agree
 * with business_documents_file_key_matches_id exactly; the RLS suite covers the
 * constraint side.
 */

describe("the bucket name has one definition", () => {
  it("is the same constant in the function and the browser", () => {
    // lib/business-documents.ts re-exports rather than copies. A drift would
    // sign into one bucket and upload into another.
    expect(BROWSER_BUCKET).toBe(BUSINESS_DOCUMENTS_BUCKET);
    expect(BUSINESS_DOCUMENTS_BUCKET).toBe("business-documents");
  });
});

describe("sanitizeFileName", () => {
  it("keeps a path separator or traversal from reaching the key", () => {
    expect(sanitizeFileName("../marketing/x.pdf")).toBe("_marketing_x.pdf");
    expect(sanitizeFileName("..")).toBe("document");
    expect(sanitizeFileName("a b/c.pdf")).toBe("a_b_c.pdf");
  });

  it("falls back to a name for empty input and caps the length", () => {
    expect(sanitizeFileName("   ")).toBe("document");
    expect(sanitizeFileName(42)).toBe("document");
    expect(sanitizeFileName("x".repeat(500))).toHaveLength(120);
  });
});

describe("file keys", () => {
  it("builds {id}/{name} and reads it back", () => {
    const key = buildBusinessDocumentKey(7, "Chargeback policy.pdf");
    expect(key).toBe("7/Chargeback_policy.pdf");
    expect(parseBusinessDocumentKey(key)).toEqual({
      documentId: 7,
      fileName: "Chargeback_policy.pdf",
    });
  });

  it("matches only its own id, structurally", () => {
    expect(fileKeyMatchesBusinessDocument("7/a.pdf", 7)).toBe(true);
    expect(fileKeyMatchesBusinessDocument("7/a.pdf", "7")).toBe(true);
    for (const [key, id] of [
      ["8/a.pdf", 7],
      ["70/a.pdf", 7],
      ["7/", 7],
      ["7/a/b.pdf", 7],
      ["/7/a.pdf", 7],
      ["0/a.pdf", 0],
      ["x/a.pdf", 7],
    ] as const) {
      expect(fileKeyMatchesBusinessDocument(key, id), `${key} vs ${id}`).toBe(false);
    }
    expect(fileKeyMatchesBusinessDocument(null, 7)).toBe(false);
  });
});

describe("sizeOrNull", () => {
  it("keeps a non-negative integer and drops anything else", () => {
    expect(sizeOrNull(0)).toBe(0);
    expect(sizeOrNull(2048)).toBe(2048);
    for (const bad of [-1, 1.5, "2048", null, undefined, Number.MAX_VALUE]) {
      expect(sizeOrNull(bad), String(bad)).toBeNull();
    }
  });
});

describe("friendly library errors (the QA-008 rule)", () => {
  const FALLBACK = "Could not open that document.";

  it("turns the function's known answers into sentences", async () => {
    const { friendlyLibraryError, LIBRARY_ERROR_MESSAGES } = await import(
      "../../lib/business-documents"
    );
    for (const [raw, friendly] of Object.entries(LIBRARY_ERROR_MESSAGES)) {
      expect(friendlyLibraryError(raw, 404, FALLBACK)).toBe(friendly);
    }
  });

  it("never shows a server fault's raw text", async () => {
    const { friendlyLibraryError } = await import("../../lib/business-documents");
    expect(
      friendlyLibraryError(
        "Could not create upload URL: The related resource does not exist",
        500,
        FALLBACK,
      ),
    ).toBe(FALLBACK);
    // No status: the request never got an answer.
    expect(friendlyLibraryError("upstream connect error", undefined, FALLBACK)).toBe(
      FALLBACK,
    );
    expect(friendlyLibraryError(null, 400, FALLBACK)).toBe(FALLBACK);
  });

  it("passes an unrecognised 4xx through rather than guessing", async () => {
    const { friendlyLibraryError } = await import("../../lib/business-documents");
    expect(friendlyLibraryError("title is required", 400, FALLBACK)).toBe(
      "title is required",
    );
  });

  it("names the size limit for a 413 from Storage, and nothing else", async () => {
    const { friendlyUploadError } = await import("../../lib/business-documents");
    expect(
      friendlyUploadError({ message: "The object exceeded the maximum allowed size" }, "Upload failed."),
    ).toBe("That file is larger than the 50 MiB limit.");
    expect(friendlyUploadError({ message: "network down" }, "Upload failed.")).toBe(
      "Upload failed.",
    );
  });
});
