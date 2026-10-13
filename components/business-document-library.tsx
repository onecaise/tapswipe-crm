import { FileTextIcon } from "lucide-react";

import { formatDate } from "@/lib/format";
import {
  type BusinessDocument,
  formatBytes,
  groupByCategory,
} from "@/lib/business-documents";
import { BusinessDocumentActions } from "@/components/business-document-actions";

/**
 * The rep-facing library, grouped by category. A server component with a
 * client island per row, like MarketingLibrary: the list has no state, only
 * the action buttons do.
 *
 * Every document here already has a file -- the page filters on hasFile()
 * rather than this component hiding rows, so a page that forgets is visibly
 * wrong rather than quietly short.
 */
export function BusinessDocumentLibrary({
  documents,
  emptyMessage = "No documents yet.",
}: {
  documents: BusinessDocument[];
  emptyMessage?: string;
}) {
  if (documents.length === 0) {
    return <p className="text-sm text-muted-foreground">{emptyMessage}</p>;
  }

  return (
    <div className="flex flex-col gap-6">
      {groupByCategory(documents).map((group) => (
        <section
          key={group.category}
          className="flex flex-col gap-2"
          aria-label={group.category}
        >
          <h2 className="text-xs uppercase tracking-wide text-muted-foreground">
            {group.category}
          </h2>
          <ul className="flex flex-col divide-y rounded-md border">
            {group.documents.map((doc) => (
              <li
                key={doc.id}
                className="flex flex-wrap items-center justify-between gap-4 p-3"
              >
                <div className="flex min-w-0 items-center gap-3">
                  <FileTextIcon
                    size={16}
                    className="shrink-0 text-muted-foreground"
                  />
                  <div className="flex min-w-0 flex-col">
                    <span className="truncate text-sm font-medium">
                      {doc.title}
                    </span>
                    <span className="truncate text-xs text-muted-foreground">
                      {doc.file_name ?? "—"}
                      {doc.size_bytes !== null
                        ? ` · ${formatBytes(doc.size_bytes)}`
                        : ""}{" "}
                      · {formatDate(doc.uploaded_at)}
                    </span>
                  </div>
                </div>
                <BusinessDocumentActions document={doc} />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
