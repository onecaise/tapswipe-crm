import { describe, expect, it } from "vitest";

import { formatBytes, oversizeMessage } from "../../lib/file-size";
import {
  MAX_BUSINESS_DOCUMENT_BYTES,
  businessDocumentUploadProblem,
} from "../../lib/business-documents";
import {
  MAX_MATERIAL_BYTES,
  materialUploadProblem,
} from "../../lib/marketing-materials";

/**
 * The size sentence both upload forms show. The defect this pins: a file over
 * the limit by less than the formatter's rounding read "That file is 50 MiB.
 * The limit is 50 MiB." -- a refusal that contradicts itself.
 */

const MiB = 1024 * 1024;
const LIMIT = 50 * MiB;

describe("formatBytes", () => {
  it("keeps bytes, one decimal under 10 of a unit, none above", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1023)).toBe("1023 B");
    expect(formatBytes(1024)).toBe("1.0 KiB");
    expect(formatBytes(9.84 * MiB)).toBe("9.8 MiB");
    expect(formatBytes(LIMIT)).toBe("50 MiB");
    // The rounding that caused the contradiction, stated outright.
    expect(formatBytes(LIMIT + 1)).toBe("50 MiB");
  });
});

describe("oversizeMessage", () => {
  it("accepts exactly the limit, as the bucket does", () => {
    expect(oversizeMessage(LIMIT, LIMIT)).toBeNull();
    expect(oversizeMessage(LIMIT - 1, LIMIT)).toBeNull();
  });

  it("says 'slightly over' for 50 MiB plus one byte, never 50 MiB vs 50 MiB", () => {
    expect(oversizeMessage(LIMIT + 1, LIMIT)).toBe(
      "That file is slightly over the 50 MiB limit.",
    );
  });

  it("quotes both sizes once they read differently", () => {
    expect(oversizeMessage(51 * MiB, LIMIT)).toBe(
      "That file is 51 MiB. The limit is 50 MiB.",
    );
    expect(oversizeMessage(4 * 1024 * MiB, LIMIT)).toBe(
      "That file is 4.0 GiB. The limit is 50 MiB.",
    );
  });

  it("never quotes a size that reads the same as the limit", () => {
    // Every size from just over the limit to 2 MiB over, in 64 KiB steps,
    // plus the boundaries of the rounding band.
    const sizes = [LIMIT + 1, LIMIT + MiB / 2 - 1, LIMIT + MiB / 2, LIMIT + MiB / 2 + 1];
    for (let s = LIMIT + 1; s <= LIMIT + 2 * MiB; s += 64 * 1024) sizes.push(s);
    for (const size of sizes) {
      const message = oversizeMessage(size, LIMIT)!;
      const quoted = /^That file is (.+)\. The limit is (.+)\.$/.exec(message);
      if (quoted) expect(quoted[1], `${size} bytes: ${message}`).not.toBe(quoted[2]);
      else expect(message, `${size} bytes`).toBe("That file is slightly over the 50 MiB limit.");
    }
  });
});

describe("both forms use it", () => {
  for (const [name, problem, limit] of [
    ["business documents", businessDocumentUploadProblem, MAX_BUSINESS_DOCUMENT_BYTES],
    ["marketing materials", materialUploadProblem, MAX_MATERIAL_BYTES],
  ] as const) {
    it(`${name}: empty refused, exactly the limit accepted, a byte over refused plainly`, () => {
      expect(problem({ size: 0 })).toBe("That file is empty.");
      expect(problem({ size: limit })).toBeNull();
      expect(problem({ size: limit + 1 })).toBe(
        "That file is slightly over the 50 MiB limit.",
      );
      expect(problem({ size: 60 * MiB })).toBe(
        "That file is 60 MiB. The limit is 50 MiB.",
      );
    });
  }
});
