"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { PlusIcon, Trash2Icon } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import {
  taskIsOverdue,
  type AnnotationOwnerType,
  type Task,
  type WithAuthor,
} from "@/lib/annotations";
import { formatDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * The task list on a lead / pre-app / merchant / ghost sheet.
 *
 * Unlike notes, tasks DO have an update policy — `completed` exists to be
 * toggled, in both directions — so the checkbox writes straight through. Removal
 * is admin-only, matching the delete policy.
 *
 * `due_date` is a native date input rather than a mask: it is a `date` column, so
 * a half-typed value cannot be written at all, and the native control emits
 * either "" or a complete YYYY-MM-DD. Same resolution as the pre-app wizard's
 * §6.1.
 */
export function TasksPanel({
  ownerType,
  ownerId,
  tasks,
  agentId,
  isAdmin,
}: {
  ownerType: AnnotationOwnerType;
  ownerId: number;
  tasks: WithAuthor<Task>[];
  agentId: string;
  isAdmin: boolean;
}) {
  const router = useRouter();
  const [title, setTitle] = useState("");
  const [dueDate, setDueDate] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const openCount = tasks.filter((t) => !t.completed).length;

  const add = async () => {
    setBusy(true);
    setError(null);

    const supabase = createClient();
    const { error: insertError } = await supabase.from("tasks").insert({
      agent_id: agentId,
      owner_type: ownerType,
      owner_id: ownerId,
      title: title.trim(),
      // "" would be rejected by the date column, so an unset date is null.
      due_date: dueDate === "" ? null : dueDate,
    });

    if (insertError) {
      setError(insertError.message);
      setBusy(false);
      return;
    }

    setTitle("");
    setDueDate("");
    setBusy(false);
    router.refresh();
  };

  const setCompleted = async (id: number, completed: boolean) => {
    setBusy(true);
    setError(null);

    const supabase = createClient();
    // count: "exact" — RLS filters rather than erroring, so a toggle on someone
    // else's task would otherwise look like it worked until the next refresh.
    const { error: updateError, count } = await supabase
      .from("tasks")
      .update({ completed }, { count: "exact" })
      .eq("id", id);

    if (updateError || count === 0) {
      setError(updateError?.message ?? "That task could not be updated.");
      setBusy(false);
      return;
    }

    setBusy(false);
    router.refresh();
  };

  const remove = async (id: number) => {
    setBusy(true);
    setError(null);

    const supabase = createClient();
    const { error: deleteError, count } = await supabase
      .from("tasks")
      .delete({ count: "exact" })
      .eq("id", id);

    if (deleteError || count === 0) {
      setError(deleteError?.message ?? "That task could not be removed.");
      setBusy(false);
      return;
    }

    setBusy(false);
    router.refresh();
  };

  return (
    <section className="flex flex-col gap-4">
      <h2 className="font-semibold text-lg">
        Tasks{openCount > 0 ? ` (${openCount} open)` : ""}
      </h2>

      <div className="flex flex-wrap items-end gap-3">
        <div className="grid gap-2 flex-1 min-w-[16rem]">
          <Label htmlFor={`task-title-${ownerType}-${ownerId}`}>Task</Label>
          <Input
            id={`task-title-${ownerType}-${ownerId}`}
            value={title}
            disabled={busy}
            placeholder="Call back about pricing"
            onChange={(e) => setTitle(e.target.value)}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor={`task-due-${ownerType}-${ownerId}`}>Due</Label>
          <Input
            id={`task-due-${ownerType}-${ownerId}`}
            type="date"
            value={dueDate}
            disabled={busy}
            onChange={(e) => setDueDate(e.target.value)}
          />
        </div>
        <Button
          size="sm"
          onClick={() => void add()}
          disabled={busy || title.trim() === ""}
        >
          <PlusIcon size={16} />
          {busy ? "Saving…" : "Add task"}
        </Button>
      </div>

      {error && <p className="text-sm text-red-500">{error}</p>}

      {tasks.length === 0 ? (
        <p className="text-sm text-muted-foreground">No tasks yet.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {tasks.map((task) => {
            const overdue = taskIsOverdue(task);
            return (
              <li
                key={task.id}
                className="flex items-center justify-between gap-4 rounded-md border p-3"
              >
                <div className="flex items-center gap-3">
                  <Checkbox
                    id={`task-${task.id}`}
                    checked={task.completed}
                    disabled={busy}
                    onCheckedChange={(checked) =>
                      void setCompleted(task.id, checked === true)
                    }
                  />
                  <div className="flex flex-col gap-1">
                    <Label
                      htmlFor={`task-${task.id}`}
                      className={cn(
                        "text-sm font-normal",
                        task.completed && "line-through text-muted-foreground",
                      )}
                    >
                      {task.title}
                    </Label>
                    <span
                      className={cn(
                        "text-xs text-muted-foreground",
                        overdue && "text-red-500",
                      )}
                    >
                      {task.due_date === null
                        ? "No due date"
                        : `${overdue ? "Overdue — due" : "Due"} ${formatDate(task.due_date)}`}
                      {task.author_name !== null && ` · ${task.author_name}`}
                    </span>
                  </div>
                </div>
                {isAdmin && (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={busy}
                    onClick={() => void remove(task.id)}
                    aria-label="Remove task"
                  >
                    <Trash2Icon size={16} />
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}
