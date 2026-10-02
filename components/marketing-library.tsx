import { FileTextIcon } from "lucide-react";

import { formatDate } from "@/lib/format";
import {
  type MarketingMaterial,
  groupByCategory,
} from "@/lib/marketing-materials";
import { MarketingMaterialActions } from "@/components/marketing-material-actions";

/**
 * The rep-facing library, grouped by category.
 *
 * A server component with a client island per row — the list itself has no
 * state, and only the four action buttons do. Rendering the whole thing as a
 * client component would ship the grouping logic to the browser for nothing.
 *
 * Every material shown here already has a file: the caller filters on hasFile()
 * rather than this component hiding rows, so a page that forgets is visibly
 * wrong rather than quietly short. See the admin page, which deliberately shows
 * the unfinished ones.
 */
export function MarketingLibrary({
  materials,
  leadId,
  agentId,
  emptyMessage = "No marketing materials yet.",
}: {
  materials: MarketingMaterial[];
  /** The lead every action here is logged against, or null on the library page. */
  leadId: number | null;
  agentId: string;
  emptyMessage?: string;
}) {
  if (materials.length === 0) {
    return <p className="text-sm text-muted-foreground">{emptyMessage}</p>;
  }

  const groups = groupByCategory(materials);

  return (
    <div className="flex flex-col gap-6">
      {groups.map((group) => (
        <section key={group.category} className="flex flex-col gap-2">
          <h3 className="text-xs uppercase tracking-wide text-muted-foreground">
            {group.category}
          </h3>
          <ul className="flex flex-col divide-y rounded-md border">
            {group.materials.map((material) => (
              <li
                key={material.id}
                className="flex flex-wrap items-center justify-between gap-4 p-3"
              >
                <div className="flex items-center gap-3 min-w-0">
                  <FileTextIcon
                    size={16}
                    className="text-muted-foreground shrink-0"
                  />
                  <div className="flex flex-col min-w-0">
                    <span className="text-sm font-medium truncate">
                      {material.title}
                    </span>
                    <span className="text-xs text-muted-foreground truncate">
                      {material.file_name ?? "—"} ·{" "}
                      {formatDate(material.uploaded_at)}
                    </span>
                  </div>
                </div>
                <MarketingMaterialActions
                  material={material}
                  leadId={leadId}
                  agentId={agentId}
                />
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  );
}
