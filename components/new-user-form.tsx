"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { useState } from "react";
import { CheckIcon, CopyIcon, UserPlusIcon } from "lucide-react";

import { callAdminFunction, type CreatedUser } from "@/lib/admin-users";
import type { Role } from "@/lib/auth";
import { Callout } from "@/components/callout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Creates an account via the create-user Edge Function.
 *
 * The temporary password comes back in the response and is shown once. It is
 * never written to the database, so there is no second chance to read it — hence
 * the success state replaces the form rather than closing over it, and says so.
 * (This is also why this is a page rather than a dialog: a dialog that can be
 * dismissed is the wrong container for a secret with no second viewing.)
 *
 * Two search params, both sent by the residuals import review screen when an
 * unrecognised Agent # turns out to belong to nobody yet: `agent_number`
 * pre-fills the field, and `returnTo` offers a way back to the batch that is
 * still waiting on it. See RESIDUALS_SPEC §8.3.
 */

/**
 * The only shape of `returnTo` this form will link to.
 *
 * A search param that becomes an href is an open-redirect if it is taken on
 * trust, and "back to where you came from" is not worth an off-site link on the
 * screen that hands out credentials. Only the import batch pages send one, so
 * only they are accepted — anything else falls back to the users list.
 */
const RETURN_TO = /^\/payouts\/import\/\d+$/;

export function NewUserForm() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const returnToParam = searchParams.get("returnTo");
  const returnTo =
    returnToParam !== null && RETURN_TO.test(returnToParam)
      ? returnToParam
      : null;

  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  // Pre-filled once, from the param, then owned by the input. Read with the
  // initialiser rather than an effect so typing over it is not undone on the
  // next render.
  const [agentNumber, setAgentNumber] = useState(
    () => searchParams.get("agent_number")?.trim() ?? "",
  );
  const [role, setRole] = useState<Role>("agent");
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<CreatedUser | null>(null);
  const [copied, setCopied] = useState(false);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setIsSaving(true);
    setError(null);

    const { data, error: callError } = await callAdminFunction<CreatedUser>(
      "create-user",
      { full_name: fullName, email, role, agent_number: agentNumber },
    );

    if (callError || !data) {
      setError(callError ?? "Could not create the user.");
      setIsSaving(false);
      return;
    }

    setCreated(data);
    setIsSaving(false);
    // So the list behind this page shows the new row when the admin returns.
    router.refresh();
  };

  const copy = async () => {
    if (!created) return;
    await navigator.clipboard.writeText(created.temporary_password);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  if (created) {
    return (
      <div className="flex flex-col gap-4">
        <Callout tone="success">
          <p className="font-medium">Account created for {created.email}</p>
          <p className="mt-1 text-muted-foreground">
            Give this password to them directly — a call or a message, not email
            if you can avoid it. They will be required to choose their own the
            first time they sign in.
          </p>
        </Callout>

        <div className="flex flex-col gap-2 rounded-xl border bg-card p-4">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Temporary password — shown once
          </p>
          <div className="flex items-center gap-2">
            <code className="flex-1 truncate rounded-lg bg-muted px-3 py-2 font-mono text-sm">
              {created.temporary_password}
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
          </div>
          <p className="text-xs text-muted-foreground">
            It is not stored anywhere. If you lose it, use Reset password on the
            users list to issue a new one.
          </p>
        </div>

        {created.auditWriteFailed && (
          <Callout tone="warning">
            The account was created, but the audit log entry could not be
            written.
          </Callout>
        )}

        <div className="flex gap-2">
          {/* The batch that sent us here is still sitting on the blocked rows
              this account just unblocked, so returning to it is the next step
              rather than the users list. */}
          {returnTo !== null && (
            <Button asChild size="sm">
              <Link href={returnTo}>Back to the import</Link>
            </Button>
          )}
          <Button asChild size="sm" variant={returnTo !== null ? "outline" : "default"}>
            <Link href="/admin/users">Back to users</Link>
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => {
              setCreated(null);
              setFullName("");
              setEmail("");
              setAgentNumber("");
              setRole("agent");
            }}
          >
            Create another
          </Button>
        </div>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      <div className="grid gap-2">
        <Label htmlFor="full_name">Full name</Label>
        <Input
          id="full_name"
          required
          value={fullName}
          onChange={(event) => setFullName(event.target.value)}
          placeholder="Avery Agent"
        />
      </div>

      <div className="grid gap-2">
        <Label htmlFor="email">Email</Label>
        <Input
          id="email"
          type="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          placeholder="avery@tapswipe.com"
        />
        <p className="text-xs text-muted-foreground">
          Their sign-in identity. One account per person — the whole access model
          depends on it naming exactly one human.
        </p>
      </div>

      <div className="grid gap-2">
        <Label htmlFor="agent_number">Agent # (optional)</Label>
        <Input
          id="agent_number"
          value={agentNumber}
          onChange={(event) => setAgentNumber(event.target.value)}
          maxLength={32}
          placeholder="4471"
        />
        <p className="text-xs text-muted-foreground">
          How the processor names this rep in a residual report. Leave it blank if
          you don&apos;t know it yet — you can set it later from the users list,
          and an import will prompt for it when it needs one.
        </p>
      </div>

      <div className="grid gap-2">
        <Label htmlFor="role">Role</Label>
        {/* Native select rather than a Radix one: it needs no new dependency and
            the repo already prefers native controls (see state-combobox and the
            <datalist> usage in documents-panel). */}
        <select
          id="role"
          value={role}
          onChange={(event) => setRole(event.target.value as Role)}
          className="h-9 rounded-lg border border-input bg-card px-3 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <option value="agent">Agent — sees only their own records</option>
          <option value="admin">Admin — sees the whole company</option>
        </select>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      <div className="flex gap-2">
        <Button type="submit" size="sm" disabled={isSaving}>
          <UserPlusIcon size={16} />
          {isSaving ? "Creating…" : "Create user"}
        </Button>
        <Button asChild variant="outline" size="sm">
          <Link href="/admin/users">Cancel</Link>
        </Button>
      </div>
    </form>
  );
}
