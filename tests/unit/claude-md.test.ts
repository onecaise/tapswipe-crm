import { readdir, readFile } from "node:fs/promises";

import { describe, expect, it } from "vitest";

/**
 * CLAUDE.md's Docs index must sit ABOVE the `nextjs-agent-rules` block.
 *
 * `next dev` (node_modules/next/dist/server/lib/generate-agent-files.js)
 * regenerates everything between BEGIN and END and drops anything else in
 * there. The index lived inside the block from 19 Oct 2026, and the first
 * e2e run on 21 Oct (Playwright starts `next dev`) deleted it from the
 * working tree. Nothing failed; the diff was the only sign.
 */

const BEGIN = "<!-- BEGIN:nextjs-agent-rules -->";
const END = "<!-- END:nextjs-agent-rules -->";

async function claudeMd(): Promise<string> {
  return (await readFile("CLAUDE.md", "utf8")).replace(/\r\n/g, "\n");
}

describe("CLAUDE.md and the next dev managed block", () => {
  it("has exactly one managed block", async () => {
    const md = await claudeMd();
    expect(md.split(BEGIN)).toHaveLength(2);
    expect(md.split(END)).toHaveLength(2);
    expect(md.indexOf(BEGIN)).toBeLessThan(md.indexOf(END));
  });

  it("keeps the Docs index above the block", async () => {
    const md = await claudeMd();
    const index = md.indexOf("\n## Docs index\n");
    expect(index).toBeGreaterThan(-1);
    expect(index).toBeLessThan(md.indexOf(BEGIN));
  });

  it("holds none of our headings inside the block", async () => {
    const md = await claudeMd();
    const block = md.slice(md.indexOf(BEGIN), md.indexOf(END));
    const headings = block.split("\n").filter((line) => /^#{1,6} /.test(line));
    expect(headings).toEqual(["# This is NOT the Next.js you know"]);
  });

  it("lists every docs/claude file in the index", async () => {
    const md = await claudeMd();
    const index = md.slice(md.indexOf("\n## Docs index\n"), md.indexOf(BEGIN));
    const files = (await readdir("docs/claude")).filter((f) => f.endsWith(".md")).sort();
    const missing = files.filter((f) => !index.includes(`\`docs/claude/${f}\``));
    expect(missing).toEqual([]);
  });
});
