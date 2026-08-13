"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

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

/**
 * Creating a pre-app asks for the two columns the schema makes NOT NULL, and
 * nothing else.
 *
 * That is the whole reason this is a separate page from the wizard: a pre-app
 * row cannot exist until `dba_name` and `legal_business_name` are set, so there
 * is no id to autosave against until they are. Once the row exists, every other
 * field can be filled in whatever order the rep likes and saved as they go.
 *
 * The alternative — insert a placeholder row when the page opens so autosave
 * always has a target — was rejected: abandoned drafts would litter the list,
 * and the placeholder text would ride through approve_pre_app into a real
 * merchant record.
 */
export function PreAppCreateForm({
  agentId,
  prefill,
  leadId,
  carryOver,
}: {
  agentId: string;
  prefill?: { dba_name?: string | null; legal_business_name?: string | null };
  leadId?: number;
  /**
   * Further `pre_apps` columns to write on insert — the rest of what a lead
   * already knows. Deliberately not rendered as inputs: this form's job is the
   * two NOT NULL columns, and the business step is where the rest is reviewed
   * and corrected. Built by `preAppDefaultsFromLead`.
   */
  carryOver?: Record<string, string | null>;
}) {
  const router = useRouter();
  const [dbaName, setDbaName] = useState(prefill?.dba_name ?? "");
  const [legalName, setLegalName] = useState(
    prefill?.legal_business_name ?? "",
  );
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (event: React.FormEvent) => {
    event.preventDefault();
    setIsSaving(true);
    setError(null);

    try {
      const supabase = createClient();

      // agent_id is the caller's own. The insert policy's `with check` means an
      // agent physically cannot create a row owned by someone else, so this
      // supplies the value the policy requires rather than enforcing it.
      //
      // carryOver is spread FIRST so the four columns below always win. It
      // arrives from a lead the server already resolved, but it is still a bag
      // of keys reaching an insert, and it must never be able to name agent_id,
      // lead_id, or the two columns the rep just typed.
      const { data, error: insertError } = await supabase
        .from("pre_apps")
        .insert({
          ...carryOver,
          agent_id: agentId,
          dba_name: dbaName.trim(),
          legal_business_name: legalName.trim(),
          lead_id: leadId ?? null,
        })
        .select("id")
        .single();

      if (insertError) throw insertError;

      router.push(`/pre-apps/${data.id}/edit?step=business`);
      // Server components cache per-request; without this the wizard can render
      // against the pre-insert state.
      router.refresh();
    } catch (err: unknown) {
      setError(describeError(err));
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>New pre-app</CardTitle>
        <CardDescription>
          Just enough to create the application. Everything else is filled in
          afterwards and saved as you go.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="flex flex-col gap-6">
          <div className="grid gap-6 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <Label htmlFor="dba_name">DBA name *</Label>
              <Input
                id="dba_name"
                value={dbaName}
                onChange={(e) => setDbaName(e.target.value)}
                required
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="legal_business_name">Legal business name *</Label>
              <Input
                id="legal_business_name"
                value={legalName}
                onChange={(e) => setLegalName(e.target.value)}
                required
              />
            </div>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <div className="flex gap-3">
            <Button type="submit" disabled={isSaving}>
              {isSaving ? "Creating…" : "Create and continue"}
            </Button>
            <Button
              type="button"
              variant="outline"
              disabled={isSaving}
              onClick={() => router.back()}
            >
              Cancel
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

/** Turns the errors this form can actually provoke into something readable. */
function describeError(err: unknown): string {
  const code =
    typeof err === "object" && err !== null && "code" in err
      ? String((err as { code: unknown }).code)
      : undefined;

  // A with-check failure, i.e. the insert tried to assign the row to someone
  // else. The raw message names the policy, which tells a rep nothing.
  if (code === "42501") {
    return "You don't have access to create that pre-app.";
  }
  if (code === "23502") {
    return "Both a DBA name and a legal business name are required.";
  }
  return err instanceof Error ? err.message : "Something went wrong.";
}
