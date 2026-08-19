"use client";

/**
 * Ordence — ⭐ RA BILL: RAISE, CERTIFY, APPROVE
 * Version: v0.70.0-alpha
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⚠️ THERE IS NO QUANTITY BOX ON THIS FILE, ANYWHERE, ON PURPOSE
 * ══════════════════════════════════════════════════════════════════════
 * The obvious form for raising a bill has a line editor: item, quantity,
 * rate. It is the design under every construction fraud the control
 * structure in `server/actions/ra-bills.ts` exists to prevent, because a
 * typed quantity has no relationship to anything that was measured,
 * checked, or built.
 *
 * So the only inputs here are a bill number, a period, and a compliance
 * month. Every line, every quantity and every rate is derived by the
 * server from measurements that somebody OTHER than the measurer has
 * checked. A user who wants to bill more must measure more.
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THREE BUTTONS, THREE PEOPLE — AND THE SCREEN SAYS SO
 * ══════════════════════════════════════════════════════════════════════
 *   RAISE    assembles the claim from checked work
 *   CERTIFY  an engineer's opinion that the work is worth the money
 *   APPROVE  the instruction to pay
 *
 * The server refuses a certifier who raised the bill, and an approver who
 * certified it. This component shows WHY rather than hiding the button:
 * a disabled control with no explanation gets worked around by asking a
 * colleague to press it, which defeats the separation while looking like
 * compliance. A sentence teaches the rule; a hidden button teaches
 * nothing.
 */

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  raiseRaBillFromMeasurements,
  certifyRaBill,
  approveRaBill,
} from "@/server/actions/ra-bills";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export type BillableContract = {
  contractId: string;
  contractNo: string;
  title: string;
  entries: number;
};

function Feedback({ error, notice }: { error: string | null; notice: string | null }) {
  if (error) {
    return (
      <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
        {error}
      </p>
    );
  }
  if (notice) {
    return (
      <p role="status" className="rounded-md border border-border bg-muted/40 p-3 text-sm">
        {notice}
      </p>
    );
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* RAISE                                                               */
/* ------------------------------------------------------------------ */

export function RaiseBillForm({ contracts }: { contracts: BillableContract[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const [contractId, setContractId] = useState(contracts[0]?.contractId ?? "");
  const [billNo, setBillNo] = useState("");
  const [periodFrom, setPeriodFrom] = useState("");
  const [periodTo, setPeriodTo] = useState("");
  const [complianceMonth, setComplianceMonth] = useState("");

  if (contracts.length === 0) return null;

  function submit() {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result = await raiseRaBillFromMeasurements({
        contractId,
        billNo,
        periodFrom: periodFrom || undefined,
        periodTo: periodTo || undefined,
        complianceMonth: complianceMonth || undefined,
      });

      if (!result.ok) {
        setError(result.error ?? "The bill could not be raised.");
        return;
      }

      /*
       * ⚠️ THE FIGURES IN THIS MESSAGE COME BACK FROM THE DATABASE, NOT
       * FROM ANYTHING THIS COMPONENT SENT. Cess, retention, TDS and net
       * payable are derived by a trigger; echoing what was submitted
       * would show a net payable that is simply the gross — wrong by the
       * entire deduction stack, and entirely plausible-looking.
       */
      setNotice(
        `${result.data.billNo} raised: ${result.data.lines} ${
          result.data.lines === 1 ? "line" : "lines"
        }, net payable computed by the ledger. It needs certifying by somebody else.`,
      );
      setOpen(false);
      setBillNo("");
      router.refresh();
    });
  }

  return (
    <div className="space-y-3">
      <Button size="sm" variant={open ? "default" : "outline"} onClick={() => setOpen(!open)}>
        {open ? "Cancel" : "Raise a bill from measured work"}
      </Button>

      <Feedback error={error} notice={notice} />

      {open && (
        <Card>
          <CardHeader>
            <CardTitle className="text-sm">Raise a running-account bill</CardTitle>
          </CardHeader>
          <CardContent className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1 sm:col-span-2">
              <Label htmlFor="rb-contract">Contract</Label>
              <select
                id="rb-contract"
                className="h-9 w-full rounded-md border border-input bg-background px-3 text-sm"
                value={contractId}
                onChange={(e) => setContractId(e.target.value)}
              >
                {contracts.map((c) => (
                  <option key={c.contractId} value={c.contractId}>
                    {c.contractNo} — {c.title} ({c.entries} checked{" "}
                    {c.entries === 1 ? "measurement" : "measurements"})
                  </option>
                ))}
              </select>
              {/*
                Said plainly, on the form: the user is not choosing what to
                bill. They are choosing which contract's already-checked
                work to sweep up.
              */}
              <p className="text-xs text-muted-foreground">
                Every line is taken from measurements that have been checked by somebody
                other than the person who took them. Quantities come from the measurement
                book; rates come from the BOQ. Neither can be typed here.
              </p>
            </div>

            <div className="space-y-1">
              <Label htmlFor="rb-no">Bill number</Label>
              <Input
                id="rb-no"
                value={billNo}
                onChange={(e) => setBillNo(e.target.value)}
                placeholder="RA-03"
              />
            </div>

            <div className="space-y-1">
              <Label htmlFor="rb-month">Compliance month</Label>
              <Input
                id="rb-month"
                value={complianceMonth}
                onChange={(e) => setComplianceMonth(e.target.value)}
                placeholder="2026-05"
              />
              {/*
                ⚠️ NOT COSMETIC. This is the month whose EPF and ESI
                challans the payment gate will look for. Leave it blank and
                the bill can be raised, certified and approved — and then
                cannot be paid, which is discovered at the worst moment.
              */}
              <p className="text-xs text-muted-foreground">
                Which month&apos;s EPF/ESI evidence must be on file before this can be paid.
              </p>
            </div>

            <div className="space-y-1">
              <Label htmlFor="rb-from">Period from</Label>
              <Input id="rb-from" type="date" value={periodFrom} onChange={(e) => setPeriodFrom(e.target.value)} />
            </div>

            <div className="space-y-1">
              <Label htmlFor="rb-to">Period to</Label>
              <Input id="rb-to" type="date" value={periodTo} onChange={(e) => setPeriodTo(e.target.value)} />
            </div>

            <div className="sm:col-span-2">
              <Button size="sm" disabled={pending} onClick={submit}>
                {pending ? "Raising…" : "Raise the bill"}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* CERTIFY / APPROVE                                                   */
/* ------------------------------------------------------------------ */

export function BillTransitionControls({
  raBillId,
  status,
  viewerRaisedIt,
  viewerCertifiedIt,
}: {
  raBillId: string;
  status: string;
  viewerRaisedIt: boolean;
  viewerCertifiedIt: boolean;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function run(fn: () => Promise<{ ok: boolean; error?: string }>) {
    setError(null);
    startTransition(async () => {
      const result = await fn();
      if (!result.ok) {
        setError(result.error ?? "That could not be saved.");
        return;
      }
      router.refresh();
    });
  }

  const canCertifyStage = status === "draft" || status === "submitted";

  return (
    <div className="space-y-2">
      {error && (
        <p role="alert" className="rounded-md border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          {error}
        </p>
      )}

      {canCertifyStage &&
        (viewerRaisedIt ? (
          /*
            ⚠️ THE REASON, NOT A DISABLED BUTTON. Somebody who raised a
            bill and finds a greyed-out "Certify" learns only that the
            software will not let them — so they ask a colleague to click
            it, which is the separation defeated while looking observed.
          */
          <p className="rounded-md border border-border bg-muted/30 p-3 text-sm text-muted-foreground">
            You raised this bill, so somebody else has to certify it. Certification is a
            second person confirming the work is worth the money — done by whoever assembled
            the claim, it records a review that never happened.
          </p>
        ) : (
          <Button size="sm" disabled={pending} onClick={() => run(() => certifyRaBill({ raBillId }))}>
            {pending ? "Certifying…" : "Certify for payment"}
          </Button>
        ))}

      {status === "certified" &&
        (viewerCertifiedIt ? (
          <p className="rounded-md border border-border bg-muted/30 p-3 text-sm text-muted-foreground">
            You certified this bill, so somebody else has to approve it. Certifying says the
            work is worth the money; approving releases it. They are meant to be two people.
          </p>
        ) : (
          <Button size="sm" disabled={pending} onClick={() => run(() => approveRaBill({ raBillId }))}>
            {pending ? "Approving…" : "Approve for payment"}
          </Button>
        ))}

      {status === "approved" && (
        <p className="rounded-md border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
          Approved, and <strong>not yet payable</strong>. The database will refuse to mark
          this paid until the EPF and ESI challans for the compliance month are on file and
          verified, and the engineer&apos;s certificate is recorded. Paying a contractor who
          has not remitted their workers&apos; provident fund makes the developer liable for
          the shortfall.
        </p>
      )}
    </div>
  );
}
