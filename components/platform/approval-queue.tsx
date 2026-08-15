"use client";

/**
 * Ordence — ⭐⭐⭐ THE APPROVAL QUEUE, ON A SCREEN
 * Version: v1.22.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THIS SCREEN DECIDES NOTHING
 * ══════════════════════════════════════════════════════════════════════
 * Whether a request may be approved is `mayApprove()` in
 * `lib/platform/approvals.ts`, and it is re-decided on the server for
 * every submission. What this file does is show the SAME verdict before
 * the click, so an operator is never surprised by a refusal.
 *
 * ⚠️ THE ONE THING IT MUST GET RIGHT IS SAYING WHY. A greyed-out button
 * with no explanation is read as a bug, and the response to a bug is to
 * find a way around it.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  POLICY_BY_KIND,
  SELF_APPROVAL_WAIT_MINUTES,
  mayApprove,
  type ApprovalKind,
} from "@/lib/platform/approvals";

export type ApprovalRowView = {
  id: string;
  actionKind: string;
  targetLabel: string;
  justification: string;
  requestedBy: string;
  requestedAt: string;
  expiresAt: string;
  status: string;
  requiredGrade: string;
  selfApproved: boolean;
  decisionNote: string | null;
  executionError: string | null;
  proposedAfter: Record<string, unknown> | null;
  /**
   * ══════════════════════════════════════════════════════════════════
   * ⭐⭐ HOW MANY OTHER PEOPLE COULD DECIDE THIS ONE. PER ROW.
   * ══════════════════════════════════════════════════════════════════
   * This replaced a single `soleOperator` prop for the whole list, which
   * was wrong in two ways at once and produced a screen that predicted a
   * different verdict from the server.
   *
   * ⚠️ IT IGNORED GRADE. Every policy needs `owner`. The flag came from
   * a count of every usable grant, so the first support engineer to be
   * given access flipped it to false for the only owner — who was then
   * told "there is another operator who can approve it" about somebody
   * `mayApprove` refuses on grade. Nothing could be approved by anyone.
   *
   * ⚠️ IT IGNORED THE REQUESTER. "Am I the only one?" has a different
   * answer for a row I raised than for a row somebody else raised, and
   * one flag for the list cannot carry both.
   *
   * 🔴 `listPending` computes this server-side from the row's own
   * required grade, and `decideApproval` recomputes it the same way at
   * decision time. The number this screen reasons about is the number
   * the server will act on.
   */
  otherEligibleApprovers: number;
};

type Result = { ok: true; data: { note: string } } | { ok: false; error: string };

export function ApprovalQueue({
  rows,
  myStaffId,
  myGrade,
  onDecide,
}: {
  rows: ApprovalRowView[];
  myStaffId: string;
  myGrade: "support" | "engineer" | "owner";
  onDecide: (input: {
    requestId: string;
    approve: boolean;
    note: string;
  }) => Promise<Result>;
}) {
  const router = useRouter();
  const [open, setOpen] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [pending, startTransition] = useTransition();
  // ⚠️ Taken ONCE per render rather than per row, so two rows in the same
  // list cannot disagree about what time it is.
  const now = new Date();

  const pendingRows = rows.filter((r) => r.status === "pending");
  const decided = rows.filter((r) => r.status !== "pending");

  function decide(row: ApprovalRowView, approve: boolean) {
    startTransition(async () => {
      const result = await onDecide({ requestId: row.id, approve, note });
      if (result.ok) {
        setOpen(null);
        setNote("");
        toast.success(result.data.note);
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  return (
    <div className="space-y-6">
      <section className="space-y-3">
        <h2 className="text-sm font-semibold">
          Waiting ({pendingRows.length})
        </h2>

        {pendingRows.length === 0 ? (
          /*
            🔴 THIS COPY LISTED FOUR THINGS THE QUEUE CATCHES. It catches
            one. "Deletion, plan changes and paid overrides" all still
            execute the moment they are clicked, and telling an operator
            otherwise on the screen whose job is to be honest about
            approvals is how somebody stops checking. The list of what is
            and is not held now lives below, generated from the running
            registry, and this sentence stops trying to duplicate it.
          */
          <p className="text-sm text-muted-foreground">
            Nothing is waiting. That is the normal state — only the actions
            marked Enforced below reach this queue, so a busy queue means
            something unusual is happening rather than that the tool is
            working.
          </p>
        ) : null}

        {pendingRows.map((row) => {
          const policy = POLICY_BY_KIND[row.actionKind as ApprovalKind];
          const verdict = mayApprove({
            kind: row.actionKind,
            requestedBy: row.requestedBy,
            requestedAt: new Date(row.requestedAt),
            approverId: myStaffId,
            approverGrade: myGrade,
            status: row.status,
            expiresAt: new Date(row.expiresAt),
            now,
            // ⚠️ THE ROW'S OWN ANSWER. See the field's comment: a
            // list-wide flag was both grade-blind and requester-blind,
            // and the screen and the server disagreed because of it.
            soleOperator: row.otherEligibleApprovers === 0,
          });

          const mine = row.requestedBy === myStaffId;
          // ⚠️ Hoisted rather than read inside the JSX. TypeScript narrows
          // the verdict union inside one ternary and forgets it in the
          // next, and a `!` there would be a lie about a discriminated
          // union rather than a shortcut.
          const isSelfApproval = verdict.allowed && verdict.selfApproved;

          return (
            <Card key={row.id} data-testid={`approval-${row.id}`}>
              <CardContent className="space-y-3 pt-4">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">
                    {policy?.label ?? row.actionKind}
                  </span>
                  <Badge variant="destructive">{row.targetLabel}</Badge>
                  {mine ? <Badge variant="outline">yours</Badge> : null}
                  <span className="ml-auto text-xs text-muted-foreground">
                    expires {new Date(row.expiresAt).toLocaleString("en-IN")}
                  </span>
                </div>

                {policy ? (
                  <p className="text-xs text-muted-foreground">
                    Held because: {policy.because}
                  </p>
                ) : null}

                <p className="text-sm">
                  <span className="text-muted-foreground">Reason given: </span>
                  {row.justification}
                </p>

                {row.proposedAfter && Object.keys(row.proposedAfter).length > 0 ? (
                  <pre className="overflow-x-auto rounded bg-muted p-2 text-xs">
                    {JSON.stringify(row.proposedAfter, null, 2)}
                  </pre>
                ) : null}

                {/*
                  ⭐ THE REFUSAL IS PRINTED, ALWAYS. `mayApprove` returns a
                  sentence rather than a boolean precisely so this line can
                  exist, and so the screen and the server say the same words.
                */}
                {!verdict.allowed ? (
                  <p className="rounded border border-dashed p-2 text-xs text-muted-foreground">
                    {verdict.reason}
                  </p>
                ) : isSelfApproval ? (
                  <p className="rounded border border-amber-400 p-2 text-xs">
                    You are about to approve your own request. That is allowed
                    while Ordence has one operator, it is recorded as a
                    self-approval in the row and in the log, and it needed{" "}
                    {SELF_APPROVAL_WAIT_MINUTES} minutes of waiting. It stops
                    being offered the day a second operator exists.
                  </p>
                ) : null}

                {open === row.id ? (
                  <div className="space-y-2">
                    <Textarea
                      value={note}
                      onChange={(e) => setNote(e.target.value)}
                      rows={3}
                      placeholder="What did you check before deciding this?"
                    />
                    <div className="flex flex-wrap gap-2">
                      <Button
                        size="sm"
                        disabled={pending || !verdict.allowed}
                        onClick={() => decide(row, true)}
                      >
                        {isSelfApproval ? "Self-approve and run" : "Approve and run"}
                      </Button>
                      <Button
                        size="sm"
                        variant="destructive"
                        disabled={pending}
                        onClick={() => decide(row, false)}
                      >
                        Reject
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => {
                          setOpen(null);
                          setNote("");
                        }}
                      >
                        Cancel
                      </Button>
                    </div>
                  </div>
                ) : (
                  <Button size="sm" variant="outline" onClick={() => setOpen(row.id)}>
                    Decide
                  </Button>
                )}
              </CardContent>
            </Card>
          );
        })}
      </section>

      {/*
        ⚠️ DECIDED ROWS STAY ON THE SCREEN. A queue that empties itself
        looks like nothing ever happens, and the executed and FAILED rows
        are the two an auditor actually wants.
      */}
      <section className="space-y-2">
        <h2 className="text-sm font-semibold">Recently decided</h2>
        {decided.length === 0 ? (
          <p className="text-sm text-muted-foreground">Nothing yet.</p>
        ) : null}
        <div className="space-y-2">
          {decided.map((row) => (
            <div
              key={row.id}
              className="flex flex-wrap items-center gap-2 rounded border p-2 text-xs"
            >
              <Badge
                variant={
                  row.status === "executed"
                    ? "secondary"
                    : row.status === "failed"
                      ? "destructive"
                      : "outline"
                }
              >
                {row.status}
              </Badge>
              <span className="font-medium">
                {POLICY_BY_KIND[row.actionKind as ApprovalKind]?.label ?? row.actionKind}
              </span>
              <span className="text-muted-foreground">{row.targetLabel}</span>
              {row.selfApproved ? <Badge variant="outline">self-approved</Badge> : null}
              {row.executionError ? (
                <span className="w-full text-destructive">{row.executionError}</span>
              ) : null}
              {row.decisionNote ? (
                <span className="w-full text-muted-foreground">{row.decisionNote}</span>
              ) : null}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
