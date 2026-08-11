"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { CheckIcon, CopyIcon, KeyRoundIcon } from "lucide-react";

import { callAdminFunction, type ResetPassword } from "@/lib/admin-users";
import type { Role } from "@/lib/auth";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";

/**
 * Deactivate / reactivate, reset password, and change role for one user.
 *
 * Three of the four go through Edge Functions because they need the Auth Admin
 * API or the service-role key. The role change goes through the set_user_role
 * RPC instead: it needs neither, only a server-side admin check and an audit
 * row, which is master plan §9's Tier 2. All four are checked server-side; none
 * of the disabling here is a security boundary.
 *
 * `isSelf` disables the destructive controls rather than hiding them, so it is
 * obvious *why* they cannot be used. Both the function and the RPC refuse a
 * self-target anyway — an admin switching off or demoting their own account
 * loses the screen they are standing on, and if they were the last one nobody
 * could undo it.
 */
export function UserRowActions({
  userId,
  fullName,
  role,
  isActive,
  isSelf,
}: {
  userId: string;
  fullName: string;
  role: Role;
  isActive: boolean;
  isSelf: boolean;
}) {
  const router = useRouter();

  const [busy, setBusy] = useState<null | "active" | "password" | "role">(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<null | "active" | "password">(
    null,
  );
  const [tempPassword, setTempPassword] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const toggleActive = async () => {
    setBusy("active");
    setError(null);
    setConfirming(null);

    const { error: callError } = await callAdminFunction("deactivate-user", {
      user_id: userId,
      is_active: !isActive,
    });

    if (callError) setError(callError);
    setBusy(null);
    if (!callError) router.refresh();
  };

  const resetPassword = async () => {
    setBusy("password");
    setError(null);
    setConfirming(null);

    const { data, error: callError } = await callAdminFunction<ResetPassword>(
      "admin-reset-password",
      { user_id: userId },
    );

    if (callError || !data) {
      setError(callError ?? "Could not reset the password.");
    } else {
      setTempPassword(data.temporary_password);
    }
    setBusy(null);
  };

  const changeRole = async (nextRole: Role) => {
    if (nextRole === role) return;
    setBusy("role");
    setError(null);

    const supabase = createClient();
    const { error: rpcError } = await supabase.rpc("set_user_role", {
      target_user_id: userId,
      new_role: nextRole,
    });

    // Every raise in set_user_role is written to be read by a person ("cannot
    // demote the last active admin"), so it is shown verbatim.
    if (rpcError) setError(rpcError.message);
    setBusy(null);
    if (!rpcError) router.refresh();
  };

  const copy = async () => {
    if (!tempPassword) return;
    await navigator.clipboard.writeText(tempPassword);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  // Replaces the row's controls while a one-time secret is on screen, so it
  // cannot be scrolled past and lost.
  if (tempPassword) {
    return (
      <div className="flex flex-col items-end gap-1.5">
        <span className="text-xs text-muted-foreground">
          New temporary password — shown once
        </span>
        <div className="flex items-center gap-2">
          <code className="rounded-lg bg-muted px-2 py-1 font-mono text-xs">
            {tempPassword}
          </code>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void copy()}
          >
            {copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
            {copied ? "Copied" : "Copy"}
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            onClick={() => setTempPassword(null)}
          >
            Done
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="flex items-center justify-end gap-2">
        <select
          aria-label={`Role for ${fullName}`}
          value={role}
          disabled={isSelf || busy !== null}
          onChange={(event) => void changeRole(event.target.value as Role)}
          className="h-8 rounded-lg border border-input bg-card px-2 text-xs disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <option value="agent">Agent</option>
          <option value="admin">Admin</option>
        </select>

        {confirming === "password" ? (
          <ConfirmPair
            label="Reset?"
            onConfirm={() => void resetPassword()}
            onCancel={() => setConfirming(null)}
            busy={busy === "password"}
          />
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy !== null}
            onClick={() => setConfirming("password")}
          >
            <KeyRoundIcon size={14} />
            Reset password
          </Button>
        )}

        {confirming === "active" ? (
          <ConfirmPair
            label={isActive ? "Deactivate?" : "Reactivate?"}
            onConfirm={() => void toggleActive()}
            onCancel={() => setConfirming(null)}
            busy={busy === "active"}
            destructive={isActive}
          />
        ) : (
          <Button
            type="button"
            // Deactivation is destructive and reads as such; reactivation is
            // not, so it must not borrow the same colour.
            variant={isActive ? "destructive" : "outline"}
            size="sm"
            disabled={isSelf || busy !== null}
            onClick={() => setConfirming("active")}
            title={
              isSelf ? "You cannot change your own account's active state" : ""
            }
          >
            {isActive ? "Deactivate" : "Reactivate"}
          </Button>
        )}
      </div>

      {error && <span className="text-xs text-destructive">{error}</span>}
    </div>
  );
}

/**
 * The confirmation step. Inline rather than window.confirm, which blocks the
 * page and cannot be styled or tested.
 */
function ConfirmPair({
  label,
  onConfirm,
  onCancel,
  busy,
  destructive = false,
}: {
  label: string;
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
        {busy ? "Working…" : "Confirm"}
      </Button>
      <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
        Cancel
      </Button>
    </span>
  );
}
