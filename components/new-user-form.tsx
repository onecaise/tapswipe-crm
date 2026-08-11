"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
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
 */
export function NewUserForm() {
  const router = useRouter();

  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
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
      { full_name: fullName, email, role },
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
          <Button asChild size="sm">
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
