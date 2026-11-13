/**
 * The desktop sidebar's hidden/shown choice, remembered per device.
 *
 * Plain constants in a plain module because two sides need them: the client
 * toggle in components/sidebar-drawer.tsx, and the inline pre-paint script in
 * components/sidebar-collapse-script.tsx, which is a server component. A server
 * component importing a value from a "use client" file gets a client reference,
 * not the string.
 *
 * The attribute on <html>, not React state, is what hides the panel — through
 * one rule in app/globals.css scoped to the `md` breakpoint, so below it the
 * attribute does nothing and the phone drawer behaves exactly as before. That
 * is what lets the script set it before first paint: there is no flash of a
 * sidebar that then disappears once React hydrates.
 */
export const SIDEBAR_COLLAPSED_KEY = "tapswipe.sidebar.collapsed";
export const SIDEBAR_COLLAPSED_ATTR = "data-sidebar-collapsed";
