"use client";

import { MenuIcon, XIcon } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react";

import { cn } from "@/lib/utils";

/**
 * The sidebar's open/closed state below the `md` breakpoint, and the two
 * controls that share it.
 *
 * Below 768px the sidebar is an off-canvas drawer behind a hamburger in the
 * topbar; at 768px and up it is the pinned 248px column it has always been. The
 * trigger lives in <AppTopbar> and the panel in <AppSidebar>, which are
 * siblings, so the state has to be context rather than a prop.
 *
 * ONE <aside>, RESTYLED — NOT A SECOND COPY, and that is a constraint rather
 * than a preference. Two e2e specs assert against these elements in Playwright's
 * strict mode, where a second match is an error rather than a first-wins:
 *
 *   e2e/print.spec.ts:37        expect(page.locator("aside")).toBeHidden()
 *   e2e/payouts-states.spec.ts  expect(page.getByRole("navigation")).toBeVisible()
 *
 * So a mobile copy of the panel would red two specs that have nothing to do with
 * navigation. It would also duplicate the open-ticket count query, and give
 * every nav link a twin — which is the ambiguity `display:none` exists to avoid.
 *
 * Every colour here is a token. The scrim is `bg-sidebar/60` rather than a
 * `bg-black/50` literal: globals.css stores its values as bare HSL triplets
 * precisely so `hsl(var(--sidebar) / 0.6)` works, so the overlay is the sidebar's
 * own colour at 60% and stays correct if that token is ever retuned.
 */

type SidebarContextValue = {
  open: boolean;
  setOpen: (open: boolean) => void;
};

const SidebarContext = createContext<SidebarContextValue | null>(null);

function useSidebar(): SidebarContextValue {
  const value = useContext(SidebarContext);

  if (value === null) {
    throw new Error("useSidebar must be used inside <SidebarProvider>");
  }

  return value;
}

/** Matches Tailwind's `md`. Kept next to the classes that assume it. */
const DESKTOP_QUERY = "(min-width: 768px)";

export function SidebarProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);

  // `open` must only ever mean something below md, so crossing up closes it.
  // Without this, opening the drawer on a phone and then rotating to a tablet
  // width leaves `open` true against a sidebar that is pinned anyway — which is
  // harmless to look at but leaves the scroll lock below stuck on.
  useEffect(() => {
    const desktop = window.matchMedia(DESKTOP_QUERY);

    const sync = () => {
      if (desktop.matches) setOpen(false);
    };

    sync();
    desktop.addEventListener("change", sync);
    return () => desktop.removeEventListener("change", sync);
  }, []);

  // The drawer covers the viewport behind a scrim, so the page underneath must
  // not scroll with it. Safe to do unconditionally because of the effect above:
  // `open` is false at md and up, so this never runs on a desktop viewport.
  useEffect(() => {
    if (!open) return;

    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previous;
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open]);

  const value = useMemo(() => ({ open, setOpen }), [open]);

  return (
    <SidebarContext.Provider value={value}>{children}</SidebarContext.Provider>
  );
}

/**
 * The <aside> itself, plus its scrim.
 *
 * A client component wrapping server-rendered children: AppSidebar stays a
 * server component and passes its logo header, streamed nav and streamed footer
 * straight through, so none of the Suspense boundaries described there move.
 */
export function SidebarShell({ children }: { children: React.ReactNode }) {
  const { open, setOpen } = useSidebar();

  // Tapping a nav link has to close the drawer, or every navigation on a phone
  // leaves the menu sitting over the page it just opened.
  //
  // Delegated from here rather than done with usePathname() in an effect, and
  // that is forced: next.config.ts sets cacheComponents, which makes
  // usePathname() runtime-only data that Next refuses to prerender unsuspended
  // (it is why components/sidebar-nav.tsx exists as a separate client component
  // inside its own boundary). Reading it here would drag the whole panel —
  // logo included — behind a Suspense boundary to learn something a click
  // already tells us.
  //
  // Scoped to anchors, so clicking a group heading or the user footer does not
  // dismiss the menu.
  const closeOnLink = useCallback(
    (event: React.MouseEvent<HTMLElement>) => {
      if (event.target instanceof Element && event.target.closest("a")) {
        setOpen(false);
      }
    },
    [setOpen],
  );

  return (
    <>
      {/*
        Rendered always and faded, rather than mounted on open, so the drawer
        has something to fade against on the way out as well as in. Inert when
        closed via pointer-events-none, and md:hidden so it cannot cover a
        desktop page if `open` is ever true there.
      */}
      <div
        aria-hidden
        onClick={() => setOpen(false)}
        className={cn(
          "fixed inset-0 z-40 bg-sidebar/60 transition-opacity duration-200 md:hidden print:hidden",
          open ? "opacity-100" : "pointer-events-none opacity-0",
        )}
      />

      <aside
        id="app-sidebar"
        onClick={closeOnLink}
        className={cn(
          // print:hidden here rather than an `aside` selector in globals.css:
          // the chrome hides itself, so a document's own semantic elements are
          // not collateral. See the print block in app/globals.css.
          "fixed left-0 top-0 z-50 flex h-screen w-[248px] shrink-0 flex-col bg-sidebar print:hidden",
          // `visibility` is in the transition on purpose. Without it the panel
          // stays visible: false, meaning its links keep taking tab stops while
          // parked off-screen — a keyboard user tabs into an invisible menu.
          // With it in the transition, the flip to hidden waits for the slide to
          // finish instead of snapping away at frame one.
          "transition-[transform,visibility] duration-200 ease-out",
          open ? "visible translate-x-0" : "invisible -translate-x-full",
          // At md and up it is the pinned column again: back in the flex row, so
          // the main column needs no matching left offset, and always shown
          // whatever `open` happens to be.
          "md:visible md:sticky md:left-auto md:z-auto md:translate-x-0",
        )}
      >
        {children}
      </aside>
    </>
  );
}

/**
 * The hamburger, mounted in the topbar and hidden from md up.
 *
 * Styled to match LogoutButton and the notifications bell exactly — same 36px
 * hit area, same hover and focus treatment — because it joins that row of
 * icon-only controls. Neither `primary` nor `destructive`: opening a menu is not
 * the page's main action and it is not a delete.
 */
export function SidebarTrigger() {
  const { open, setOpen } = useSidebar();

  return (
    <button
      type="button"
      onClick={() => setOpen(!open)}
      aria-controls="app-sidebar"
      aria-expanded={open}
      // Icon-only, so the name has to come from somewhere, and it has to say
      // what the press will DO rather than what is currently true.
      aria-label={open ? "Close navigation" : "Open navigation"}
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 md:hidden"
    >
      {open ? (
        <XIcon size={20} aria-hidden />
      ) : (
        <MenuIcon size={20} aria-hidden />
      )}
    </button>
  );
}
