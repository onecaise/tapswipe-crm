"use client";

import { Button } from "@/components/ui/button";

/**
 * The confirmation step for an action that cannot be undone.
 *
 * Inline rather than window.confirm, which blocks the page, cannot be styled,
 * and cannot be tested. It replaces the control it guards rather than appearing
 * beside it, so the confirm lands where the eye already is and there is no
 * second button competing for the same click.
 *
 * Lifted out of user-row-actions.tsx, which had the only copy. Everything else
 * that destroyed something did it on one click of an unlabelled trash icon:
 * notes, tasks, ticket replies and documents. Notes are append-only by design
 * -- there is deliberately no update policy and, since 20260812143407, no update
 * grant -- so a mis-clicked delete there is unrecoverable by construction. The
 * design system already asked for this ("always behind a confirmation step");
 * the panels simply predated the rule.
 *
 * `destructive` picks the red: brand red for a confirm that merely commits
 * something, destructive red for one that removes data.
 */
export function ConfirmPair({
  label,
  confirmLabel = "Confirm",
  onConfirm,
  onCancel,
  busy,
  destructive = false,
}: {
  label: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  busy: boolean;
  destructive?: boolean;
}) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="text-xs text-muted-foreground">{label}</span>
      <Button
        type="button"
        size="sm"
        variant={destructive ? "destructive" : "default"}
        disabled={busy}
        onClick={onConfirm}
      >
        {busy ? "Working…" : confirmLabel}
      </Button>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        disabled={busy}
        onClick={onCancel}
      >
        Cancel
      </Button>
    </span>
  );
}
