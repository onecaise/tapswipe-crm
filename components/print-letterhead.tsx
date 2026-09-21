import Image from "next/image";

/**
 * The Tapswipe mark at the head of a printed document.
 *
 * Shared by the three printable routes — /pre-apps/blank-form,
 * /merchants/[id]/print and /payouts/[period]/summary/[agentId] — so the three
 * cannot drift from one another, and reusing `public/logo-icon.png`, the same
 * file the sidebar renders. There is deliberately no second copy of the asset
 * and no print-specific export of it: one file means the printed mark changes
 * when the app's does.
 *
 * Three things here are load-bearing rather than decoration:
 *
 *   - **No `print:` utility of any kind, and that is the point.** This is the
 *     one element on these pages that must survive print media, and it sits
 *     inside each document's own <header> — precisely where the old global
 *     `header { display: none }` rule used to reach. The chrome hides itself
 *     now (see the print block in app/globals.css), so nothing here needs a
 *     `print:block` to fight a broad selector: there is no broad selector left.
 *     If one is ever reintroduced, e2e/print.spec.ts reds on this image.
 *
 *   - **`priority`.** next/image is lazy and async-decoded by default, and an
 *     image that has not finished loading when the print dialog opens prints as
 *     nothing — a failure that is invisible on screen. `priority` makes it
 *     eager and preloaded, so it is in hand before anyone can reach Ctrl+P.
 *
 *   - **The intrinsic size is ~4x the rendered one.** The browser picks a
 *     srcset candidate at layout time from the screen's DPR and does not pick
 *     again for the printer, so it rasterises whatever it already fetched.
 *     Asking for 176px wide to paint 44px means a 300dpi sheet gets a crisp
 *     mark instead of an upscaled 48px thumbnail. `w-auto` keeps the 835x603
 *     aspect rather than letting the two dimensions disagree.
 *
 * No white plate behind it, unlike the sidebar: that exists because the mark's
 * black linework would vanish on #0E0E10, and paper is already white. Which
 * also keeps it clear of print-color-adjust — a CSS background is what browsers
 * strip when printing, and an <img> is not.
 */
export function PrintLetterhead() {
  return (
    <div className="mb-3 flex items-center gap-2.5">
      <Image
        src="/logo-icon.png"
        alt="Tapswipe"
        width={176}
        height={127}
        priority
        className="h-8 w-auto"
      />
      <span className="text-[15px] font-bold tracking-[0.12em]">TAPSWIPE</span>
    </div>
  );
}
