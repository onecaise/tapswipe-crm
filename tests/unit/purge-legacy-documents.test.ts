import { describe, expect, it } from "vitest";

import {
  DEV_REF,
  DEV_URL,
  PROD_REF,
  assertDevTarget,
  countByOwnerType,
  listAllObjects,
  parseArgs,
  removeInBatches,
  rowsSafeToDelete,
} from "../../scripts/purge-legacy-documents.mjs";

/**
 * scripts/purge-legacy-documents.mjs, everything that can be checked without a
 * hosted project. The script only ever targets dev, and nothing in this repo's
 * test suites touches dev, so the refusals are pinned here and the Storage
 * helpers are driven against the local stack in
 * tests/live/purge-legacy-documents.test.ts.
 */

describe("arguments", () => {
  it("is a dry run unless --write is given", () => {
    expect(parseArgs(["--target", "dev"])).toEqual({ write: false, target: "dev" });
    expect(parseArgs(["--target", "dev", "--write"])).toEqual({ write: true, target: "dev" });
  });

  it("requires --target, and only accepts dev", () => {
    expect(() => parseArgs([])).toThrow(/--target dev is required/);
    expect(() => parseArgs(["--write"])).toThrow(/--target dev is required/);
    for (const other of ["prod", "local", "production", ""]) {
      expect(() => parseArgs(["--target", other]), other).toThrow(/must be dev/);
    }
  });

  it("refuses an option it does not know, rather than ignoring it", () => {
    expect(() => parseArgs(["--target", "dev", "--db-url", "x"])).toThrow(/Unknown option/);
  });
});

describe("target", () => {
  it("accepts dev's ref and dev's URL", () => {
    expect(() => assertDevTarget(DEV_REF, DEV_URL)).not.toThrow();
  });

  it("refuses prod by name", () => {
    expect(() =>
      assertDevTarget(PROD_REF, `https://${PROD_REF}.supabase.co`),
    ).toThrow(/Refusing PRODUCTION/);
  });

  it("refuses an unrecognised ref, and any host but dev's", () => {
    expect(() => assertDevTarget("abc", "https://abc.supabase.co")).toThrow(/not dev/);
    for (const url of [
      "http://127.0.0.1:54321",
      `https://${PROD_REF}.supabase.co`,
      `https://${DEV_REF}.supabase.co.evil.example`,
      `http://${DEV_REF}.supabase.co`,
      "not a url",
    ]) {
      expect(() => assertDevTarget(DEV_REF, url), url).toThrow();
    }
  });
});

describe("row bookkeeping", () => {
  const rows = [
    { id: 1, owner_type: "merchant", file_key: "a/merchant/1/x" },
    { id: 2, owner_type: "lead", file_key: "a/lead/2/y" },
    { id: 3, owner_type: "merchant", file_key: "a/merchant/3/z" },
  ];

  it("counts per owner_type", () => {
    expect(countByOwnerType(rows)).toEqual({ merchant: 2, lead: 1 });
  });

  it("deletes only rows whose object is gone, and keeps the rest", () => {
    const { deletable, kept } = rowsSafeToDelete(rows, ["a/merchant/3/z"]);
    expect(deletable.map((r: { id: number }) => r.id)).toEqual([1, 2]);
    expect(kept.map((r: { id: number }) => r.id)).toEqual([3]);
  });
});

/** An in-memory bucket with Storage's list()/remove() shapes: list is one
 *  level deep, folders come back with a null id, results are paged. */
function fakeStorage(initial: string[], failOn?: (batch: string[]) => boolean) {
  const objects = new Set(initial);
  const calls: string[][] = [];
  return {
    calls,
    objects,
    from: () => ({
      list: async (prefix: string, opts: { limit: number; offset: number }) => {
        const base = prefix === "" ? "" : `${prefix}/`;
        const children = new Map<string, boolean>();
        for (const key of objects) {
          if (!key.startsWith(base)) continue;
          const rest = key.slice(base.length);
          const [head, ...tail] = rest.split("/");
          children.set(head, children.get(head) === true || tail.length > 0);
        }
        const all = [...children.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([name, isFolder]) => ({ name, id: isFolder ? null : `id-${name}` }));
        return { data: all.slice(opts.offset, opts.offset + opts.limit), error: null };
      },
      remove: async (batch: string[]) => {
        calls.push(batch);
        if (failOn?.(batch)) return { data: null, error: { message: "boom" } };
        const gone = batch.filter((k) => objects.delete(k));
        return { data: gone.map((name) => ({ name })), error: null };
      },
    }),
  };
}

describe("listing the bucket itself", () => {
  it("finds every object at any depth, including orphans no row names", () => {
    const storage = fakeStorage([
      "agent-a/merchant/1/uuid-1",
      "agent-a/lead/2/uuid-2",
      "agent-b/pre_app/9/uuid-3",
      "stray-at-root.pdf",
      "agent-c/deep/er/still/file",
    ]);
    return listAllObjects(storage, "documents").then((keys: string[]) => {
      expect([...keys].sort()).toEqual(
        [
          "agent-a/lead/2/uuid-2",
          "agent-a/merchant/1/uuid-1",
          "agent-b/pre_app/9/uuid-3",
          "agent-c/deep/er/still/file",
          "stray-at-root.pdf",
        ].sort(),
      );
    });
  });

  it("pages past the list() limit rather than stopping at the first page", async () => {
    const many = Array.from({ length: 2345 }, (_, i) => `agent/merchant/1/f${String(i).padStart(5, "0")}`);
    const keys = await listAllObjects(fakeStorage(many), "documents");
    expect(keys).toHaveLength(2345);
  });
});

describe("removing in batches", () => {
  it("sends batches of the given size and reports what went", async () => {
    const keys = Array.from({ length: 250 }, (_, i) => `k/${i}`);
    const storage = fakeStorage(keys);
    const { removed, failed } = await removeInBatches(storage, "documents", keys, 100);
    expect(storage.calls.map((b) => b.length)).toEqual([100, 100, 50]);
    expect(removed).toHaveLength(250);
    expect(failed).toEqual([]);
    expect(storage.objects.size).toBe(0);
  });

  it("carries on past a failed batch and names every key in it", async () => {
    const keys = Array.from({ length: 30 }, (_, i) => `k/${i}`);
    const storage = fakeStorage(keys, (batch) => batch.includes("k/10"));
    const { removed, failed } = await removeInBatches(storage, "documents", keys, 10);
    expect(removed).toHaveLength(20);
    expect(failed.map((f: { key: string }) => f.key)).toEqual(keys.slice(10, 20));
  });
});
