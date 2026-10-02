"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { PencilIcon } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { EMPTY } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/** Matches the length cap in set_territory(). */
const MAX_TERRITORY = 64;

/**
 * One rep's sales territory, set or cleared in place on the users list.
 *
 * Deliberately the same shape as AgentNumberCell next to it — its own cell
 * rather than another control in the Actions column, which already carries a
 * role select, Reset password and Deactivate. It is also a different kind of
 * thing from those three: they act on an account, this edits a field.
 *
 * Writes through the set_territory RPC. profiles has no UPDATE policy *and* no
 * UPDATE grant for `authenticated`, so there is no supabase-js update to make
 * here even for an admin — a direct PATCH comes back "permission denied for
 * table profiles". The RPC is `security definer` and re-checks is_admin()
 * itself, so nothing on this screen is a security boundary; the page already
 * being admin-only is a convenience, not the enforcement.
 *
 * Free text with no suggestion list, unlike the <datalist> documents-panel.tsx
 * offers for doc_type. A datalist here would need the set of territories
 * already in use, which means a second query on a page that already reads every
 * profile — worth adding when there are enough regions to misspell, not before.
 *
 * Territory is a reporting label and nothing reads it to decide access. If that
 * ever changes, this component is not where it changes.
 */
export function TerritoryCell({
  userId,
  fullName,
  territory,
}: {
  userId: string;
  fullName: string;
  territory: string | null;
}) {
  const router = useRouter();

  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(territory ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setError(null);

    const supabase = createClient();
    // An empty string clears it — the RPC normalises blank and whitespace to
    // null, so the UI does not have to distinguish "cleared" from "never set".
    const { error: rpcError } = await supabase.rpc("set_territory", {
      target_user_id: userId,
      new_territory: value,
    });

    if (rpcError) {
      // Every raise in that function is written to be read by a person
      // ("territory must be 64 characters or fewer"), so it is shown verbatim.
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
      <span className="flex items-center gap-1.5">
        <span className="text-sm">{territory ?? EMPTY}</span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 px-1.5"
          aria-label={`${territory === null ? "Set" : "Change"} territory for ${fullName}`}
          onClick={() => {
            setValue(territory ?? "");
            setError(null);
            setEditing(true);
          }}
        >
          <PencilIcon size={12} />
        </Button>
      </span>
    );
  }

  return (
    <span className="flex flex-col gap-1">
      <span className="flex items-center gap-1.5">
        <Input
          aria-label={`Territory for ${fullName}`}
          value={value}
          maxLength={MAX_TERRITORY}
          disabled={busy}
          autoFocus
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              void save();
            }
            if (event.key === "Escape") {
              setEditing(false);
              setError(null);
            }
          }}
          className="h-7 w-36 text-xs"
        />
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
          onClick={() => {
            setEditing(false);
            setError(null);
          }}
        >
          Cancel
        </Button>
      </span>
      {/* Blank is a legitimate submission, so say what it will do rather than
          leaving "Save" over an empty box looking like a dead control. */}
      {value.trim() === "" && territory !== null && !error && (
        <span className="text-xs text-muted-foreground">
          Saving blank clears it.
        </span>
      )}
      {error && <span className="text-xs text-destructive">{error}</span>}
    </span>
  );
}
