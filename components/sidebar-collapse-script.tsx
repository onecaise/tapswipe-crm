import { SIDEBAR_COLLAPSED_ATTR, SIDEBAR_COLLAPSED_KEY } from "@/lib/sidebar";

/**
 * Applies a remembered "sidebar hidden" choice before the sidebar paints.
 *
 * Rendered in the (app) layout ahead of <AppSidebar>, so the browser runs it
 * while parsing, before the <aside> exists — the CSS rule keyed on the
 * attribute then applies from the first frame. Waiting for React to read
 * localStorage after hydration would show the panel and then yank it away.
 *
 * try/catch because storage can throw (blocked site data, some private modes);
 * then nothing is set and the sidebar shows, which is the default anyway.
 *
 * Fixed text with no interpolated input, so dangerouslySetInnerHTML carries no
 * injection risk; the only CSP header is `frame-ancestors`, which does not
 * govern inline scripts. <html> carries suppressHydrationWarning (app/layout.tsx),
 * so the attribute this adds before hydration is not reported as a mismatch.
 */
const SCRIPT = `try{if(localStorage.getItem(${JSON.stringify(
  SIDEBAR_COLLAPSED_KEY,
)})==="1")document.documentElement.setAttribute(${JSON.stringify(
  SIDEBAR_COLLAPSED_ATTR,
)},"")}catch(e){}`;

export function SidebarCollapseScript() {
  return <script dangerouslySetInnerHTML={{ __html: SCRIPT }} />;
}
