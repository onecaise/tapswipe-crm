"use client";

import { cn } from "@/lib/utils";
import { createClient } from "@/lib/supabase/client";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { MIN_PASSWORD_LENGTH } from "@/lib/passwords";
import { useState } from "react";

// MIN_PASSWORD_LENGTH used to be declared here. It moved to lib/passwords.ts
// when the new-user form began setting an account's first password and needed
// the same rule — two forms inventing the same number separately is how one of
// them ends up a character out from what the Auth server will accept.

export function UpdatePasswordForm({
  className,
  ...props
}: React.ComponentPropsWithoutRef<"div">) {
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const tooShort = password !== "" && password.length < MIN_PASSWORD_LENGTH;
  // Only once they have started typing it, so the mismatch doesn't shout at
  // someone halfway through their first keystroke.
  const mismatch = confirmation !== "" && confirmation !== password;

  const handleUpdatePassword = async (e: React.FormEvent) => {
    e.preventDefault();

    // A typed-once password that turns out to be a typo cannot be recovered by
    // the person who set it — they are locked out and need an admin reset. The
    // second field is the whole reason this check exists.
    if (password !== confirmation) {
      setError("Those two passwords do not match.");
      return;
    }

    const supabase = createClient();
    setIsLoading(true);
    setError(null);

    try {
      const { error } = await supabase.auth.updateUser({ password });
      if (error) throw error;

      // Retires the forced-change flag an admin's temporary password set. Only
      // after updateUser succeeds: clearing it first would drop the prompt while
      // the old password was still the live one.
      //
      // A narrow RPC because profiles has no self-update policy — a rep cannot
      // write their own row directly, by design (that would let them try to set
      // their own role). clear_must_change_password touches this one column.
      //
      // A failure here is not worth blocking on: the password IS changed, and the
      // only consequence is being asked again on the next page load.
      await supabase.rpc("clear_must_change_password");

      // A full document load, deliberately — NOT router.push().
      //
      // app/(app)/layout.tsx redirects to this page while must_change_password
      // is true, and the client router has that redirect cached. A push alone
      // never commits: the dashboard mounts underneath, the URL stays on
      // /auth/update-password, and the rep is left looking at the form they
      // just submitted, with the password already changed.
      //
      // Pairing push() with refresh() — what login-form.tsx does, and the first
      // fix tried here — only makes that race winnable, not won. The two are
      // concurrent: refresh() re-renders the route the browser is still on, and
      // whether it lands before or after the push commits is timing. It passed
      // on one run and failed on the next, which is worse than not fixing it.
      //
      // login-form.tsx gets away with the pair because nothing is redirecting
      // against it. Here the server's answer for this user changed, and the
      // honest way to pick that up is to ask the server again from scratch.
      // Once per account, so the extra load costs nothing worth counting.
      window.location.assign("/dashboard");
      return;
    } catch (error: unknown) {
      setError(error instanceof Error ? error.message : "An error occurred");
      setIsLoading(false);
    }
  };

  return (
    <div className={cn("flex flex-col gap-6", className)} {...props}>
      <Card>
        <CardHeader>
          {/* This page serves two arrivals: a rep following a reset link, and a
              new rep signing in for the first time, whom app/(app)/layout.tsx
              sends here while must_change_password is true. It cannot tell
              which, so the copy is written to be true of both — "Reset Your
              Password" was a puzzle for the second group, who had not asked to
              reset anything. */}
          <CardTitle className="text-2xl">Choose a new password</CardTitle>
          <CardDescription>
            This replaces whatever you signed in with. You&rsquo;ll use the new
            one from now on.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleUpdatePassword}>
            <div className="flex flex-col gap-6">
              <div className="grid gap-2">
                <Label htmlFor="password">New password</Label>
                <Input
                  id="password"
                  type="password"
                  placeholder="New password"
                  required
                  minLength={MIN_PASSWORD_LENGTH}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  aria-describedby="password-hint"
                />
                {/* Said up front rather than as an error after a round trip. */}
                <p
                  id="password-hint"
                  className={
                    tooShort
                      ? "text-xs text-destructive"
                      : "text-xs text-muted-foreground"
                  }
                >
                  At least {MIN_PASSWORD_LENGTH} characters.
                </p>
              </div>

              <div className="grid gap-2">
                <Label htmlFor="confirmation">Confirm new password</Label>
                <Input
                  id="confirmation"
                  type="password"
                  placeholder="Type it again"
                  required
                  value={confirmation}
                  onChange={(e) => setConfirmation(e.target.value)}
                />
                {mismatch && (
                  <p className="text-xs text-destructive">
                    Those two do not match.
                  </p>
                )}
              </div>

              {error && <p className="text-sm text-destructive">{error}</p>}
              <Button
                type="submit"
                className="w-full"
                disabled={isLoading || tooShort || mismatch}
              >
                {isLoading ? "Saving..." : "Save new password"}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
