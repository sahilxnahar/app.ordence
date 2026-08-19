"use client";

/**
 * Ordence — 🔴🔴 CORRECTING A RATE THAT HAS ALREADY BEEN PAID AGAINST
 * Version: v1.46.0-alpha · Batch 52
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 THIS IS THE LOUD DOOR AND IT IS SUPPOSED TO BE UNCOMFORTABLE
 * ══════════════════════════════════════════════════════════════════════
 * `RateRevisionForm` next door adds a dated row and restates nothing.
 * This one edits a row that settled payroll runs have already been
 * computed against, which means the payslips those runs produced no
 * longer agree with what the system would compute today.
 *
 * ⚠️ IT IS STILL NECESSARY. The alternative to correcting a genuine typo
 * — ₹1,500 typed where ₹15,000 was meant — is a workspace that
 * reproduces a known-wrong figure forever, and a system that lies
 * quietly is worse than one that says loudly what it just did.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐⭐ WHAT MAKES IT DIFFERENT FROM AN "EDIT" BUTTON
 * ══════════════════════════════════════════════════════════════════════
 *   • IT NAMES THE RUNS BEFORE THE FIELDS. The affected run numbers are
 *     the first thing in the dialog, above the figures, because the
 *     question "should I be doing this at all" has to be asked before
 *     the question "what should the number be".
 *
 *   • THE CONFIRMATION IS THE LIST, NOT A CHECKBOX. The run numbers are
 *     sent back to the server, which recomputes them and refuses if they
 *     disagree. A colleague approving another run in the next tab while
 *     this dialog is open changes the answer, and the correction must
 *     not land on a month nobody authorised.
 *
 *   • IT SAYS WHAT IT DOES NOT DO. Correcting the rate does not
 *     recompute the frozen payslips — those are frozen on purpose. The
 *     two now disagree, and reconciling that is a decision for a person.
 *     A dialog that implied otherwise would be the more dangerous lie.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

export type CorrectionResult =
  | { ok: true; data: { id: string; restatedRuns: readonly string[]; note: string } }
  | { ok: false; error: string };

export function RateCorrectionDialog({
  rowId,
  label,
  effectiveFrom,
  effectiveTo,
  payloadJson,
  settledRunNos,
  onCorrect,
}: {
  rowId: string;
  label: string;
  effectiveFrom: string;
  effectiveTo: string | null;
  payloadJson: string;
  /** ⭐ The runs the server says this restates. Sent back for the check. */
  settledRunNos: readonly string[];
  onCorrect: (input: {
    rowId: string;
    payloadJson: string;
    effectiveFrom: string;
    effectiveTo: string | null;
    reason: string;
    acknowledgeRuns: string[];
  }) => Promise<CorrectionResult>;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  const [payload, setPayload] = useState(payloadJson);
  const [from, setFrom] = useState(effectiveFrom);
  const [to, setTo] = useState(effectiveTo ?? "");
  const [reason, setReason] = useState("");

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button size="sm" variant="destructive">
          Correct this rate
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Correct {label}</DialogTitle>
          <DialogDescription>
            This restates history. It is not how a Budget change is entered.
          </DialogDescription>
        </DialogHeader>

        {/*
          🔴 THE BLAST RADIUS, FIRST, NAMED. "3 runs affected" is a number
          somebody clicks past. A list containing the month they did not
          expect to see is a list that makes somebody stop.
        */}
        <div className="rounded border border-destructive p-3 text-xs">
          <p className="font-semibold">
            {settledRunNos.length === 1
              ? "One signed-off payroll run was computed against this rate:"
              : `${settledRunNos.length} signed-off payroll runs were computed against this rate:`}
          </p>
          <p className="mt-1 font-mono">{settledRunNos.join(", ")}</p>
          <p className="mt-2 text-muted-foreground">
            Those payslips are with the employees and they are frozen in the database — this
            correction does not change them and does not recompute anything. What it changes is
            what the system believes: from now on those months read the corrected figures, and
            anything reissued or recomputed from them will disagree with the payslips already
            issued. Telling the people affected is a thing a person has to do.
          </p>
        </div>

        <div className="grid gap-3 sm:grid-cols-2">
          <div className="space-y-1">
            <Label htmlFor={`corr-from-${rowId}`}>In force from</Label>
            <Input
              id={`corr-from-${rowId}`}
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label htmlFor={`corr-to-${rowId}`}>In force to</Label>
            <Input
              id={`corr-to-${rowId}`}
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
            {/*
              ⚠️ INCLUSIVE. `effective_to` is the LAST day the rate
              applies, not the first day it does not. Empty means still
              in force.
            */}
            <p className="text-xs text-muted-foreground">
              The last day this applies, inclusive. Empty means still in force.
            </p>
          </div>
        </div>

        <div className="space-y-1">
          <Label htmlFor={`corr-payload-${rowId}`}>The figures</Label>
          <Textarea
            id={`corr-payload-${rowId}`}
            rows={12}
            className="font-mono text-xs"
            value={payload}
            onChange={(e) => setPayload(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            Whole basis points and whole paise, as text. The figures being replaced are kept on
            the row so an old payslip can still be explained.
          </p>
        </div>

        <div className="space-y-1">
          <Label htmlFor={`corr-reason-${rowId}`} required>
            Why this is being corrected
          </Label>
          <Textarea
            id={`corr-reason-${rowId}`}
            rows={3}
            value={reason}
            placeholder="e.g. Ceiling was entered as ₹1,500. The EPFO ceiling has been ₹15,000 since 2014 and both March and April were computed against the wrong figure."
            onChange={(e) => setReason(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">
            At least twenty characters, recorded against the row and in the audit log. This is
            the sentence somebody reads when an employee asks why their March payslip does not
            match.
          </p>
        </div>

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => setOpen(false)}>
            Leave it alone
          </Button>
          <Button
            variant="destructive"
            size="sm"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                const result = await onCorrect({
                  rowId,
                  payloadJson: payload,
                  effectiveFrom: from,
                  effectiveTo: to.trim() === "" ? null : to.trim(),
                  reason,
                  /*
                    🔴 THE LIST THE SCREEN WAS RENDERED WITH, NOT ONE
                    BUILT AT CLICK TIME. The server recomputes it and
                    refuses on any disagreement, so a stale page is a
                    refusal rather than a silent extra month.
                  */
                  acknowledgeRuns: [...settledRunNos],
                });
                if (result.ok) {
                  toast.success(result.data.note, { duration: 15_000 });
                  setOpen(false);
                  router.refresh();
                } else {
                  toast.error(result.error, { duration: 15_000 });
                }
              })
            }
          >
            Correct it, restating {settledRunNos.length}{" "}
            {settledRunNos.length === 1 ? "run" : "runs"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
