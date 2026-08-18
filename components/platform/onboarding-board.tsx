"use client";

/**
 * Ordence — ⭐⭐⭐ THE STALLED-FIRST ONBOARDING LIST
 * Version: v1.52.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE SCREEN'S ONE JOB
 * ══════════════════════════════════════════════════════════════════════
 * Put the workspace that has been stuck longest at the top, and put the
 * number of days next to it in a size you cannot miss. Everything else on
 * the row exists to make the phone call possible without opening another
 * page: which step, how far through, who to ring.
 *
 * ⚠️ THE BIG NUMBER IS A COUNT OF DAYS, NOT A TIMESTAMP AND NOT "2 weeks
 * ago". "14/02" makes an operator do arithmetic; "about 2 weeks" makes
 * them do it and get it wrong. Nine is the figure the decision is made
 * on, so nine is what is printed.
 *
 * 🔴 `consoleHref` COMES FROM `@/lib/platform/console-paths`, NEVER FROM
 * `console-href`, which is `server-only` and fails the boundary gate the
 * moment a client file imports it. `isConsoleHost` arrives as a prop
 * because a browser has no `Host` header to read.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { DataTable, type DataTableColumn } from "@/components/platform/data-table";
import { consoleHref } from "@/lib/platform/console-paths";
import {
  ONBOARDING_TOTAL_STEPS,
  RESEND_INVITE_UNAVAILABLE_REASON,
  STALL_THRESHOLD_DAYS,
  countStalled,
  isStalled,
  stallWord,
  stepBlocker,
  stepLabel,
  stepsComplete,
  type OnboardingProgressRow,
} from "@/lib/platform/onboarding-progress";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type Result = { ok: true } | { ok: false; error: string };

export function OnboardingBoard({
  rows,
  isConsoleHost,
  onMarkForCall,
  truncated,
}: {
  rows: readonly OnboardingProgressRow[];
  isConsoleHost: boolean;
  onMarkForCall: (input: { tenantId: string; note: string }) => Promise<Result>;
  truncated: boolean;
}) {
  const router = useRouter();
  const [target, setTarget] = useState<OnboardingProgressRow | null>(null);
  const [note, setNote] = useState("");
  const [pending, startTransition] = useTransition();

  /**
   * ⭐ THE BADGE AND THE TABLE CANNOT DISAGREE. This is `countStalled`,
   * which is a loop over `isStalled` — the same predicate the row badge
   * calls. There is no second threshold comparison in this file.
   */
  const stalled = countStalled(rows);

  function submit() {
    if (!target) return;
    const tenantId = target.tenantId;
    startTransition(async () => {
      const result = await onMarkForCall({ tenantId, note });
      if (result.ok) {
        setTarget(null);
        setNote("");
        toast.success("Marked for a call. It is in the action register.");
        router.refresh();
      } else {
        toast.error(result.error);
      }
    });
  }

  const columns: readonly DataTableColumn<OnboardingProgressRow>[] = [
    {
      /**
       * ⭐ FIRST COLUMN AND THE DEFAULT SORT. Days, floored, rendered at
       * a size that survives being glanced at from the far side of a desk.
       */
      key: "days",
      header: "Days stalled",
      accessor: (r) => r.daysSinceProgress,
      sortable: true,
      cell: (r) => (
        <div className="flex items-baseline gap-2">
          <span
            className={
              isStalled(r)
                ? "text-3xl font-semibold tabular-nums leading-none text-destructive"
                : "text-3xl font-semibold tabular-nums leading-none text-muted-foreground"
            }
          >
            {r.daysSinceProgress}
          </span>
          {/*
            ⚠️ THE WORD, NOT THE COLOUR. One in twelve Indian men is
            colour-blind and a red numeral is a grey numeral to them.
          */}
          <Badge variant={isStalled(r) ? "destructive" : "secondary"}>{stallWord(r)}</Badge>
        </div>
      ),
    },
    {
      key: "workspace",
      header: "Workspace",
      accessor: (r) => r.name,
      sortable: true,
      cell: (r) => (
        <div className="space-y-0.5">
          <Link
            href={consoleHref(`/platform/tenants/${r.tenantId}`, isConsoleHost)}
            className="font-medium underline underline-offset-2"
          >
            {r.name}
          </Link>
          <div className="text-xs text-muted-foreground">
            {r.slug} · {r.planTier} · {r.status}
          </div>
        </div>
      ),
    },
    {
      key: "step",
      header: "Current step",
      accessor: (r) => r.currentStep,
      sortable: true,
      cell: (r) => (
        <div className="space-y-0.5">
          <div className="text-sm font-medium">
            {r.currentStep}. {stepLabel(r.currentStep)}
          </div>
          <div className="max-w-xs text-xs text-muted-foreground">{stepBlocker(r.currentStep)}</div>
        </div>
      ),
    },
    {
      key: "complete",
      header: "Steps done",
      accessor: (r) => stepsComplete(r.currentStep),
      sortable: true,
      cell: (r) => (
        <span className="tabular-nums text-sm">
          {stepsComplete(r.currentStep)} of {ONBOARDING_TOTAL_STEPS}
          {/* ⚠️ "Never started" is a different fact from "0 of 4 so far
              today" and it is the one that changes what you say on the
              call, so it is stated rather than implied by a zero. */}
          {r.neverStarted ? (
            <span className="ml-2 text-xs text-muted-foreground">never started</span>
          ) : null}
        </span>
      ),
    },
    {
      key: "contact",
      header: "Who to contact",
      accessor: (r) => r.contactEmail ?? "",
      sortable: true,
      cell: (r) =>
        r.contactEmail ? (
          <div className="space-y-0.5">
            <a href={`mailto:${r.contactEmail}`} className="text-sm underline underline-offset-2">
              {r.contactEmail}
            </a>
            <div className="text-xs text-muted-foreground">
              {r.contactName ?? "name not set"} · {r.contactStatus ?? "unknown"}
            </div>
          </div>
        ) : (
          // ⚠️ Spelled out. An empty cell reads as "not loaded"; this is a
          // real and actionable state — the workspace exists and nobody
          // was ever attached to it.
          <span className="text-xs text-muted-foreground">no user record — nobody to ring</span>
        ),
      hideOnMobile: true,
    },
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-3">
        <Badge variant={stalled > 0 ? "destructive" : "secondary"} data-testid="stalled-count">
          {stalled} stalled
        </Badge>
        <span className="text-sm text-muted-foreground">
          of {rows.length} still in setup · stalled means no completed step for{" "}
          {STALL_THRESHOLD_DAYS} days or more
        </span>
      </div>

      {truncated ? (
        <p className="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
          Showing the first 500 unfinished workspaces. That has never happened in
          normal operation — if you are reading this, something upstream is
          creating workspaces nobody is finishing.
        </p>
      ) : null}

      <DataTable
        id="onb"
        rows={rows}
        columns={columns}
        rowId={(r) => r.tenantId}
        caption={`${rows.length} workspaces still in setup.`}
        unit="workspaces"
        mode="client"
        searchable
        searchLabel="Find a workspace"
        searchText={(r) => `${r.name} ${r.slug} ${r.contactEmail ?? ""}`}
        /*
         * ⭐ STALLED FIRST BY DEFAULT, WITHOUT ANYONE TOUCHING A CONTROL.
         * A chronological default buries the nine-day workspace under six
         * that signed up this morning and are perfectly fine.
         */
        defaultSort={{ key: "days", dir: "desc" }}
        filters={[
          {
            key: "stall",
            label: "Stall",
            options: [
              { value: "stalled", label: "Stalled only" },
              { value: "moving", label: "Still moving" },
            ],
            // 🔴 Calls `isStalled`, never `daysSinceProgress >= 3`. The
            // filter, the badge and the row word are one function.
            match: (r, value) => (value === "stalled" ? isStalled(r) : !isStalled(r)),
            hint: `Stalled = ${STALL_THRESHOLD_DAYS}+ days since the last completed step.`,
          },
        ]}
        emptyTitle="Every workspace has finished setup."
        emptyHint="Nothing is waiting on a nudge."
        rowActions={(r) => (
          <div className="flex flex-wrap justify-end gap-2">
            {/*
              🔴 DISABLED, ON PURPOSE, WITH THE REASON ATTACHED. There is
              no invitation record and no invite email in this build — see
              RESEND_INVITE_UNAVAILABLE_REASON. A button that logged a
              "resend" and delivered nothing would cost a customer a week.
            */}
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled
              title={RESEND_INVITE_UNAVAILABLE_REASON}
              aria-label={`Resend invite — unavailable. ${RESEND_INVITE_UNAVAILABLE_REASON}`}
            >
              Resend invite — unavailable
            </Button>
            <Button
              type="button"
              size="sm"
              onClick={() => {
                setTarget(r);
                setNote("");
              }}
            >
              Mark for a call
            </Button>
          </div>
        )}
      />

      <p className="max-w-3xl text-xs text-muted-foreground">
        <strong className="text-foreground">Resend invite is switched off.</strong>{" "}
        {RESEND_INVITE_UNAVAILABLE_REASON}
      </p>

      <Dialog open={target !== null} onOpenChange={(open) => (open ? null : setTarget(null))}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Mark {target?.name ?? "this workspace"} for a call</DialogTitle>
            <DialogDescription>
              {target
                ? `Step ${target.currentStep} of ${ONBOARDING_TOTAL_STEPS}, ${target.daysSinceProgress} day(s) without progress. Nothing is sent to the customer — this writes an entry in the action register so whoever picks the list up tomorrow knows it is taken.`
                : null}
            </DialogDescription>
          </DialogHeader>
          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            placeholder="What is the call about? e.g. waiting on GSTIN from their accountant."
            aria-label="Why this workspace needs a call"
          />
          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setTarget(null)}>
              Cancel
            </Button>
            <Button
              type="button"
              onClick={submit}
              disabled={pending || note.trim().length < 12}
            >
              {pending ? "Recording…" : "Mark for a call"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
