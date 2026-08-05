"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { ArrowRightIcon } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";

/**
 * Promotes a ghost sheet to a full lead.
 *
 * Calls the Tier 2 `convert_ghost_sheet_to_lead()` function rather than doing
 * the insert and update from here. The two writes have to both land or neither:
 * done client-side, a failure between them would leave a lead with no link back
 * to its sheet, and clicking again would create a second lead. The function body
 * is one transaction, so that state can't happen.
 *
 * No confirmation dialog: conversion is additive and reversible in the sense that
 * the new lead can be edited, and the sheet keeps its link. It's the one action
 * here that isn't a plain form submit, so it does get a disabled/pending state.
 */
export function ConvertGhostSheetButton({
  ghostSheetId,
}: {
  ghostSheetId: number;
}) {
  const [error, setError] = useState<string | null>(null);
  const [isConverting, setIsConverting] = useState(false);
  const router = useRouter();

  const convert = async () => {
    setIsConverting(true);
    setError(null);

    const supabase = createClient();
    const { data, error: rpcError } = await supabase.rpc(
      "convert_ghost_sheet_to_lead",
      { ghost_sheet_id_input: ghostSheetId },
    );

    if (rpcError) {
      // The function raises plain-language messages ('ghost sheet not found',
      // 'ghost sheet already converted') that are safe to show as-is — neither
      // reveals anything about rows the caller can't see.
      setError(rpcError.message);
      setIsConverting(false);
      return;
    }

    router.push(`/leads/${data}`);
    router.refresh();
  };

  return (
    <div className="flex flex-col gap-2 items-start">
      <Button onClick={convert} disabled={isConverting} size="sm">
        <ArrowRightIcon size={16} />
        {isConverting ? "Converting…" : "Convert to lead"}
      </Button>
      {error && <p className="text-sm text-red-500">{error}</p>}
    </div>
  );
}
