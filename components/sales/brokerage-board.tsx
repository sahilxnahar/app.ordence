"use client";

/**
 * Ordence — ⭐⭐⭐ BROKERAGE
 * Version: v1.25.0-alpha · Batch 17
 *
 * ══════════════════════════════════════════════════════════════════════
 * ⭐ THE DEDUCTION IS EXPLAINED BEFORE IT IS MADE, NOT AFTER
 * ══════════════════════════════════════════════════════════════════════
 * A broker sees a smaller number than the one that was agreed, every
 * single time, and asks why. If the answer only exists in a TDS register
 * the developer has to go and find, the conversation happens on the
 * phone with nobody holding the facts.
 *
 * So the preview says what will be withheld, at what rate, on what base,
 * and why the base is bigger than this bill — because when the annual
 * threshold is crossed the tax is due on the WHOLE year, which is the
 * single most surprising thing about section 194H and the thing that
 * makes one bill's deduction look wrong.
 */

import { useState, useTransition } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export type BrokerageBillView = {
  id: string;
  reference: string;
  status: string;
  partnerFirmName: string;
  partnerHasPan: boolean;
  bookingReference: string | null;
  creditedOn: string;
  workings: string;
  grossMinor: string;
  cgstMinor: string;
  sgstMinor: string;
  igstMinor: string;
  itcEligible: boolean;
  tdsMinor: string;
  tdsRateBps: number;
  tdsExplanation: string | null;
  netPayableMinor: string;
};

export type PartnerOption = { id: string; firmName: string; kycStatus: string };

type Preview = {
  grossMinor: string;
  workings: string;
  problem: string | null;
  tdsMinor: string;
  tdsRateBps: number;
  tdsApplicable: boolean;
  tdsExplanation: string;
  tdsCaution: string | null;
  chargeableBaseMinor: string;
  ytdGrossMinor: string;
  financialYear: string;
  netBeforeGstMinor: string;
  hasPan: boolean;
};

type Result = { ok: true; data: unknown } | { ok: false; error: string };

function rupees(minor: string | bigint): string {
  const value = typeof minor === "bigint" ? minor : BigInt(minor || "0");
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = (abs / 100n).toString();
  const paise = (abs % 100n).toString().padStart(2, "0");
  return `${negative ? "-" : ""}₹${groupIndian(whole)}.${paise}`;
}

function groupIndian(digits: string): string {
  if (digits.length <= 3) return digits;
  const last3 = digits.slice(-3);
  const rest = digits.slice(0, -3);
  return `${rest.replace(/\B(?=(\d{2})+(?!\d))/g, ",")},${last3}`;
}

function statusBadge(status: string) {
  switch (status) {
    case "paid":
      return <Badge variant="secondary">paid</Badge>;
    case "posted":
      return <Badge>posted</Badge>;
    case "approved":
      return <Badge variant="outline">approved</Badge>;
    case "cancelled":
      return <Badge variant="destructive">cancelled</Badge>;
    default:
      return <Badge variant="outline">draft</Badge>;
  }
}

export function BrokerageBoard({
  rows,
  partners,
  outstandingMinor,
  missingAccounts,
  missingItcAccounts,
  canManage,
  canPost,
  onPreview,
  onRaise,
  onApprove,
  onPost,
  onPay,
  onCancel,
}: {
  rows: BrokerageBillView[];
  partners: PartnerOption[];
  outstandingMinor: string;
  missingAccounts: { role: string; label: string; help: string }[];
  missingItcAccounts: { role: string; label: string; help: string }[];
  canManage: boolean;
  canPost: boolean;
  onPreview: (input: {
    partnerId: string;
    bookingId?: string | null;
    creditedOn: string;
    overrideGross?: string | null;
  }) => Promise<{ ok: true; data: Preview } | { ok: false; error: string }>;
  onRaise: (input: unknown) => Promise<Result>;
  onApprove: (input: unknown) => Promise<Result>;
  onPost: (input: unknown) => Promise<Result>;
  onPay: (input: unknown) => Promise<Result>;
  onCancel: (input: unknown) => Promise<Result>;
}) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);

  const [partnerId, setPartnerId] = useState(partners[0]?.id ?? "");
  const [creditedOn, setCreditedOn] = useState("");
  const [overrideGross, setOverrideGross] = useState("");
  const [invoiceNumber, setInvoiceNumber] = useState("");
  const [cgst, setCgst] = useState("");
  const [sgst, setSgst] = useState("");
  const [igst, setIgst] = useState("");
  const [itcEligible, setItcEligible] = useState(false);

  function run(fn: () => Promise<Result>, ok: string) {
    setMessage(null);
    setError(null);
    startTransition(async () => {
      const result = await fn();
      if (result.ok) setMessage(ok);
      else setError(result.error);
    });
  }

  return (
    <div className="space-y-4">
      {/* ───────────────────────────────────────────────────────────
          ⚠️ THE MISSING ACCOUNTS ARE SHOWN FIRST AND AT THE TOP.
          Finding out that `brokerage_expense` is unmapped after
          filling in a bill and pressing post is a wasted five
          minutes and a message that reads like a bug.
         ─────────────────────────────────────────────────────────── */}
      {missingAccounts.length > 0 ? (
        <Card className="border-destructive">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">
              {missingAccounts.length} ledger account
              {missingAccounts.length === 1 ? "" : "s"} to map before anything can post
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-2 text-xs">
            {missingAccounts.map((a) => (
              <div key={a.role}>
                <span className="font-medium">{a.label}</span>
                <p className="text-muted-foreground">{a.help}</p>
              </div>
            ))}
            <p className="text-muted-foreground">
              Bills can still be raised and approved. Only posting needs these.
            </p>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardContent className="pt-4">
          <p className="text-sm font-medium">Owed to channel partners</p>
          <p className="mt-1 text-2xl font-semibold">{rupees(outstandingMinor)}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Posted bills not yet paid. Approved bills are a decision, not yet a liability, so
            they are not counted here — this figure agrees with the Channel Partners Payable
            account.
          </p>
        </CardContent>
      </Card>

      {canManage ? (
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm">Raise brokerage</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="brk-partner">Partner</Label>
                <select
                  id="brk-partner"
                  className="h-9 w-full rounded-md border bg-background px-2 text-sm"
                  value={partnerId}
                  onChange={(e) => setPartnerId(e.target.value)}
                >
                  {partners.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.firmName}
                      {p.kycStatus === "verified" ? "" : ` (KYC ${p.kycStatus})`}
                    </option>
                  ))}
                </select>
              </div>
              <div className="space-y-1">
                <Label htmlFor="brk-date">Credited on</Label>
                <Input
                  id="brk-date"
                  type="date"
                  value={creditedOn}
                  onChange={(e) => setCreditedOn(e.target.value)}
                />
                {/*
                  ⚠️ SAID OUT LOUD, BECAUSE IT IS NOT OBVIOUS. The rate
                  and the annual threshold are both resolved against
                  this date and never against today.
                */}
                <p className="text-xs text-muted-foreground">
                  The TDS rate and the annual threshold are read from this date, not from today.
                </p>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="space-y-1">
                <Label htmlFor="brk-gross">Brokerage (leave blank to use the agreed basis)</Label>
                <Input
                  id="brk-gross"
                  inputMode="decimal"
                  placeholder="e.g. 150000.00"
                  value={overrideGross}
                  onChange={(e) => setOverrideGross(e.target.value)}
                />
              </div>
              <div className="space-y-1">
                <Label htmlFor="brk-inv">Partner&apos;s invoice number</Label>
                <Input
                  id="brk-inv"
                  value={invoiceNumber}
                  onChange={(e) => setInvoiceNumber(e.target.value)}
                />
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-3">
              <div className="space-y-1">
                <Label htmlFor="brk-cgst">CGST</Label>
                <Input id="brk-cgst" value={cgst} onChange={(e) => setCgst(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="brk-sgst">SGST</Label>
                <Input id="brk-sgst" value={sgst} onChange={(e) => setSgst(e.target.value)} />
              </div>
              <div className="space-y-1">
                <Label htmlFor="brk-igst">IGST</Label>
                <Input id="brk-igst" value={igst} onChange={(e) => setIgst(e.target.value)} />
              </div>
            </div>

            {/* ───────────────────────────────────────────────────────
                🔴 THE MOST CONSEQUENTIAL CHECKBOX ON THIS SCREEN, so
                it carries the reason rather than the label alone.
               ─────────────────────────────────────────────────────── */}
            <label className="flex items-start gap-2 text-sm">
              <input
                type="checkbox"
                className="mt-1"
                checked={itcEligible}
                onChange={(e) => setItcEligible(e.target.checked)}
              />
              <span>
                Claim input credit on the partner&apos;s GST
                <span className="block text-xs text-muted-foreground">
                  Leave this OFF for a residential project taxed at 1% or 5%. Those projects get
                  no input credit at all, so the tax is part of what the brokerage cost — and
                  claiming it is a demand with interest and penalty. Turn it on for a commercial
                  project at 12% where credit is genuinely available.
                  {missingItcAccounts.length > 0 && itcEligible
                    ? ` ⚠️ ${missingItcAccounts.map((a) => a.label).join(", ")} not mapped yet.`
                    : ""}
                </span>
              </span>
            </label>

            <div className="flex flex-wrap gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={pending || !partnerId || !creditedOn}
                onClick={() => {
                  setError(null);
                  setMessage(null);
                  startTransition(async () => {
                    const result = await onPreview({
                      partnerId,
                      creditedOn,
                      overrideGross: overrideGross || null,
                    });
                    if (result.ok) setPreview(result.data);
                    else {
                      setPreview(null);
                      setError(result.error);
                    }
                  });
                }}
              >
                What would be withheld?
              </Button>
              <Button
                type="button"
                disabled={pending || !partnerId || !creditedOn}
                onClick={() =>
                  run(
                    () =>
                      onRaise({
                        partnerId,
                        creditedOn,
                        overrideGross: overrideGross || null,
                        partnerInvoiceNumber: invoiceNumber || null,
                        cgst: cgst || null,
                        sgst: sgst || null,
                        igst: igst || null,
                        itcEligible,
                      }),
                    "Raised as a draft.",
                  )
                }
              >
                Raise
              </Button>
            </div>

            {preview ? (
              <div className="space-y-1 rounded-md border p-3 text-sm" data-testid="brk-preview">
                <p>
                  Brokerage <strong>{rupees(preview.grossMinor)}</strong> — {preview.workings}
                </p>
                <p>
                  TDS <strong>{rupees(preview.tdsMinor)}</strong> at{" "}
                  {(preview.tdsRateBps / 100).toFixed(2)}% · net{" "}
                  <strong>{rupees(preview.netBeforeGstMinor)}</strong> before GST
                </p>
                <p className="text-xs text-muted-foreground">{preview.tdsExplanation}</p>
                {/*
                  ⭐ THE YEAR-TO-DATE LINE IS WHY THE DEDUCTION LOOKS
                  WRONG, AND IT IS THE WHOLE ANSWER. Once the year
                  crosses ₹20,000 the tax is on everything credited in
                  it, so one bill can carry a deduction larger than its
                  own rate would suggest.
                */}
                {preview.tdsApplicable ? (
                  <p className="text-xs text-muted-foreground">
                    Chargeable base for {preview.financialYear}:{" "}
                    {rupees(preview.chargeableBaseMinor)} — of which{" "}
                    {rupees(preview.ytdGrossMinor)} was credited earlier this year.
                  </p>
                ) : null}
                {preview.tdsCaution ? (
                  <p className="text-xs text-destructive">{preview.tdsCaution}</p>
                ) : null}
                {!preview.hasPan ? (
                  <p className="text-xs text-destructive">
                    No PAN on file, so section 206AA forces 20% instead of 2%. Adding the
                    partner&apos;s PAN is worth ₹18 on every ₹100 of brokerage.
                  </p>
                ) : null}
                {preview.problem ? (
                  <p className="text-xs text-destructive">{preview.problem}</p>
                ) : null}
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {message ? <p className="text-sm">{message}</p> : null}
      {error ? <p className="text-sm text-destructive">{error}</p> : null}

      <div className="space-y-2">
        {rows.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No brokerage has been raised yet. Ordence has been able to calculate it since Phase
            22 and has never been able to record it — this screen is what closes that.
          </p>
        ) : null}

        {rows.map((row) => (
          <Card key={row.id} data-testid={`brk-${row.reference}`}>
            <CardContent className="space-y-2 py-3">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-medium">{row.reference}</span>
                {statusBadge(row.status)}
                <span className="text-xs text-muted-foreground">
                  {row.partnerFirmName}
                  {row.bookingReference ? ` · ${row.bookingReference}` : ""} · credited{" "}
                  {row.creditedOn}
                </span>
                <span className="ml-auto font-semibold">{rupees(row.netPayableMinor)}</span>
              </div>

              <p className="text-xs text-muted-foreground">
                {rupees(row.grossMinor)} brokerage · {row.workings} · TDS{" "}
                {rupees(row.tdsMinor)} at {(row.tdsRateBps / 100).toFixed(2)}%
                {row.itcEligible ? " · input credit claimed" : " · GST treated as cost"}
              </p>
              {row.tdsExplanation ? (
                <p className="text-xs text-muted-foreground">{row.tdsExplanation}</p>
              ) : null}

              <div className="flex flex-wrap gap-2">
                {canManage && row.status === "draft" ? (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={pending}
                    onClick={() => run(() => onApprove({ id: row.id }), "Approved.")}
                  >
                    Approve
                  </Button>
                ) : null}
                {canPost && row.status === "approved" ? (
                  <Button
                    size="sm"
                    disabled={pending}
                    onClick={() => run(() => onPost({ id: row.id }), "Posted to the ledger.")}
                  >
                    Post
                  </Button>
                ) : null}
                {canPost && row.status === "posted" ? (
                  <Button
                    size="sm"
                    disabled={pending}
                    onClick={() => {
                      const reference = window.prompt("Payment reference (UTR or cheque number)");
                      if (!reference) return;
                      const paidOn = window.prompt("Paid on (YYYY-MM-DD)");
                      if (!paidOn) return;
                      run(
                        () => onPay({ id: row.id, paidOn, paymentReference: reference }),
                        "Payment posted.",
                      );
                    }}
                  >
                    Record payment
                  </Button>
                ) : null}
                {canManage && row.status !== "paid" && row.status !== "cancelled" ? (
                  <Button
                    size="sm"
                    variant="ghost"
                    disabled={pending}
                    onClick={() => {
                      const reason = window.prompt("Why is this being cancelled?");
                      if (!reason) return;
                      run(() => onCancel({ id: row.id, reason }), "Cancelled.");
                    }}
                  >
                    Cancel
                  </Button>
                ) : null}
              </div>
            </CardContent>
          </Card>
        ))}
      </div>

      <p className="text-xs text-muted-foreground">
        ⚠️ Brokerage is expensed when it is credited. Ind AS 115 permits carrying it as a
        contract cost and releasing it at possession, which for a three-year project is
        materially different — that is deliberately not built, because doing it half way
        capitalises costs that are never released. And the TDS withheld here is discharged by a
        challan to the Government, never by the transfer to the broker.
      </p>
    </div>
  );
}
