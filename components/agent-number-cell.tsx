"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { PencilIcon } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import { EMPTY } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

/**
 * One rep's agent number, set or cleared in place on the users list.
 *
 * Its own cell rather than another control in the Actions column, which already
 * carries a role select, Reset password and Deactivate and has no room left. It
 * is also a different kind of thing: the other three act on an account, this
 * edits a field.
 *
 * Writes through the set_agent_number RPC — profiles has no UPDATE policy at all,
 * so there is no supabase-js update to make here even for an admin. The RPC is
 * `security definer` and re-checks is_admin() itself, so nothing on this screen
 * is a security boundary; the read-only fallback below is a UX nicety.
 *
 * Every raise in that function is written to be read by a person ("agent number
 * 4471 is already assigned to another rep"), so the message is shown verbatim.
 */
export function AgentNumberCell({
  userId,
  fullName,
  agentNumber,
}: {
  userId: string;
  fullName: string;
  agentNumber: string | null;
}) {
  const router = useRouter();

  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(agentNumber ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setBusy(true);
    setError(null);

    const supabase = createClient();
    // An empty string clears it — the RPC normalises blank and whitespace to
    // null, so the UI does not have to distinguish "cleared" from "never set".
    const { error: rpcError } = await supabase.rpc("set_agent_number", {
      target_user_id: userId,
      new_agent_number: value,
    });

    if (rpcError) {
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
        {/* Monospace so 0/O and 1/l are separable — this is a code someone
            reconciles against a spreadsheet, not a name. */}
        <span className="font-mono text-xs">{agentNumber ?? EMPTY}</span>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-6 px-1.5"
          aria-label={`${agentNumber === null ? "Set" : "Change"} agent number for ${fullName}`}
          onClick={() => {
            setValue(agentNumber ?? "");
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
          aria-label={`Agent number for ${fullName}`}
          value={value}
          maxLength={32}
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
          className="h-7 w-24 font-mono text-xs"
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
      {value.trim() === "" && agentNumber !== null && !error && (
        <span className="text-xs text-muted-foreground">
          Saving blank clears it.
        </span>
      )}
      {error && <span className="text-xs text-destructive">{error}</span>}
    </span>
  );
}
