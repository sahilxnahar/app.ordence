"use client";

/**
 * Ordence — ⭐⭐⭐ OFFBOARDING, ON THE SCREEN
 * Version: v1.46.0-alpha (Batch 46)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴🔴 THE MOST IMPORTANT THING THIS COMPONENT DOES IS TELL THE TRUTH
 * ══════════════════════════════════════════════════════════════════════
 * There is no scheduler in this build. Nothing reads a due termination
 * and deletes a workspace. A panel that renders a countdown without
 * saying so is worse than no panel at all: an operator reads it, tells a
 * departing customer "your records are gone on the 14th", and on the
 * 15th they are all still there. That is a data-protection statement
 * made to a customer on the strength of a progress bar.
 *
 * ⚠️ SO `executorPresent: false` IS RENDERED, PROMINENTLY, IN WORDS,
 * EVERY TIME. It is a server-computed field rather than a constant in
 * this file precisely so that the day somebody writes the executor, the
 * sentence changes with the code rather than being left behind.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE THREE CONFIRMATIONS ARE THREE DIFFERENT QUESTIONS
 * ══════════════════════════════════════════════════════════════════════
 *   THE SLUG asks "is this the right customer?" — it is copyable from
 *   the screen on purpose, because it guards against the wrong ROW, not
 *   against intent.
 *
 *   THE PHRASE asks "do you mean this?" — it is deliberately NOT on the
 *   screen to copy. Muscle memory cannot produce it.
 *
 *   THE ACKNOWLEDGEMENT asks about the WORLD, not about the form: has
 *   this customer actually been offered their data? It is the only one
 *   of the three that a careful operator can honestly fail.
 *
 * ⚠️ NONE OF THEM IS A SECURITY BOUNDARY. The server re-checks the
 * capability, the step-up, all three confirmations, and then still only
 * queues the request for a second owner. This dialog can be bypassed
 * with curl and nothing about the outcome changes.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Trash2, Download, Undo2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

/** Must match `TERMINATION_PHRASE` in `server/platform/tenants.ts`. */
const PHRASE = "DELETE ALL DATA";
const MIN_REASON = 20;
const MIN_CANCEL_REASON = 15;

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

export type OffboardingSummary = {
  stage: "scheduled" | "cancelled";
  phase: "cancel_window" | "retention" | "deletion_due" | "cancelled";
  requestedByEmail: string;
  approvedByEmail: string;
  approvedAt: string;
  scheduledFor: string;
  cancelWindowHours: number;
  retentionDays: number;
  retentionEndsAt: string;
  previousStatus: string;
  minutesLeftInWindow: number;
  daysLeftInRetention: number;
  cancellable: boolean;
  executorPresent: boolean;
  exportedAt?: string;
  exportRowCount?: number;
  cancelledAt?: string;
  cancelledByEmail?: string;
  cancelReason?: string;
};

export function OffboardingPanel({
  tenantId,
  tenantSlug,
  tenantName,
  status,
  canTerminate,
  offboarding,
  onRequest,
  onCancel,
  onExport,
}: {
  tenantId: string;
  tenantSlug: string;
  tenantName: string;
  status: string;
  canTerminate: boolean;
  offboarding: OffboardingSummary | null;
  onRequest: (input: {
    tenantId: string;
    confirmSlug: string;
    confirmPhrase: string;
    acknowledgeExport: true;
    reason: string;
    justification: string;
  }) => Promise<Result<{ note: string }>>;
  onCancel: (input: { tenantId: string; reason: string }) => Promise<Result<{ note: string }>>;
  onExport: (input: { tenantId: string }) => Promise<
    Result<{ fileName: string; rowCount: number; failures: string[]; file: string | null; note: string }>
  >;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState<null | "terminate" | "cancel">(null);
  const [error, setError] = useState<string | null>(null);

  const [typedSlug, setTypedSlug] = useState("");
  const [typedPhrase, setTypedPhrase] = useState("");
  const [acknowledged, setAcknowledged] = useState(false);
  const [reason, setReason] = useState("");
  const [cancelReason, setCancelReason] = useState("");

  const live = offboarding?.stage === "scheduled";

  const ready =
    typedSlug.trim() === tenantSlug &&
    typedPhrase.trim() === PHRASE &&
    acknowledged &&
    reason.trim().length >= MIN_REASON &&
    !pending;

  function reset() {
    setTypedSlug("");
    setTypedPhrase("");
    setAcknowledged(false);
    setReason("");
    setError(null);
  }

  function request() {
    setError(null);
    startTransition(async () => {
      const result = await onRequest({
        tenantId,
        confirmSlug: typedSlug.trim(),
        confirmPhrase: typedPhrase.trim(),
        acknowledgeExport: true,
        reason: reason.trim(),
        // ⚠️ The same sentence serves as the queue justification and as
        // the reason written into the customer's own audit log. Asking
        // for two paragraphs produces one paragraph and one "see above".
        justification: reason.trim(),
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOpen(null);
      reset();
      toast.success(result.data.note);
      router.refresh();
    });
  }

  function cancel() {
    setError(null);
    startTransition(async () => {
      const result = await onCancel({ tenantId, reason: cancelReason.trim() });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOpen(null);
      setCancelReason("");
      toast.success(result.data.note);
      router.refresh();
    });
  }

  /**
   * ⭐ THE EXPORT IS HANDED TO THE BROWSER AS A BLOB, NOT A LINK.
   *
   * ⚠️ There is no object store in this build and no signed URL to hand
   * out, so a "download" link would have to be a route that re-runs the
   * whole extract on every click. The file comes back with the action
   * result; above roughly eight megabytes the server returns the counts
   * and says the extract has to come from the backup tooling, which the
   * toast repeats verbatim rather than failing silently.
   */
  function runExport() {
    setError(null);
    startTransition(async () => {
      const result = await onExport({ tenantId });
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      if (result.data.file) {
        const blob = new Blob([result.data.file], { type: "application/json" });
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = result.data.fileName;
        a.click();
        URL.revokeObjectURL(url);
      }
      toast.success(result.data.note);
      router.refresh();
    });
  }

  return (
    <div className="space-y-4">
      {/* ---------------------------------------------------------- */}
      {/* THE HONEST BANNER. NOT COLLAPSIBLE, NOT BELOW THE FOLD.     */}
      {/* ---------------------------------------------------------- */}
      {offboarding && !offboarding.executorPresent ? (
        <p
          role="alert"
          data-testid="offboarding-no-executor"
          className="rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm"
        >
          🔴 <strong>Nothing in this build carries out a due termination.</strong> The
          scheduled moment below is recorded, the workspace is locked read-only, and the
          cancel works — but no job, cron or worker reads this record and deletes anything.
          Do not tell a customer their records disappear on that date. Deletion is a manual
          operation until an executor ships.
        </p>
      ) : null}

      {offboarding ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex flex-wrap items-center gap-2">
              {offboarding.stage === "cancelled" ? "Termination cancelled" : "Termination scheduled"}
              <Badge variant={offboarding.stage === "cancelled" ? "outline" : "destructive"}>
                {PHASE_LABELS[offboarding.phase]}
              </Badge>
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            <dl className="grid gap-3 sm:grid-cols-3">
              <Fact label="Requested by" value={offboarding.requestedByEmail} />
              <Fact label="Approved by" value={offboarding.approvedByEmail} />
              <Fact label="Approved at" value={offboarding.approvedAt.slice(0, 16).replace("T", " ")} />
              <Fact
                label="Scheduled for"
                value={offboarding.scheduledFor.slice(0, 16).replace("T", " ")}
              />
              <Fact
                label="Cancel window"
                value={`${offboarding.cancelWindowHours} hours`}
              />
              <Fact
                label="Retention"
                value={`${offboarding.retentionDays} days, to ${offboarding.retentionEndsAt.slice(0, 10)}`}
              />
              <Fact
                label="Export taken"
                value={
                  offboarding.exportedAt
                    ? `${offboarding.exportedAt.slice(0, 16).replace("T", " ")} · ${
                        offboarding.exportRowCount ?? 0
                      } rows`
                    : "not yet"
                }
              />
              <Fact label="Restores to" value={offboarding.previousStatus} />
              {offboarding.cancelledAt ? (
                <Fact
                  label="Cancelled by"
                  value={`${offboarding.cancelledByEmail ?? "—"} at ${offboarding.cancelledAt.slice(0, 16).replace("T", " ")}`}
                />
              ) : null}
            </dl>

            {/*
              ⭐ THE COUNTDOWN IS IN THE UNIT THAT MATCHES THE URGENCY.
              "1,437 minutes" and "23 hours" are the same number and only
              one of them tells somebody whether they can go to bed.
            */}
            {live ? (
              <p className="rounded-md border border-border p-3">
                {offboarding.phase === "cancel_window" ? (
                  <>
                    <strong>{formatWindow(offboarding.minutesLeftInWindow)}</strong> left to
                    cancel. Until then this is fully reversible and{" "}
                    <strong>{tenantName}</strong> returns to{" "}
                    <code className="font-mono">{offboarding.previousStatus}</code>.
                  </>
                ) : offboarding.phase === "retention" ? (
                  <>
                    The cancel window has passed. {offboarding.daysLeftInRetention} day
                    {offboarding.daysLeftInRetention === 1 ? "" : "s"} of retention remain.
                    Nothing has been deleted, and cancelling still works.
                  </>
                ) : (
                  <>
                    Retention has elapsed and deletion is <strong>due</strong>. It has not
                    happened — see the notice above. Cancelling still works.
                  </>
                )}
              </p>
            ) : (
              <p className="rounded-md border border-border p-3 text-muted-foreground">
                Cancelled{offboarding.cancelReason ? `: ${offboarding.cancelReason}` : "."} The
                record is kept rather than deleted — that a termination was requested and
                pulled is the most interesting thing on this workspace.
              </p>
            )}

            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                disabled={!canTerminate || pending}
                title={canTerminate ? undefined : "Platform owner grade required."}
                onClick={runExport}
              >
                <Download className="h-4 w-4" aria-hidden /> Export everything
              </Button>
              {live ? (
                <Button
                  disabled={!canTerminate || pending || !offboarding.cancellable}
                  title={canTerminate ? undefined : "Platform owner grade required."}
                  onClick={() => setOpen("cancel")}
                >
                  <Undo2 className="h-4 w-4" aria-hidden /> Cancel the termination
                </Button>
              ) : null}
            </div>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardHeader>
            <CardTitle>Offboard this workspace</CardTitle>
          </CardHeader>
          <CardContent className="space-y-4 text-sm">
            <p className="text-muted-foreground">
              Terminating cancels the relationship and starts a clock. It does not delete
              anything today: the workspace goes read-only, the customer keeps their export,
              a cancel window runs, and a retention period follows it.
            </p>
            <ol className="ml-4 list-decimal space-y-1 text-muted-foreground">
              <li>You raise it with three confirmations and a written reason.</li>
              <li>A second platform owner approves it in the approval queue.</li>
              <li>
                Approval locks the workspace read-only and writes a scheduled moment. It
                deletes nothing.
              </li>
              <li>Anyone with owner grade can cancel until — and after — that moment.</li>
              <li>Retention counts down from the scheduled moment.</li>
            </ol>
            <div className="flex flex-wrap gap-2">
              <Button
                variant="outline"
                disabled={!canTerminate || pending}
                onClick={runExport}
                title={canTerminate ? undefined : "Platform owner grade required."}
              >
                <Download className="h-4 w-4" aria-hidden /> Export everything first
              </Button>
              <Button
                variant="destructive"
                disabled={!canTerminate || pending || status === "pending_deletion"}
                title={
                  canTerminate
                    ? undefined
                    : "Platform owner grade required, with a fresh identity confirmation."
                }
                onClick={() => setOpen("terminate")}
              >
                <Trash2 className="h-4 w-4" aria-hidden /> Request termination
              </Button>
            </div>
            {!canTerminate ? (
              <p className="text-xs text-muted-foreground">
                Your grade can read this and cannot request a termination.
              </p>
            ) : null}
          </CardContent>
        </Card>
      )}

      {/* ---- REQUEST: THREE CONFIRMATIONS ---- */}
      <Dialog
        open={open === "terminate"}
        onOpenChange={(v) => {
          setOpen(v ? "terminate" : null);
          if (!v) reset();
        }}
      >
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Request termination of {tenantName}</DialogTitle>
            <DialogDescription>
              This goes to the approval queue. Nothing happens until a second platform owner
              approves it, and approving it schedules rather than deletes.
            </DialogDescription>
          </DialogHeader>

          <ul className="space-y-1 rounded-md border border-border bg-muted/40 p-3 text-xs">
            <li>· Approval locks the workspace: no sign-in, no writes. Export still works.</li>
            <li>
              · A cancel window runs from approval. Its length comes from the configuration
              chain, so an enterprise workspace gets a longer one.
            </li>
            <li>· Retention counts down after that. Nothing is deleted by any of it.</li>
            <li>
              · 🔴 No job in this build performs the deletion. This schedules a date and a
              human does the rest.
            </li>
          </ul>

          <div className="space-y-1">
            <Label htmlFor="terminate-slug">1 · Type the workspace address</Label>
            <Input
              id="terminate-slug"
              value={typedSlug}
              autoComplete="off"
              spellCheck={false}
              placeholder={tenantSlug}
              onChange={(e) => setTypedSlug(e.target.value)}
            />
          </div>

          <div className="space-y-1">
            <Label htmlFor="terminate-phrase">
              2 · Type <code className="font-mono">{PHRASE}</code>
            </Label>
            <Input
              id="terminate-phrase"
              value={typedPhrase}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => setTypedPhrase(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Not shown as placeholder text on purpose — a confirmation you can copy is a
              confirmation you can type without reading.
            </p>
          </div>

          <label className="flex items-start gap-2 rounded-md border border-destructive/40 p-3 text-sm">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(e) => setAcknowledged(e.target.checked)}
              className="mt-1"
            />
            <span>
              3 · This customer has been offered a full export of their records. Deleting a
              workspace whose owner never got their data back is a data-protection problem,
              not a support one.
            </span>
          </label>

          <div className="space-y-1">
            <Label htmlFor="terminate-reason">
              Why? (goes to the approval queue and the customer&rsquo;s own audit log)
            </Label>
            <Textarea
              id="terminate-reason"
              rows={3}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Ticket reference and one sentence."
            />
            <p className="text-xs text-muted-foreground">
              {reason.trim().length}/{MIN_REASON} characters minimum.
            </p>
          </div>

          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}

          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(null)} disabled={pending}>
              Cancel
            </Button>
            <Button variant="destructive" disabled={!ready} onClick={request}>
              {pending ? "Working…" : "Send for approval"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* ---- CANCEL: ONE FIELD, DELIBERATELY ---- */}
      <Dialog open={open === "cancel"} onOpenChange={(v) => setOpen(v ? "cancel" : null)}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Cancel the termination of {tenantName}</DialogTitle>
            <DialogDescription>
              The workspace returns to{" "}
              <code className="font-mono">{offboarding?.previousStatus ?? "its previous status"}</code>{" "}
              immediately. No approval is needed and no address has to be typed — stopping a
              destructive action must always be cheaper than starting one.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-1">
            <Label htmlFor="cancel-reason">Why is it being cancelled?</Label>
            <Textarea
              id="cancel-reason"
              rows={3}
              value={cancelReason}
              onChange={(e) => setCancelReason(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              {cancelReason.trim().length}/{MIN_CANCEL_REASON} characters minimum.
            </p>
          </div>

          {error ? (
            <p role="alert" className="text-sm text-destructive">
              {error}
            </p>
          ) : null}

          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(null)} disabled={pending}>
              Close
            </Button>
            <Button
              disabled={pending || cancelReason.trim().length < MIN_CANCEL_REASON}
              onClick={cancel}
            >
              {pending ? "Working…" : "Cancel the termination"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

const PHASE_LABELS: Readonly<Record<OffboardingSummary["phase"], string>> = {
  cancel_window: "cancel window open",
  retention: "retention",
  deletion_due: "deletion due",
  cancelled: "cancelled",
};

function formatWindow(minutes: number): string {
  if (minutes <= 0) return "No time";
  if (minutes < 90) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  return `${hours} hour${hours === 1 ? "" : "s"}`;
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="font-medium break-words">{value}</dd>
    </div>
  );
}
