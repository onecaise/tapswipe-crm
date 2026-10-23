"use client";

import { forwardRef, type SelectHTMLAttributes } from "react";

import { cn } from "@/lib/utils";
import { processorOptions, type Processor } from "@/lib/processors";

/**
 * The one processor drop-down (phase 1 of docs/design/intake-and-reports.md).
 *
 * A native <select>, like the status and billing-type selects beside it, so it
 * works with both the merchant form's controlled state and react-hook-form's
 * register() in the pre-app wizard (hence forwardRef and the pass-through
 * props). The value is the processor code, or "" for not set; callers turn ""
 * into NULL before writing.
 */
export const ProcessorSelect = forwardRef<
  HTMLSelectElement,
  Omit<SelectHTMLAttributes<HTMLSelectElement>, "children"> & {
    processors: readonly Processor[];
    /** The value the field holds now, so an unlisted one is shown, not dropped. */
    current: string | null | undefined;
  }
>(function ProcessorSelect({ processors, current, className, ...props }, ref) {
  return (
    <select
      ref={ref}
      className={cn(
        "border-input bg-background ring-offset-background focus-visible:ring-ring flex h-10 w-full rounded-md border px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none disabled:opacity-50",
        className,
      )}
      {...props}
    >
      {processorOptions(processors, current).map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
});
