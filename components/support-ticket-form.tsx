"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

import { createClient } from "@/lib/supabase/client";
import {
  SUPPORT_TICKET_STATUSES,
  TICKET_CATEGORIES,
  TICKET_PRIORITIES,
  type SupportTicket,
  type SupportTicketStatus,
} from "@/lib/support-tickets";
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
import { Textarea } from "@/components/ui/textarea";
import type { MerchantOption } from "@/lib/merchant-options";

const SELECT_CLASS =
  "border-input bg-background ring-offset-background focus-visible:ring-ring flex h-10 w-full rounded-md border px-3 py-2 text-sm focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:outline-none";

/**
 * Create/edit a support ticket. Same shape as lead-form and merchant-form:
 * useState, a hand-written toPayload(), one client-side supabase-js call.
 *
 * Three field kinds, matching what the database actually enforces:
 *
 *  - `status` is a native <select> over the check constraint's vocabulary, like
 *    merchant-form's status.
 *  - `category` / `sub_category` / `priority` are free text with a <datalist> of
 *    suggestions, like documents-panel's doc_type. The column is unconstrained on
 *    purpose, so a rep with a genuinely new category can type it.
 *  - `merchant_id` is a <select> over merchants the caller can actually see. The
 *    options arrive as a prop from the server page, where RLS scoped them — this
 *    component never queries for them, so it cannot widen that set.
 *
 * The empty option is `""` mapped back to null on submit: merchant_id is
 * nullable because plenty of tickets are about an account that isn't a merchant
 * yet, or about nothing in particular.
 */
const UNSET = "";

export function SupportTicketForm({
  ticket,
  agentId,
  merchants,
}: {
  /** Present when editing; absent when creating. */
  ticket?: SupportTicket;
  /** The caller's own profile id, used as agent_id on insert. */
  agentId: string;
  merchants: MerchantOption[];
}) {
  const isEdit = ticket !== undefined;
  const router = useRouter();

  const [subject, setSubject] = useState(ticket?.subject ?? "");
  const [message, setMessage] = useState(ticket?.message ?? "");
  const [category, setCategory] = useState(ticket?.category ?? "");
  const [subCategory, setSubCategory] = useState(ticket?.sub_category ?? "");
  const [priority, setPriority] = useState(ticket?.priority ?? "Normal");
  const [serial, setSerial] = useState(ticket?.serial_number_imei ?? "");
  const [status, setStatus] = useState<SupportTicketStatus>(
    ticket?.status ?? "open",
  );
  const [merchantId, setMerchantId] = useState(
    ticket?.merchant_id === null || ticket?.merchant_id === undefined
      ? UNSET
      : String(ticket.merchant_id),
  );

  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);

  /** Empty strings become NULL, so absent data reads as absent. */
  const toPayload = () => ({
    subject: subject.trim(),
    message: text(message),
    category: text(category),
    sub_category: text(subCategory),
    priority: text(priority),
    serial_number_imei: text(serial),
    status,
    merchant_id: merchantId === UNSET ? null : Number(merchantId),
  });

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsSaving(true);
    setError(null);

    const supabase = createClient();
    const payload = toPayload();

    try {
      if (isEdit) {
        // count: "exact" matters. RLS filters rather than erroring, so editing a
        // ticket outside your book returns no error and touches nothing — this
        // would otherwise report a save that never happened.
        const { error: updateError, count } = await supabase
          .from("support_tickets")
          .update(payload, { count: "exact" })
          .eq("id", ticket.id);

        if (updateError) throw updateError;
        if (count === 0) {
          throw new Error(
            "That ticket could not be updated. It may no longer be yours.",
          );
        }

        router.push(`/support-tickets/${ticket.id}`);
      } else {
        // The insert policy's `with check` is what prevents creating a row owned
        // by someone else; this supplies the value that policy requires.
        const { data, error: insertError } = await supabase
          .from("support_tickets")
          .insert({ ...payload, agent_id: agentId })
          .select("id")
          .single();

        if (insertError) throw insertError;
        router.push(`/support-tickets/${data.id}`);
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
        <CardTitle>{isEdit ? "Edit ticket" : "New support ticket"}</CardTitle>
        <CardDescription>
          {isEdit
            ? "You can only edit tickets you opened."
            : "This ticket will be filed under your own name."}
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={handleSubmit} className="flex flex-col gap-8">
          <fieldset className="flex flex-col gap-4">
            <legend className="font-semibold text-sm">What is wrong</legend>

            <div className="grid gap-2">
              <Label htmlFor="subject">Subject *</Label>
              <Input
                id="subject"
                required
                value={subject}
                onChange={(e) => setSubject(e.target.value)}
              />
            </div>

            <div className="grid gap-2">
              <Label htmlFor="message">Details</Label>
              <Textarea
                id="message"
                rows={5}
                value={message}
                onChange={(e) => setMessage(e.target.value)}
                placeholder="What happens, when it started, and anything already tried."
              />
            </div>
          </fieldset>

          <fieldset className="flex flex-col gap-4">
            <legend className="font-semibold text-sm">Classification</legend>
            <div className="grid gap-6 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="category">Category</Label>
                <Input
                  id="category"
                  list="ticket-category-suggestions"
                  value={category}
                  onChange={(e) => setCategory(e.target.value)}
                />
                <datalist id="ticket-category-suggestions">
                  {TICKET_CATEGORIES.map((option) => (
                    <option key={option} value={option} />
                  ))}
                </datalist>
              </div>

              <div className="grid gap-2">
                <Label htmlFor="sub_category">Sub-category</Label>
                <Input
                  id="sub_category"
                  value={subCategory}
                  onChange={(e) => setSubCategory(e.target.value)}
                />
              </div>

              <div className="grid gap-2">
                <Label htmlFor="priority">Priority</Label>
                <Input
                  id="priority"
                  list="ticket-priority-suggestions"
                  value={priority}
                  onChange={(e) => setPriority(e.target.value)}
                />
                <datalist id="ticket-priority-suggestions">
                  {TICKET_PRIORITIES.map((option) => (
                    <option key={option} value={option} />
                  ))}
                </datalist>
              </div>

              <div className="grid gap-2">
                <Label htmlFor="status">Status</Label>
                <select
                  id="status"
                  className={SELECT_CLASS}
                  value={status}
                  onChange={(e) =>
                    setStatus(e.target.value as SupportTicketStatus)
                  }
                >
                  {SUPPORT_TICKET_STATUSES.map((option) => (
                    <option key={option} value={option}>
                      {option}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          </fieldset>

          <fieldset className="flex flex-col gap-4">
            <legend className="font-semibold text-sm">Account</legend>
            <div className="grid gap-6 sm:grid-cols-2">
              <div className="grid gap-2">
                <Label htmlFor="merchant_id">Merchant</Label>
                <select
                  id="merchant_id"
                  className={SELECT_CLASS}
                  value={merchantId}
                  onChange={(e) => setMerchantId(e.target.value)}
                >
                  <option value={UNSET}>Not about a specific merchant</option>
                  {merchants.map((merchant) => (
                    <option key={merchant.id} value={merchant.id}>
                      {merchant.dba}
                    </option>
                  ))}
                </select>
                {merchants.length === 0 && (
                  <p className="text-xs text-muted-foreground">
                    No merchants in your book yet — leave this as it is.
                  </p>
                )}
              </div>

              <div className="grid gap-2">
                <Label htmlFor="serial">Serial number / IMEI</Label>
                <Input
                  id="serial"
                  value={serial}
                  onChange={(e) => setSerial(e.target.value)}
                />
              </div>
            </div>
          </fieldset>

          {error && <p className="text-sm text-destructive">{error}</p>}

          <div className="flex gap-2">
            <Button type="submit" disabled={isSaving}>
              {isSaving ? "Saving…" : isEdit ? "Save changes" : "Open ticket"}
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

function text(value: string): string | null {
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}
