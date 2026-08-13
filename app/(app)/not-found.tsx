import Link from "next/link";
import { SearchXIcon } from "lucide-react";

import { PageShell } from "@/components/page-shell";
import { Button } from "@/components/ui/button";

/**
 * What a rep sees when notFound() fires inside the app.
 *
 * Living in the route group means it renders inside the shell, with the sidebar
 * and search still there. The stock Next.js 404 is an unstyled black-on-white
 * page with no navigation at all, which turns a mistyped id or a stale link
 * into a dead end — and every detail page reaches for notFound() often, since
 * "not yours" and "does not exist" are deliberately the same answer.
 *
 * That is also why the copy does not promise the record is missing. An agent
 * following a link to another rep's merchant lands here, and the page must not
 * confirm that the id exists.
 */
export default function NotFound() {
  return (
    <PageShell width="form">
      <div className="flex flex-col items-start gap-4 py-12">
        <SearchXIcon size={32} className="text-muted-foreground" />
        <div className="flex flex-col gap-2">
          <h1 className="text-2xl font-semibold">We couldn&rsquo;t find that</h1>
          <p className="text-sm text-muted-foreground">
            The page or record you asked for isn&rsquo;t here. It may have been
            removed, or it may belong to another rep&rsquo;s book.
          </p>
        </div>
        <Button asChild size="sm">
          <Link href="/dashboard">Back to dashboard</Link>
        </Button>
      </div>
    </PageShell>
  );
}
