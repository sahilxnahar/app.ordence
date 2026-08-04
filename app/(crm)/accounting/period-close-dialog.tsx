"use client";

/**
 * Ordence — Period Close & Reopen Dialogs
 * Version: v0.7.0-alpha
 * Resolves SEC-014 (period-close had a server action but no interface).
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY CLOSING A PERIOD GETS A CONFIRMATION MODAL AND NOT A BUTTON
 * ══════════════════════════════════════════════════════════════════════
 * Closing a period is the moment a set of numbers stops being a working
 * draft and becomes a reported figure. After it, the DATABASE — not this
 * component — refuses every insert, update and delete dated inside the
 * range (`enforce_period_close`, a BEFORE trigger, so the write never
 * lands). That is deliberately hard to undo.
 *
 * A single click is the wrong amount of friction for an irreversible-ish
 * act. The modal exists to make the person read three things before they
 * commit: which period, whether the trial balance actually agrees, and
 * what happens next.
 *
 * ══════════════════════════════════════════════════════════════════════
 * WHY "FORCE CLOSE" EXISTS BUT IS DELIBERATELY UGLY
 * ══════════════════════════════════════════════════════════════════════
 * Sometimes a real business genuinely must close on an unbalanced book —
 * a migration in progress, an opening-balance import mid-flight. Removing
 * the option entirely would push people to work around the system, which
 * is worse than letting them do it on the record. So it is available,
 * off by default, requires ticking a box that says what it means, and is
 * written into the audit log. Making it possible is not the same as
 * making it easy.
 *
 * ══════════════════════════════════════════════════════════════════════
 * SEPARATION OF DUTIES
 * ══════════════════════════════════════════════════════════════════════
 * The server action checks `accounting.period.close`, a permission the
 * Accountant role does NOT hold. Someone who posts entries cannot also
 * declare them final. This component hides the button when the permission
 * is absent, but hiding a button is a courtesy, not a control — the
 * server re-checks and the audit log records every denial.
 */

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, Lock, LockOpen, TriangleAlert } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export type PeriodSummary = {
  id: string;
  name: string;
  startDate: string;
  endDate: string;
  status: string;
  closedAt: string | null;
  closingNotes: string | null;
};

type CloseResult = { ok: true } | { ok: false; error: string };

/* ------------------------------------------------------------------ */
/* CLOSE                                                               */
/* ------------------------------------------------------------------ */

export function ClosePeriodDialog({
  period,
  trialBalanceAgrees,
  difference,
  closeAction,
  disabled,
  disabledReason,
}: {
  period: PeriodSummary;
  /** Whether the books currently balance. Drives the warning path. */
  trialBalanceAgrees: boolean;
  /** Signed difference as a decimal string, for display only. */
  difference: string;
  closeAction: (input: {
    periodId: string;
    closingNotes?: string;
    forceUnbalanced: boolean;
  }) => Promise<CloseResult>;
  disabled?: boolean;
  disabledReason?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [notes, setNotes] = React.useState("");
  const [acknowledged, setAcknowledged] = React.useState(false);
  const [isPending, startTransition] = React.useTransition();

  // Reset the acknowledgement every time the dialog opens. Otherwise a
  // person who ticked it once, cancelled, and came back for a DIFFERENT
  // period would find the dangerous option already armed.
  React.useEffect(() => {
    if (open) {
      setAcknowledged(false);
      setNotes("");
    }
  }, [open]);

  const needsAcknowledgement = !trialBalanceAgrees;
  const canConfirm = !needsAcknowledgement || acknowledged;

  function handleConfirm() {
    startTransition(async () => {
      try {
        const result = await closeAction({
          periodId: period.id,
          closingNotes: notes.trim() || undefined,
          forceUnbalanced: needsAcknowledgement && acknowledged,
        });

        if (result.ok) {
          toast.success(`Period "${period.name}" is closed.`);
          setOpen(false);
          router.refresh();
          return;
        }
        toast.error(result.error);
      } catch (err) {
        console.error("[close period]", err);
        toast.error("Could not reach the server. Please try again.");
      }
    });
  }

  if (disabled) {
    return (
      <Button variant="outline" size="sm" disabled title={disabledReason}>
        <Lock className="h-4 w-4" aria-hidden="true" />
        Close period
      </Button>
    );
  }

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <Lock className="h-4 w-4" aria-hidden="true" />
        Close period
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Close &ldquo;{period.name}&rdquo;?</DialogTitle>
            <DialogDescription>
              {period.startDate} to {period.endDate}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {/* What actually happens — stated plainly, not in legalese. */}
            <div className="rounded-md border border-border bg-muted/40 p-3 text-sm">
              <p className="font-medium">After closing, the database will reject:</p>
              <ul className="mt-1.5 list-disc space-y-0.5 pl-5 text-muted-foreground">
                <li>any new entry dated inside this period</li>
                <li>any edit or deletion of an entry already in it</li>
                <li>back-dated corrections, including by an administrator</li>
              </ul>
              <p className="mt-2 text-muted-foreground">
                Corrections after this point must be posted as a reversing entry in an
                open period. That is the intended behaviour — the trail stays intact.
              </p>
            </div>

            {/* The balance verdict. */}
            {trialBalanceAgrees ? (
              <p
                className="rounded-md border border-emerald-600/30 bg-emerald-600/5 px-3 py-2 text-sm text-emerald-700 dark:text-emerald-400"
                role="status"
              >
                Trial balance agrees. Debits equal credits.
              </p>
            ) : (
              <div
                className="space-y-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive"
                role="alert"
              >
                <p className="flex items-start gap-2 font-medium">
                  <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                  <span>
                    The trial balance does not agree — a difference of {difference}.
                  </span>
                </p>
                <p>
                  Closing now locks in books that do not balance. Almost always the right
                  move is to cancel, find the difference, and come back.
                </p>

                <label className="flex cursor-pointer items-start gap-2 pt-1 font-medium">
                  <input
                    type="checkbox"
                    checked={acknowledged}
                    onChange={(e) => setAcknowledged(e.target.checked)}
                    className="mt-0.5 h-4 w-4 accent-destructive"
                  />
                  <span>
                    I understand the books do not balance and I am closing anyway. This
                    will be recorded against my name in the audit log.
                  </span>
                </label>
              </div>
            )}

            <div className="space-y-1.5">
              <Label htmlFor="closing-notes">Closing notes (optional)</Label>
              <Textarea
                id="closing-notes"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={3}
                maxLength={2000}
                placeholder="Anything a future auditor should know about this close."
              />
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={isPending}>
              Cancel
            </Button>
            <Button
              variant={needsAcknowledgement ? "destructive" : "default"}
              onClick={handleConfirm}
              disabled={!canConfirm || isPending}
            >
              {isPending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
              {isPending
                ? "Closing…"
                : needsAcknowledgement
                  ? "Force close unbalanced"
                  : "Close period"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* REOPEN                                                              */
/* ------------------------------------------------------------------ */

/**
 * Reopening demands a written reason of at least 15 characters, matched to
 * `reopenPeriodSchema` on the server. The submit button stays disabled
 * until that is satisfied, so the person is not told "too short" only
 * after they commit.
 */
export function ReopenPeriodDialog({
  period,
  reopenAction,
  disabled,
  disabledReason,
}: {
  period: PeriodSummary;
  reopenAction: (input: { periodId: string; reason: string }) => Promise<CloseResult>;
  disabled?: boolean;
  disabledReason?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = React.useState(false);
  const [reason, setReason] = React.useState("");
  const [isPending, startTransition] = React.useTransition();

  React.useEffect(() => {
    if (open) setReason("");
  }, [open]);

  const trimmed = reason.trim();
  const reasonIsSufficient = trimmed.length >= 15;

  function handleConfirm() {
    startTransition(async () => {
      try {
        const result = await reopenAction({ periodId: period.id, reason: trimmed });
        if (result.ok) {
          toast.success(`Period "${period.name}" is open again.`);
          setOpen(false);
          router.refresh();
          return;
        }
        toast.error(result.error);
      } catch (err) {
        console.error("[reopen period]", err);
        toast.error("Could not reach the server. Please try again.");
      }
    });
  }

  if (disabled) {
    return (
      <Button variant="ghost" size="sm" disabled title={disabledReason}>
        <LockOpen className="h-4 w-4" aria-hidden="true" />
        Reopen
      </Button>
    );
  }

  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        <LockOpen className="h-4 w-4" aria-hidden="true" />
        Reopen
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>Reopen &ldquo;{period.name}&rdquo;?</DialogTitle>
            <DialogDescription>
              {period.startDate} to {period.endDate}
              {period.closedAt ? ` · closed ${period.closedAt.slice(0, 10)}` : ""}
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div
              className="rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-sm"
              role="alert"
            >
              <p className="flex items-start gap-2 font-medium text-amber-700 dark:text-amber-400">
                <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
                <span>This period&rsquo;s figures may already have been reported.</span>
              </p>
              <p className="mt-1.5 text-muted-foreground">
                Reopening allows the numbers behind those reports to change. Your reason
                is written to the audit log permanently and cannot be edited afterwards.
              </p>
            </div>

            <div className="space-y-1.5">
              <Label htmlFor="reopen-reason">
                Why is this period being reopened? <span aria-hidden="true">*</span>
              </Label>
              <Textarea
                id="reopen-reason"
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                rows={3}
                maxLength={2000}
                required
                aria-describedby="reopen-reason-help"
                placeholder="e.g. Vendor invoice AH-4471 was omitted from the March close and must be posted in period."
              />
              <p
                id="reopen-reason-help"
                className={
                  reasonIsSufficient
                    ? "text-xs text-muted-foreground"
                    : "text-xs text-destructive"
                }
              >
                {reasonIsSufficient
                  ? `${trimmed.length} characters — an auditor will read this.`
                  : `At least 15 characters required (${trimmed.length} so far).`}
              </p>
            </div>
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setOpen(false)} disabled={isPending}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              onClick={handleConfirm}
              disabled={!reasonIsSufficient || isPending}
            >
              {isPending && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
              {isPending ? "Reopening…" : "Reopen period"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
