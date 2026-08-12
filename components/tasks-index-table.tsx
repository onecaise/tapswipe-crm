"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Trash2Icon } from "lucide-react";

import { createClient } from "@/lib/supabase/client";
import {
  taskIsOverdue,
  type Task,
  type WithAuthor,
  type WithOwner,
} from "@/lib/annotations";
import { formatDate, formatText } from "@/lib/format";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/**
 * The /tasks table: every task the caller can see, across all four owner types.
 *
 * A client component because the checkbox writes, exactly as the per-record
 * panel's does — `update own or admin` already backs it, so surfacing the toggle
 * here needs no new policy. Everything else about the row is resolved on the
 * server and passed in.
 *
 * Creation is deliberately absent: a task needs an (owner_type, owner_id) pair,
 * owner_id has no foreign key, and the panels take that pair from a parent row
 * the page already loaded under RLS. There is no equivalent guarantee here.
 */
export function TasksIndexTable({
  tasks,
  isAdmin,
  emptyMessage,
}: {
  tasks: WithOwner<WithAuthor<Task>>[];
  isAdmin: boolean;
  emptyMessage: string;
}) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  // Checkbox column, then the admin-only delete column.
  const columnCount = 4 + (isAdmin ? 2 : 0);

  return (
    <div className="flex flex-col gap-4">
      {error && <p className="text-sm text-destructive">{error}</p>}

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-10" />
            <TableHead>Task</TableHead>
            <TableHead>Attached to</TableHead>
            {isAdmin && <TableHead>Agent</TableHead>}
            <TableHead>Due</TableHead>
            {isAdmin && <TableHead />}
          </TableRow>
        </TableHeader>
        <TableBody>
          {tasks.length === 0 ? (
            <TableRow>
              <TableCell
                colSpan={columnCount}
                className="text-muted-foreground"
              >
                {emptyMessage}
              </TableCell>
            </TableRow>
          ) : (
            tasks.map((task) => {
              const overdue = taskIsOverdue(task);
              return (
                <TableRow key={task.id}>
                  <TableCell>
                    <Checkbox
                      id={`task-${task.id}`}
                      checked={task.completed}
                      disabled={busy}
                      aria-label={`Mark "${task.title}" complete`}
                      onCheckedChange={(checked) =>
                        void setCompleted(task.id, checked === true)
                      }
                    />
                  </TableCell>
                  <TableCell
                    className={cn(
                      "font-medium",
                      task.completed && "line-through text-muted-foreground",
                    )}
                  >
                    {task.title}
                  </TableCell>
                  <TableCell>
                    {task.owner_href ? (
                      <Link
                        href={task.owner_href}
                        className="underline underline-offset-4"
                      >
                        {task.owner_label}
                      </Link>
                    ) : (
                      // Owner deleted, or not this caller's to see. Shown
                      // without a link rather than as a dead one.
                      <span className="text-muted-foreground">
                        {task.owner_label}
                      </span>
                    )}
                  </TableCell>
                  {isAdmin && (
                    <TableCell className="text-muted-foreground">
                      {formatText(task.author_name)}
                    </TableCell>
                  )}
                  <TableCell
                    className={cn(
                      "text-muted-foreground",
                      overdue && "text-destructive",
                    )}
                  >
                    {task.due_date === null
                      ? "No due date"
                      : `${overdue ? "Overdue — " : ""}${formatDate(task.due_date)}`}
                  </TableCell>
                  {isAdmin && (
                    <TableCell>
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={busy}
                        onClick={() => void remove(task.id)}
                        aria-label="Remove task"
                      >
                        <Trash2Icon size={16} />
                      </Button>
                    </TableCell>
                  )}
                </TableRow>
              );
            })
          )}
        </TableBody>
      </Table>
    </div>
  );
}
