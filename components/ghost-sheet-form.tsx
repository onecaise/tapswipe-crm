"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { createClient } from "@/lib/supabase/client";
import { type GhostSheet } from "@/lib/ghost-sheets";
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

type FormState = {
  dba: string;
  contact_name: string;
  contact_phone: string;
  notes: string;
  status: string;
};

function toFormState(sheet?: GhostSheet): FormState {
  return {
    dba: sheet?.dba ?? "",
    contact_name: sheet?.contact_name ?? "",
    contact_phone: sheet?.contact_phone ?? "",
    notes: sheet?.notes ?? "",
    status: sheet?.status ?? "open",
  };
}

function toPayload(form: FormState) {
  const text = (v: string) => (v.trim() === "" ? null : v.trim());
  return {
    dba: text(form.dba),
    contact_name: text(form.contact_name),
    contact_phone: text(form.contact_phone),
    notes: text(form.notes),
    status: text(form.status),
    // No updated_at: ghost_sheets doesn't have the column.
    // No lead_id either — conversion owns that, via
    // convert_ghost_sheet_to_lead(). Letting this form write it would allow
    // pointing a sheet at an arbitrary lead outside any transaction.
  };
}

export function GhostSheetForm({
  sheet,
  agentId,
}: {
  /** Present when editing; absent when creating. */
  sheet?: GhostSheet;
  /** The caller's own profile id, used as agent_id on insert. */
  agentId: string;
}) {
  const isEdit = sheet !== undefined;
  const [form, setForm] = useState<FormState>(() => toFormState(sheet));
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const router = useRouter();

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) =>
    setForm((prev) => ({ ...prev, [key]: value }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSaving(true);
    setError(null);

    const supabase = createClient();
    const payload = toPayload(form);

    try {
      if (isEdit) {
        // count: "exact" because RLS filters rather than erroring — editing a
        // sheet outside your book would otherwise look like a successful save.
        const { error: updateError, count } = await supabase
          .from("ghost_sheets")
          .update(payload, { count: "exact" })
          .eq("id", sheet.id);

        if (updateError) throw updateError;
        if (count === 0) {
          throw new Error(
            "That ghost sheet could not be updated. It may no longer be in your book.",
          );
        }

        router.push(`/ghost-sheets/${sheet.id}`);
      } else {
        const { data, error: insertError } = await supabase
          .from("ghost_sheets")
          .insert({ ...payload, agent_id: agentId })
          .select("id")
          .single();

        if (insertError) throw insertError;
        router.push(`/ghost-sheets/${data.id}`);
      }

      router.refresh();
    } catch (err: unknown) {
      setError(
        err instanceof Error ? err.message : "Something went wrong saving.",
      );
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{isEdit ? "Edit ghost sheet" : "New ghost sheet"}</CardTitle>
        <CardDescription>
          {isEdit
            ? "You can only edit ghost sheets in your own book."
            : "Quick capture — you can convert this to a full lead later."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="flex flex-col gap-6">
          <div className="grid gap-6 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="dba">DBA</Label>
              <Input
                id="dba"
                value={form.dba}
                onChange={(e) => set("dba", e.target.value)}
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="contact_name">Contact name</Label>
              <Input
                id="contact_name"
                value={form.contact_name}
                onChange={(e) => set("contact_name", e.target.value)}
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="contact_phone">Contact phone</Label>
              <Input
                id="contact_phone"
                value={form.contact_phone}
                onChange={(e) => set("contact_phone", e.target.value)}
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="status">Status</Label>
              <Input
                id="status"
                value={form.status}
                onChange={(e) => set("status", e.target.value)}
              />
            </div>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="notes">Notes</Label>
            <textarea
              id="notes"
              rows={5}
              className="border-input bg-background ring-offset-background focus-visible:ring-ring flex w-full rounded-md border px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none"
              value={form.notes}
              onChange={(e) => set("notes", e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              On conversion these notes are copied onto the new lead as a note.
            </p>
          </div>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <div className="flex gap-2">
            <Button type="submit" disabled={isSaving}>
              {isSaving
                ? "Saving…"
                : isEdit
                  ? "Save changes"
                  : "Create ghost sheet"}
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => router.back()}
              disabled={isSaving}
            >
              Cancel
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
