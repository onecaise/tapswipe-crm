import {
  ClipboardListIcon,
  FolderIcon,
  GhostIcon,
  LifeBuoyIcon,
  ListTodoIcon,
  StickyNoteIcon,
  StoreIcon,
  TargetIcon,
  UsersIcon,
  type LucideIcon,
} from "lucide-react";

/**
 * The sidebar's contents, as data.
 *
 * Kept out of the sidebar component so that adding a section, reordering items
 * or turning a placeholder into a real link is an edit here rather than surgery
 * on JSX. The icon mapping matches the one the dashboard established.
 */
export type NavItem = {
  label: string;
  /**
   * Omitted for items that have no page yet. Those render as muted,
   * non-interactive rows rather than links, because a link to a route that does
   * not exist is a 404 dressed up as navigation.
   */
  href?: string;
  icon: LucideIcon;
  /** Hidden from agents. A UX nicety only — the route enforces its own boundary. */
  adminOnly?: boolean;
  /** Which count, if any, this item shows as a pill. */
  badge?: "openTickets";
};

export type NavGroup = {
  label: string;
  items: NavItem[];
};

export const NAV_GROUPS: readonly NavGroup[] = [
  {
    label: "Sales",
    items: [
      { label: "Leads", href: "/leads", icon: TargetIcon },
      { label: "Ghost Sheets", href: "/ghost-sheets", icon: GhostIcon },
      { label: "Merchants", href: "/merchants", icon: StoreIcon },
    ],
  },
  {
    label: "Operations",
    items: [
      { label: "Pre-Apps", href: "/pre-apps", icon: ClipboardListIcon },
      {
        label: "Support Tickets",
        href: "/support-tickets",
        icon: LifeBuoyIcon,
        badge: "openTickets",
      },
      // Notes and tasks are panels on the four owner records (lead, pre-app,
      // merchant, ghost sheet), not pages — see components/{notes,tasks}-panel.
      // Listed without an href so the section reads complete without offering a
      // link that would 404. Give them an href once the pages exist.
      { label: "Notes", icon: StickyNoteIcon },
      { label: "Tasks", icon: ListTodoIcon },
    ],
  },
  {
    label: "Admin",
    items: [
      { label: "Users", href: "/admin/users", icon: UsersIcon, adminOnly: true },
      { label: "Documents", href: "/documents", icon: FolderIcon },
    ],
  },
];

/**
 * Whether a nav item should read as active for the current path.
 *
 * Prefix match, so /leads/7/edit keeps Leads lit rather than leaving the whole
 * sidebar looking inactive on every detail and form page. The boundary check on
 * the next character stops /admin/users from also lighting a hypothetical
 * /admin item, and /documents-archive from lighting /documents.
 */
export function isNavItemActive(href: string, pathname: string): boolean {
  return pathname === href || pathname.startsWith(`${href}/`);
}
