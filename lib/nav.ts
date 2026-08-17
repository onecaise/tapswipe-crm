import {
  BanknoteIcon,
  BugIcon,
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
      // Notes and tasks are written on the four owner records (lead, pre-app,
      // merchant, ghost sheet) through components/{notes,tasks}-panel. These
      // pages are the cross-record view of the same rows — read-only for notes,
      // read plus the complete toggle for tasks. Creation stays on the record,
      // where owner_type/owner_id come from a parent row loaded under RLS.
      { label: "Notes", href: "/notes", icon: StickyNoteIcon },
      { label: "Tasks", href: "/tasks", icon: ListTodoIcon },
      // Not admin-only: every rep uploads and downloads their own documents.
      // It sat under "Admin" and gave agents a one-item section with that
      // header over a page they use daily.
      { label: "Documents", href: "/documents", icon: FolderIcon },
      // Also not admin-only, and for the same reason. Importing residuals and
      // entering the figures is admin work, but a rep reading their own
      // residuals is the point of putting them in the CRM at all — the select
      // policy on rep_payout_rows is own-or-admin like every other list here.
      // The import pages live under /payouts/import and need no entry of their
      // own: isNavItemActive is a prefix match, so they keep this item lit.
      { label: "Payouts", href: "/payouts", icon: BanknoteIcon },
    ],
  },
  {
    label: "Admin",
    items: [
      { label: "Users", href: "/admin/users", icon: UsersIcon, adminOnly: true },
      // /admin/bug-reports existed with no nav entry at all, so the queue the
      // bubble promises ("sent to the admins") was reachable only by typing
      // the URL.
      {
        label: "Bug Reports",
        href: "/admin/bug-reports",
        icon: BugIcon,
        adminOnly: true,
      },
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
