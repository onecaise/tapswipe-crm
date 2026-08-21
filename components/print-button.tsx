"use client";

import { PrinterIcon } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * Opens the browser's print dialog.
 *
 * A client component for one line, because window.print() cannot be called from a
 * server component — and worth keeping separate so the summary page itself stays a
 * server component and needs no "use client" of its own.
 */
export function PrintButton() {
  return (
    <Button type="button" size="sm" onClick={() => window.print()}>
      <PrinterIcon size={16} />
      Print / Save as PDF
    </Button>
  );
}
