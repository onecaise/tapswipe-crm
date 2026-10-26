"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { PencilIcon } from "lucide-react";

import { REP_IDENTITY_MAX_LENGTH } from "@/lib/admin-users";
import { createClient } from "@/lib/supabase/client";
import { EMPTY } from "@/lib/format";
import { StatusBadge } from "@/components/status-badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * A rep's legal name and LLC legal name, set or changed in place on the users
 * list (phase 2 of docs/design/intake-and-reports.md).
 *
 * The TerritoryCell shape, with two fields because set_rep_identity() writes the
 * pair in one call. That RPC is the only write path: profiles has no UPDATE
 * grant or policy, so even an admin's PATCH is "permission denied". It re-checks
 * is_admin() itself, so nothing on this screen is a security boundary.
 *
 * A blank box is sent as null, which clears that value. The RPC refuses a blank
 * STRING outright, so the conversion has to happen here, and the hint below
 * says what saving blank does.
 *
 * Reps (role 'agent') missing either value carry a "can't submit pre-apps yet"
 * marker: phase 4 refuses their pre-app submit until both are set (memo §0.6).
 */
export function RepIdentityCell({
  userId,
  fullName,
  role,
  legalName,
  llcLegalName,
}: {
  userId: string;
  fullName: string;
  role: string;
  legalName: string | null;
  llcLegalName: string | null;
}) {
  const router = useRouter();

  const [editing, setEditing] = useState(false);
  const [legal, setLegal] = useState(legalName ?? "");
  const [llc, setLlc] = useState(llcLegalName ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const missing = legalName === null || llcLegalName === null;

  const cancel = () => {
    setEditing(false);
    setError(null);
  };

  const save = async () => {
    setBusy(true);
    setError(null);

    const supabase = createClient();
    const { error: rpcError } = await supabase.rpc("set_rep_identity", {
      user_id: userId,
      legal_name: legal.trim() === "" ? null : legal,
      llc_legal_name: llc.trim() === "" ? null : llc,
    });

    if (rpcError) {
      // Every raise in that function is written to be read by a person
      // ("legal name must be 200 characters or fewer"), so it is shown as is.
      setError(rpcError.message);
      setBusy(false);
      return;
    }

    setBusy(false);
    setEditing(false);
    router.refresh();
  };

  if (!editing) {
    return (
      <span className="flex items-start gap-1.5">
        <span className="flex flex-col gap-0.5 text-sm">
          <span>{legalName ?? EMPTY}</span>
          <span className="text-xs text-muted-foreground">
            {llcLegalName ?? EMPTY}
          </span>
          {/* Amber, not red: waiting on an admin, like "temp password". */}
          {role === "agent" && missing && (
            <StatusBadge intent="warning">can&apos;t submit pre-apps yet</StatusBadge>
          )}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 px-1.5"
          aria-label={`${missing ? "Set" : "Change"} legal names for ${fullName}`}
          onClick={() => {
            setLegal(legalName ?? "");
            setLlc(llcLegalName ?? "");
            setError(null);
            setEditing(true);
          }}
        >
          <PencilIcon size={12} />
        </Button>
      </span>
    );
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault();
      void save();
    }
    if (event.key === "Escape") cancel();
  };

  return (
    <span className="flex flex-col gap-1">
      <Input
        aria-label={`Legal name for ${fullName}`}
        placeholder="Legal name"
        value={legal}
        maxLength={REP_IDENTITY_MAX_LENGTH}
        disabled={busy}
        autoFocus
        onChange={(event) => setLegal(event.target.value)}
        onKeyDown={onKeyDown}
        className="h-7 w-48 text-xs"
      />
      <Input
        aria-label={`LLC legal name for ${fullName}`}
        placeholder="LLC legal name"
        value={llc}
        maxLength={REP_IDENTITY_MAX_LENGTH}
        disabled={busy}
        onChange={(event) => setLlc(event.target.value)}
        onKeyDown={onKeyDown}
        className="h-7 w-48 text-xs"
      />
      <span className="flex items-center gap-1.5">
        <Button
          type="button"
          size="sm"
          className="h-7"
          disabled={busy}
          onClick={() => void save()}
        >
          {busy ? "Saving…" : "Save"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-7"
          disabled={busy}
          onClick={cancel}
        >
          Cancel
        </Button>
      </span>
      <span className="text-xs text-muted-foreground">
        No LLC? Enter their own legal name in both. A blank box clears it.
      </span>
      {error && <span className="text-xs text-destructive">{error}</span>}
    </span>
  );
}
