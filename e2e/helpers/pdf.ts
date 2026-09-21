import { inflateSync } from "node:zlib";

/**
 * A minimal reader for the one question `emulateMedia` cannot answer: what is
 * on each SHEET.
 *
 * Playwright can tell you a running head is visible under print media. It
 * cannot tell you it repeats, because print emulation applies the stylesheet
 * without ever paginating — a mark that prints on sheet 1 and nowhere else
 * looks identical to a correct one in every screen-based assertion. The only
 * artefact that has sheets in it is a real PDF, so this reads one.
 *
 * Deliberately not a PDF library. It answers exactly one question — which
 * pages reference an Image XObject — against Chrome's own uncomplicated
 * output, and a dependency that can parse all of PDF would be a lot of
 * surface for that. It is not a general parser and should not grow into one.
 *
 * Two things it does on purpose, both learned by getting them wrong first:
 *
 *   - Only page objects and the dicts they reference are read. A global sweep
 *     for `N 0 obj` desyncs on compressed image bytes that happen to contain
 *     the same pattern, which made the first version report no images at all
 *     on a page that visibly had one.
 *   - Page order comes from the page tree's /Kids, not from object numbers,
 *     which are not required to be in page order.
 */
export type PdfPage = {
  /** 1-based, in reading order. */
  page: number;
  /** One entry per Image XObject actually drawn on this page. */
  images: string[];
};

export function imagesPerPage(pdf: Buffer): PdfPage[] {
  const raw = pdf.toString("latin1");

  /** Object N's dict text — stops at `stream`, never runs into binary. */
  const dictOf = (n: number): string => {
    const at = raw.indexOf(`\n${n} 0 obj`);
    if (at < 0) return "";
    const from = at + `\n${n} 0 obj`.length;
    const stops = ["stream", "endobj"]
      .map((k) => raw.indexOf(k, from))
      .filter((i) => i > 0);
    return stops.length > 0 ? raw.slice(from, Math.min(...stops)) : "";
  };

  const streamOf = (n: number): string => {
    const at = raw.indexOf(`\n${n} 0 obj`);
    if (at < 0) return "";
    let s = raw.indexOf("stream", at);
    if (s < 0) return "";
    s += "stream".length;
    if (raw[s] === "\r") s++;
    if (raw[s] === "\n") s++;
    const end = raw.indexOf("endstream", s);
    try {
      return inflateSync(pdf.subarray(s, end)).toString("latin1");
    } catch {
      return raw.slice(s, end);
    }
  };

  const kids = /\/Type\s*\/Pages[\s\S]*?\/Kids\s*\[([^\]]*)\]/.exec(raw);
  const order = kids
    ? [...kids[1].matchAll(/(\d+)\s+0\s+R/g)].map((m) => Number(m[1]))
    : [];

  return order.map((num, index) => {
    const body = dictOf(num);

    // Which of this page's XObjects are images rather than forms?
    const xobjects = /\/XObject\s*<<([\s\S]*?)>>/.exec(body);
    const imageNames = new Set<string>();
    if (xobjects) {
      for (const [, name, ref] of xobjects[1].matchAll(
        /\/(\w+)\s+(\d+)\s+0\s+R/g,
      )) {
        if (/\/Subtype\s*\/Image/.test(dictOf(Number(ref)))) imageNames.add(name);
      }
    }

    // Declared in the resources is not the same as painted, so the content
    // stream has to show the `Do`.
    const contents = /\/Contents\s+(\d+)\s+0\s+R/.exec(body);
    const stream = contents ? streamOf(Number(contents[1])) : "";
    const images = [...stream.matchAll(/\/(\w+)\s+Do\b/g)]
      .map((m) => m[1])
      .filter((name) => imageNames.has(name));

    return { page: index + 1, images };
  });
}

/** "OO.O" — one character per sheet, for a failure message worth reading. */
export function sheetMap(pages: PdfPage[]): string {
  return pages.map((p) => (p.images.length > 0 ? "O" : ".")).join("");
}
