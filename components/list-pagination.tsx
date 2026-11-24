import Link from "next/link";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";

import { cn } from "@/lib/utils";

/**
 * Server-side pagination for a list: the total, which rows are on screen, the
 * page size, and Previous / Next — all links, so the page lives in the URL
 * like every filter and works with JavaScript off.
 *
 * First built for the merchants list (docs/design/merchants-and-dashboard.md
 * §1.4) and kept generic: it knows nothing about merchants beyond the noun.
 * Rendered above the list, where it also serves as the result count.
 *
 * An unavailable Previous or Next is a plain span with aria-disabled rather
 * than a link to the page you are on: a link that goes nowhere is a control
 * that lies.
 */
export function ListPagination({
  total,
  page,
  lastPage,
  size,
  sizes,
  hrefFor,
  noun,
}: {
  total: number;
  /** The page shown, 1-based, already clamped to lastPage. */
  page: number;
  lastPage: number;
  size: number;
  sizes: readonly number[];
  /** The list at a page and page size, every other param kept. */
  hrefFor: (page: number, size: number) => string;
  /** Singular and plural, e.g. ["merchant", "merchants"]. */
  noun: readonly [string, string];
}) {
  const first = total === 0 ? 0 : (page - 1) * size + 1;
  const last = Math.min(page * size, total);

  return (
    <nav
      aria-label="Pagination"
      className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 text-sm"
    >
      <p data-testid="list-total">
        <strong>{total.toLocaleString("en-US")}</strong>{" "}
        {total === 1 ? noun[0] : noun[1]}
        {total > 0 && (
          <span className="text-muted-foreground">
            {" "}
            · showing {first.toLocaleString("en-US")}–{last.toLocaleString("en-US")}
          </span>
        )}
      </p>

      <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
        <div className="flex items-center gap-1">
          <span className="text-muted-foreground">Per page</span>
          {sizes.map((option) => (
            <Link
              key={option}
              href={hrefFor(1, option)}
              aria-current={option === size ? "true" : undefined}
              aria-label={`${option} per page`}
              className={cn(
                "inline-flex min-h-11 min-w-11 lg:min-h-9 lg:min-w-9 items-center justify-center rounded-md px-2 font-medium focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
                option === size
                  ? "bg-foreground text-card"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {option}
            </Link>
          ))}
        </div>

        <div className="flex items-center gap-1">
          <PageLink href={page > 1 ? hrefFor(page - 1, size) : null} rel="prev">
            <ChevronLeftIcon size={16} aria-hidden />
            Previous
          </PageLink>
          <span className="px-1 text-muted-foreground">
            Page {page} of {lastPage}
          </span>
          <PageLink href={page < lastPage ? hrefFor(page + 1, size) : null} rel="next">
            Next
            <ChevronRightIcon size={16} aria-hidden />
          </PageLink>
        </div>
      </div>
    </nav>
  );
}

function PageLink({
  href,
  rel,
  children,
}: {
  href: string | null;
  rel: "prev" | "next";
  children: React.ReactNode;
}) {
  const className =
    "inline-flex min-h-11 lg:min-h-9 items-center gap-1 rounded-md border px-3 font-medium";
  if (href === null) {
    return (
      <span aria-disabled="true" className={cn(className, "text-muted-foreground opacity-50")}>
        {children}
      </span>
    );
  }
  return (
    <Link
      href={href}
      rel={rel}
      className={cn(
        className,
        "hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
      )}
    >
      {children}
    </Link>
  );
}
