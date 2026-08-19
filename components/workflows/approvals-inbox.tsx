"use client";

/**
 * Ordence — Approvals Inbox
 * Version: v0.24.0-alpha
 *
 * The human half of the `form` step: a run is suspended, holding its
 * position in a definition, until somebody here answers.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ AN ANSWER IS AN ACT, SO IT IS DELIBERATE AND IT IS ATTRIBUTED
 * ══════════════════════════════════════════════════════════════════════
 * Approving resumes a program that will then do things to customer data
 * under somebody's authority. Three consequences, all visible here:
 *
 *   • The buttons are not adjacent look-alikes. Approve is the primary
 *     action; Reject is destructive-styled and says what it will do.
 *   • The note is written into the audit log verbatim, and the label
 *     says so. It is the field somebody reads six months later.
 *   • An ASSIGNED request is answered by its assignee. Holding
 *     `workflows:approve` is permission to approve the things asked of
 *     you, not to sign on somebody else's behalf — the server refuses
 *     that, and the list here only ever shows what is yours or
 *     unassigned.
 *
 * ⚠️ WHAT A REJECTION MEANS IS THE WORKFLOW AUTHOR'S DECISION, NOT THE
 * APPROVER'S. `onReject` is either "stop" (a no is a normal outcome) or
 * "fail" (a no means something is wrong). The inbox does not know which
 * — it is inside the definition — so it says both are possible rather
 * than promising one.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { Check, Clock, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { ActionResult } from "@/lib/validators/crm";
import { formatMoment } from "./presentation";

export type RespondToTaskAction = (input: unknown) => Promise<
  ActionResult<{ taskId: string; runStatus: string }>
>;

export type ApprovalTask = {
  id: string;
  runId: string;
  stepKey: string;
  title: string;
  instructions: string | null;
  expiresAt: string;
  assignedToMe: boolean;
};

export function ApprovalsInbox({
  tasks,
  onRespond,
}: {
  tasks: readonly ApprovalTask[];
  onRespond: RespondToTaskAction;
}) {
  if (tasks.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border p-10 text-center">
        <p className="text-sm font-medium">Nothing is waiting on you.</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Approval requests appear here when a workflow reaches a step that needs a
          person. They expire if nobody answers, so a run never waits forever.
        </p>
      </div>
    );
  }

  return (
    <ul className="space-y-3">
      {tasks.map((task) => (
        <li key={task.id}>
          <ApprovalCard task={task} onRespond={onRespond} />
        </li>
      ))}
    </ul>
  );
}

function ApprovalCard({
  task,
  onRespond,
}: {
  task: ApprovalTask;
  onRespond: RespondToTaskAction;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  const respond = (decision: "approve" | "reject") => {
    setError(null);
    startTransition(async () => {
      const result = await onRespond({
        taskId: task.id,
        decision,
        comment: comment.trim() === "" ? undefined : comment.trim(),
      });

      if (!result.ok) {
        setError(result.error);
        return;
      }

      setDone(
        decision === "approve"
          ? `Approved. The run continued and is now "${result.data.runStatus}".`
          : `Rejected. The run ended — "${result.data.runStatus}".`,
      );
      router.refresh();
    });
  };

  const commentId = `comment-${task.id}`;

  return (
    <article className="rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold">{task.title}</h2>
          <p className="mt-0.5 text-[11px] text-muted-foreground">
            Step <code className="font-mono">{task.stepKey}</code> ·{" "}
            <Link
              href={`/automations/runs/${task.runId}`}
              className="text-primary hover:underline"
            >
              see what the run has already done
            </Link>
          </p>
        </div>

        <p className="flex items-center gap-1 text-[11px] text-amber-700">
          <Clock className="h-3.5 w-3.5" aria-hidden="true" />
          Expires {formatMoment(task.expiresAt)}
        </p>
      </div>

      {task.instructions ? (
        <p className="mt-2 whitespace-pre-wrap text-sm text-muted-foreground">
          {task.instructions}
        </p>
      ) : null}

      {!task.assignedToMe ? (
        <p className="mt-2 rounded border border-border bg-muted/30 px-2 py-1.5 text-[11px] text-muted-foreground">
          This request is not assigned to anybody in particular, so anyone with
          permission to approve can answer it — including you. Whoever answers first is
          recorded as having decided it.
        </p>
      ) : null}

      {done ? (
        <p
          role="status"
          className="mt-3 rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm text-emerald-800"
        >
          {done}
        </p>
      ) : (
        <>
          <div className="mt-3">
            <label htmlFor={commentId} className="mb-1 block text-xs font-medium">
              Note (optional)
            </label>
            <Textarea
              id={commentId}
              value={comment}
              onChange={(event) => setComment(event.target.value)}
              placeholder="Why you are approving or rejecting."
              aria-describedby={`${commentId}-help`}
            />
            <p id={`${commentId}-help`} className="mt-1 text-[11px] text-muted-foreground">
              Written verbatim into the audit log against your name. It is what
              somebody reads six months from now.
            </p>
          </div>

          {error ? (
            <p
              role="alert"
              className="mt-2 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive"
            >
              {error}
            </p>
          ) : null}

          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button type="button" disabled={pending} onClick={() => respond("approve")}>
              <Check className="h-4 w-4" aria-hidden="true" />
              Approve and continue the run
            </Button>
            <Button
              type="button"
              variant="destructive"
              disabled={pending}
              onClick={() => respond("reject")}
            >
              <X className="h-4 w-4" aria-hidden="true" />
              Reject and end the run
            </Button>
          </div>

          <p className="mt-2 text-[11px] text-muted-foreground">
            Approving resumes the workflow immediately — the steps after this one will
            run. Rejecting ends it, either as &ldquo;stopped&rdquo; or as
            &ldquo;failed&rdquo;, depending on how the workflow was written. Neither
            undoes anything the run has already done.
          </p>
        </>
      )}
    </article>
  );
}
