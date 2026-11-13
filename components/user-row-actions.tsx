"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import {
  CheckIcon,
  CopyIcon,
  EyeIcon,
  EyeOffIcon,
  KeyRoundIcon,
} from "lucide-react";

import { callAdminFunction, type ResetPassword } from "@/lib/admin-users";
import type { Role } from "@/lib/auth";
import { MIN_PASSWORD_LENGTH, isAcceptablePassword } from "@/lib/passwords";
import { createClient } from "@/lib/supabase/client";
import { ConfirmPair } from "@/components/confirm-pair";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

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
  const [confirming, setConfirming] = useState<
    null | "active" | "password" | "role"
  >(null);
  /**
   * The role picked but not yet committed.
   *
   * Changing this select used to write straight through. Promoting someone to
   * admin hands them every record in the company, and it was the one control
   * here that did something irreversible-ish with no confirmation while its two
   * neighbours both had one.
   */
  const [pendingRole, setPendingRole] = useState<Role | null>(null);
  const [tempPassword, setTempPassword] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  /**
   * The temporary password the admin typed into the reset form, if any. Blank
   * means "generate one" — the function decides, and the result screen shows
   * whichever was set. Cleared whenever the form closes so one rep's password
   * is never left sitting in another row's field.
   */
  const [chosenPassword, setChosenPassword] = useState("");
  const [showChosen, setShowChosen] = useState(false);
  const chosenBlank = chosenPassword.trim() === "";
  const chosenTooShort =
    !chosenBlank && !isAcceptablePassword(chosenPassword);

  const closeResetForm = () => {
    setConfirming(null);
    setChosenPassword("");
    setShowChosen(false);
  };

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
      // Sent verbatim, no trim, and only when not blank: a blank field is the
      // generated-password path, the same as before this field existed.
      chosenBlank
        ? { user_id: userId }
        : { user_id: userId, password: chosenPassword },
    );

    if (callError || !data) {
      setError(callError ?? "Could not reset the password.");
    } else {
      setTempPassword(data.temporary_password);
    }
    setChosenPassword("");
    setShowChosen(false);
    setBusy(null);
  };

  const changeRole = async (nextRole: Role) => {
    if (nextRole === role) return;
    setBusy("role");
    setError(null);
    setConfirming(null);

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
    setPendingRole(null);
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
          {/* text-sm, not text-xs: this is a string someone reads down a phone
              line or types by hand, and at the row's default size it rendered
              noticeably smaller than the same value on the create-user page.
              tracking-wide so 0/O and 1/l are separable. */}
          <code className="rounded-lg bg-muted px-2 py-1 font-mono text-sm tracking-wide">
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
        {/* Shows the pending choice while it waits to be confirmed, so the
            select reflects what was picked rather than snapping back and
            looking like the click was lost. */}
        <select
          aria-label={`Role for ${fullName}`}
          value={pendingRole ?? role}
          disabled={isSelf || busy !== null}
          onChange={(event) => {
            setPendingRole(event.target.value as Role);
            setConfirming("role");
          }}
          className="h-8 rounded-lg border border-input bg-card px-2 text-xs disabled:cursor-not-allowed disabled:opacity-50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <option value="agent">Agent</option>
          <option value="admin">Admin</option>
        </select>

        {confirming === "role" && pendingRole !== null && (
          <ConfirmPair
            label={
              pendingRole === "admin"
                ? "Make admin — they will see every record in the company?"
                : "Make agent — they will see only their own records?"
            }
            confirmLabel="Change role"
            onConfirm={() => void changeRole(pendingRole)}
            onCancel={() => {
              setPendingRole(null);
              setConfirming(null);
            }}
            busy={busy === "role"}
          />
        )}

        {/* Hidden while a role change is pending. The role prompt is a sentence
            rather than a word, and the row cannot hold it plus two more
            controls without wrapping into something unreadable. */}
        {confirming !== "role" && (
          <>
            {confirming === "password" ? (
              <form
                className="flex flex-col items-end gap-1.5"
                aria-label={`Reset password for ${fullName}`}
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!chosenTooShort) void resetPassword();
                }}
              >
                <div className="flex items-center gap-2">
                  <label
                    htmlFor={`reset-password-${userId}`}
                    className="text-xs text-muted-foreground"
                  >
                    Temporary password (optional)
                  </label>
                  <Input
                    id={`reset-password-${userId}`}
                    // Masked by default, revealable: the admin has to read it
                    // out, and a typo they cannot see is the whole risk.
                    type={showChosen ? "text" : "password"}
                    value={chosenPassword}
                    onChange={(event) => setChosenPassword(event.target.value)}
                    // Not the admin's own credential; nothing should save it.
                    autoComplete="off"
                    aria-describedby={`reset-password-hint-${userId}`}
                    aria-invalid={chosenTooShort || undefined}
                    disabled={busy === "password"}
                    className="h-8 w-48 text-xs"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => setShowChosen((shown) => !shown)}
                    aria-pressed={showChosen}
                    aria-label={showChosen ? "Hide password" : "Show password"}
                  >
                    {showChosen ? <EyeOffIcon size={14} /> : <EyeIcon size={14} />}
                  </Button>
                  <Button
                    type="submit"
                    size="sm"
                    disabled={busy === "password" || chosenTooShort}
                  >
                    {busy === "password" ? "Working…" : "Reset"}
                  </Button>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    disabled={busy === "password"}
                    onClick={closeResetForm}
                  >
                    Cancel
                  </Button>
                </div>
                <span
                  id={`reset-password-hint-${userId}`}
                  className={
                    chosenTooShort
                      ? "text-xs text-destructive"
                      : "text-xs text-muted-foreground"
                  }
                >
                  At least {MIN_PASSWORD_LENGTH} characters. Leave blank to
                  generate one. The rep must choose their own at first login.
                </span>
              </form>
            ) : (
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={busy !== null}
                onClick={() => {
                  setChosenPassword("");
                  setShowChosen(false);
                  setConfirming("password");
                }}
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
                  isSelf
                    ? "You cannot change your own account's active state"
                    : ""
                }
              >
                {isActive ? "Deactivate" : "Reactivate"}
              </Button>
            )}
          </>
        )}
      </div>

      {error && <span className="text-xs text-destructive">{error}</span>}
    </div>
  );
}

