"use client";

/**
 * Ordence — ⭐⭐⭐ THE INPUT CREDIT ON BANK CHARGES
 * Version: v1.67.0-alpha (Batch 0110)
 *
 * ══════════════════════════════════════════════════════════════════════
 * 🔴 WHAT THIS SCREEN IS FOR
 * ══════════════════════════════════════════════════════════════════════
 * 0102 posts a bank charge GROSS and its role help said to claim the
 * input credit from the bank's own tax invoice by hand. Nothing recorded
 * that it was owed, nothing totalled it, and nothing ever asked. This is
 * the screen that asks.
 *
 * ⚠️ THERE IS NO "SPLIT 18%" BUTTON AND THERE WILL NOT BE ONE. The
 * argument is in `lib/banking/bank-charge-itc.ts`; the short form is
 * that s.16(2)(a) CGST Act gives no credit without the tax invoice in
 * hand, s.16(2)(aa) with Rule 36(4) wants it in GSTR-2B, and a figure
 * derived from a statement line has no invoice number to match on. A
 * derived split is right until an audit.
 *
 * ⭐ SO THE FORM ASKS FOR WHAT IS PRINTED ON THE INVOICE, AND REFUSES
 * ANYTHING THAT DOES NOT FOOT TO THE MONEY THAT LEFT THE ACCOUNT.
 */

import { useState, useTransition } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { toast } from "sonner";

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

export interface PeriodTotals {
  taxPeriod: string;
  chargeCount: number;
  grossMinor: string;
  awaitingInvoiceGrossMinor: string;
  awaitingInvoiceCount: number;
  identifiedCreditMinor: string;
  identifiedCount: number;
  notClaimableGrossMinor: string;
  notClaimableCount: number;
  postedCreditMinor: string;
  postedCount: number;
  unpostedCreditMinor: string;
  unpostedCount: number;
  note: string | null;
}

export interface ChargeRow {
  id: string;
  valueDate: string;
  taxPeriod: string;
  grossMinor: string;
  status: string;
  statusLabel: string;
  statusHelp: string;
  creditMinor: string;
  invoiceNo: string | null;
  creditPostedAt: string | null;
  creditTransactionId: string | null;
  postingLabel: string;
  /** ⚠️ NULL means the button is enabled. A sentence means it is not. */
  postingRefusal: string | null;
}

function rupees(minor: string): string {
  const n = BigInt(minor);
  const negative = n < 0n;
  const abs = negative ? -n : n;
  const whole = (abs / 100n).toString();
  const paise = (abs % 100n).toString().padStart(2, "0");
  return `${negative ? "−" : ""}₹${whole}.${paise}`;
}

const BLANK = {
  invoiceNo: "",
  invoiceDate: "",
  supplierGstin: "",
  taxableValueMinor: "",
  cgstMinor: "0",
  sgstMinor: "0",
  igstMinor: "0",
  cessMinor: "0",
};

export function InputCreditRegister({
  periods,
  charges,
  recordInvoiceAction,
  markNotClaimableAction,
  postCreditAction,
}: {
  periods: readonly PeriodTotals[];
  charges: readonly ChargeRow[];
  recordInvoiceAction: (
    i: unknown,
  ) => Promise<Result<{ creditMinor: string; note: string }>>;
  markNotClaimableAction: (i: unknown) => Promise<Result<{ note: string }>>;
  /**
   * ⭐⭐⭐ 0112. THE ACTION THAT DID NOT EXIST WHEN THIS SCREEN SHIPPED.
   * Batch 0110 built everything up to here and said so in the copy below:
   * the journal "is a separate posting and has not been made by this
   * screen". There was no screen that made it, so `invoice_recorded` was
   * a worklist state and the credit stayed inside Bank Charges.
   */
  postCreditAction: (
    i: unknown,
  ) => Promise<Result<{ note: string; transactionId: string }>>;
}) {
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState<string | null>(null);
  const [form, setForm] = useState({ ...BLANK });
  const [reasonFor, setReasonFor] = useState<string | null>(null);
  const [reason, setReason] = useState("");

  function submitInvoice(deferralId: string) {
    startTransition(async () => {
      const res = await recordInvoiceAction({ deferralId, ...form });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(res.data.note);
      setOpen(null);
      setForm({ ...BLANK });
    });
  }

  function submitPosting(deferralId: string) {
    startTransition(async () => {
      const res = await postCreditAction({ deferralId });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(res.data.note);
    });
  }

  function submitNotClaimable(deferralId: string) {
    startTransition(async () => {
      const res = await markNotClaimableAction({ deferralId, reason });
      if (!res.ok) {
        toast.error(res.error);
        return;
      }
      toast.success(res.data.note);
      setReasonFor(null);
      setReason("");
    });
  }

  return (
    <div className="space-y-6">
      {periods.length === 0 && (
        <Card>
          <CardContent className="pt-6 text-sm text-muted-foreground">
            No bank charges have been written up from a statement yet. Charges
            posted from the reconciliation screen appear here with the input
            credit on them recorded as unclaimed until the bank&apos;s tax
            invoice is entered.
          </CardContent>
        </Card>
      )}

      {/**
       * ⭐⭐⭐ THREE TOTALS, NEVER NETTED INTO ONE.
       *
       * 🔴 A single "unclaimed credit" figure would combine an amount
       * that is KNOWN with one that is not knowable until an invoice
       * arrives, and the combined number would be wrong in a direction
       * nobody could work out. The three answer three different
       * questions and carry three different instructions.
       */}
      {periods.map((p) => (
        <Card key={p.taxPeriod}>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">
              {p.taxPeriod} · {p.chargeCount} bank charge
              {p.chargeCount === 1 ? "" : "s"} · {rupees(p.grossMinor)} gross
            </CardTitle>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <div className="grid gap-3 sm:grid-cols-4">
              <div>
                <p className="text-xs uppercase text-muted-foreground">
                  No invoice yet
                </p>
                <p className="text-lg font-semibold tabular-nums">
                  {rupees(p.awaitingInvoiceGrossMinor)}
                </p>
                <p className="text-xs text-muted-foreground">
                  {p.awaitingInvoiceCount} charge
                  {p.awaitingInvoiceCount === 1 ? "" : "s"}, gross. ⚠️ The credit
                  on this is not shown as a figure because it is not knowable
                  from the statement — the line carries no rate.
                </p>
              </div>
              <div>
                <p className="text-xs uppercase text-muted-foreground">
                  Credit identified
                </p>
                <p className="text-lg font-semibold tabular-nums">
                  {rupees(p.identifiedCreditMinor)}
                </p>
                <p className="text-xs text-muted-foreground">
                  From {p.identifiedCount} invoice
                  {p.identifiedCount === 1 ? "" : "s"} recorded. This is a real
                  amount against a real invoice number.
                </p>
              </div>
              {/**
               * ⭐⭐⭐ 0112. THE FOURTH FIGURE, AND IT IS A SPLIT OF THE
               * THIRD RATHER THAN A NEW BUCKET.
               *
               * 🔴 BEFORE THIS, "identified" AND "in the books" WERE THE
               * SAME NUMBER ON THIS SCREEN and one of them was a job
               * nobody knew was outstanding. An accountant reading
               * "credit identified ₹1,800" reasonably assumed the ledger
               * had it. It did not, and there was no screen that could
               * put it there.
               *
               * ⚠️ `posted + not yet posted = identified`, always. The
               * arithmetic is done once in `totalByPeriod` and asserted
               * by a test, not repeated here.
               */}
              <div>
                <p className="text-xs uppercase text-muted-foreground">
                  Still in Bank Charges
                </p>
                <p className="text-lg font-semibold tabular-nums">
                  {rupees(p.unpostedCreditMinor)}
                </p>
                <p className="text-xs text-muted-foreground">
                  {p.unpostedCount === 0
                    ? `All ${p.postedCount} identified credit${p.postedCount === 1 ? " is" : "s are"} in the ledger.`
                    : `${p.unpostedCount} credit${p.unpostedCount === 1 ? " is" : "s are"} identified and not yet posted, so the trial balance still carries ${rupees(p.unpostedCreditMinor)} of recoverable tax as an expense. ${rupees(p.postedCreditMinor)} has been posted.`}
                </p>
              </div>
              <div>
                <p className="text-xs uppercase text-muted-foreground">
                  Not claimable
                </p>
                <p className="text-lg font-semibold tabular-nums">
                  {rupees(p.notClaimableGrossMinor)}
                </p>
                <p className="text-xs text-muted-foreground">
                  {p.notClaimableCount} charge
                  {p.notClaimableCount === 1 ? "" : "s"} written off
                  deliberately, each with a reason on it.
                </p>
              </div>
            </div>
            {p.note && <p className="text-muted-foreground">{p.note}</p>}
          </CardContent>
        </Card>
      ))}

      {charges.map((c) => (
        <Card key={c.id}>
          <CardHeader className="pb-2">
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle className="text-base tabular-nums">
                {rupees(c.grossMinor)}
              </CardTitle>
              <Badge variant="secondary">{c.valueDate}</Badge>
              {/**
               * ⚠️ `postingLabel` AND NOT `statusLabel`. The three
               * statuses cannot tell "recorded" from "recorded and in the
               * books", which is the distinction this screen now turns
               * on. It is computed server-side by the same pure function
               * the refusal uses, so the badge and the button cannot
               * disagree about what state a row is in.
               */}
              <Badge
                variant={
                  c.status === "awaiting_invoice"
                    ? "destructive"
                    : c.status === "invoice_recorded" && c.creditPostedAt === null
                      ? "outline"
                      : "default"
                }
              >
                {c.postingLabel}
              </Badge>
              {c.invoiceNo && <Badge variant="secondary">{c.invoiceNo}</Badge>}
            </div>
          </CardHeader>
          <CardContent className="space-y-3 text-sm">
            <p className="text-muted-foreground">{c.statusHelp}</p>

            {c.status === "invoice_recorded" && (
              <p className="font-medium tabular-nums">
                Credit identified: {rupees(c.creditMinor)}
              </p>
            )}

            {/**
             * ⭐⭐⭐ 0112. THE BUTTON, AND THE SENTENCE THAT REPLACED AN
             * APOLOGY.
             *
             * 🔴 THE REFUSAL IS RENDERED BEFORE THE BUTTON IS PRESSED,
             * from the same `postingRefusal()` the server action calls.
             * A disabled button with no reason is how an operator learns
             * to stop reading a screen.
             *
             * ⚠️ AND POSTING IS A SEPARATE ACT FROM TRANSCRIBING, on
             * purpose. 0110's footing CHECK catches a split that does not
             * add up; it cannot catch a correct split entered against the
             * wrong charge. This is the one look somebody gets at a
             * figure before it is in the books — after which
             * `ordence_guard_posted_itc_deferral` refuses to let it move.
             */}
            {c.status === "invoice_recorded" && c.creditPostedAt === null && (
              <div className="space-y-2 rounded-md border border-dashed p-3">
                <p className="text-muted-foreground">
                  This credit is identified and is not in the ledger. Until it
                  is posted, the {rupees(c.creditMinor)} of recoverable tax sits
                  inside Bank Charges and the trial balance overstates the
                  expense by exactly that much.
                </p>
                {c.postingRefusal !== null ? (
                  <p className="text-destructive">{c.postingRefusal}</p>
                ) : (
                  <Button
                    className="h-7 px-2 text-xs"
                    disabled={pending}
                    onClick={() => submitPosting(c.id)}
                  >
                    Post {rupees(c.creditMinor)} to input credit
                  </Button>
                )}
              </div>
            )}

            {c.creditPostedAt !== null && (
              <p className="text-muted-foreground">
                Posted to the ledger on{" "}
                {c.creditPostedAt.slice(0, 10)}, dated on the bank&apos;s
                invoice. ⚠️ The figures on this charge can no longer be edited:
                a journal was built from them, and changing them now would leave
                the register and the trial balance disagreeing with nothing to
                say which is right.
              </p>
            )}

            {c.status === "awaiting_invoice" && open !== c.id && reasonFor !== c.id && (
              <div className="flex flex-wrap gap-2">
                <Button
                  variant="secondary"
                  className="h-7 px-2 text-xs"
                  disabled={pending}
                  onClick={() => setOpen(c.id)}
                >
                  Record the bank&apos;s tax invoice
                </Button>
                <Button
                  variant="ghost"
                  className="h-7 px-2 text-xs"
                  disabled={pending}
                  onClick={() => setReasonFor(c.id)}
                >
                  Not claimable
                </Button>
              </div>
            )}

            {open === c.id && (
              <div className="space-y-3 rounded-md border p-3">
                <p className="text-xs text-muted-foreground">
                  ⚠️ Every figure below is copied from the bank&apos;s invoice,
                  in paise. Nothing here is calculated for you on purpose: a
                  rate assumed from the amount produces a claim with no invoice
                  behind it, which s.16(2)(a) does not permit and GSTR-2B cannot
                  match. The taxable value plus every tax head has to come to{" "}
                  <span className="font-medium tabular-nums">
                    {c.grossMinor} paise
                  </span>
                  , which is what the bank actually took.
                </p>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Field
                    id={`inv-${c.id}`}
                    label="Invoice number"
                    value={form.invoiceNo}
                    onChange={(v) => setForm((f) => ({ ...f, invoiceNo: v }))}
                  />
                  <Field
                    id={`invd-${c.id}`}
                    label="Invoice date (YYYY-MM-DD)"
                    value={form.invoiceDate}
                    onChange={(v) => setForm((f) => ({ ...f, invoiceDate: v }))}
                  />
                  <Field
                    id={`gstin-${c.id}`}
                    label="The bank's GSTIN"
                    value={form.supplierGstin}
                    onChange={(v) => setForm((f) => ({ ...f, supplierGstin: v }))}
                  />
                  <Field
                    id={`tv-${c.id}`}
                    label="Taxable value (paise)"
                    value={form.taxableValueMinor}
                    onChange={(v) =>
                      setForm((f) => ({ ...f, taxableValueMinor: v }))
                    }
                  />
                  <Field
                    id={`cgst-${c.id}`}
                    label="CGST (paise)"
                    value={form.cgstMinor}
                    onChange={(v) => setForm((f) => ({ ...f, cgstMinor: v }))}
                  />
                  <Field
                    id={`sgst-${c.id}`}
                    label="SGST / UTGST (paise)"
                    value={form.sgstMinor}
                    onChange={(v) => setForm((f) => ({ ...f, sgstMinor: v }))}
                  />
                  <Field
                    id={`igst-${c.id}`}
                    label="IGST (paise)"
                    value={form.igstMinor}
                    onChange={(v) => setForm((f) => ({ ...f, igstMinor: v }))}
                  />
                  <Field
                    id={`cess-${c.id}`}
                    label="Cess (paise)"
                    value={form.cessMinor}
                    onChange={(v) => setForm((f) => ({ ...f, cessMinor: v }))}
                  />
                </div>
                <div className="flex gap-2">
                  <Button
                    className="h-7 px-2 text-xs"
                    disabled={pending}
                    onClick={() => submitInvoice(c.id)}
                  >
                    Record it
                  </Button>
                  <Button
                    variant="ghost"
                    className="h-7 px-2 text-xs"
                    disabled={pending}
                    onClick={() => setOpen(null)}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            )}

            {reasonFor === c.id && (
              <div className="space-y-2 rounded-md border p-3">
                <Label htmlFor={`why-${c.id}`} className="text-xs">
                  Why will this credit not be taken?
                </Label>
                <Input
                  id={`why-${c.id}`}
                  value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="e.g. exempt under Notification 12/2017-CT(R) entry 27"
                />
                <p className="text-xs text-muted-foreground">
                  ⚠️ An exempt supply and a credit blocked under s.17(5) are
                  different facts, and both differ from an oversight. The row
                  stays on this register with the reason on it.
                </p>
                <div className="flex gap-2">
                  <Button
                    className="h-7 px-2 text-xs"
                    disabled={pending}
                    onClick={() => submitNotClaimable(c.id)}
                  >
                    Record the decision
                  </Button>
                  <Button
                    variant="ghost"
                    className="h-7 px-2 text-xs"
                    disabled={pending}
                    onClick={() => setReasonFor(null)}
                  >
                    Cancel
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function Field({
  id,
  label,
  value,
  onChange,
}: {
  id: string;
  label: string;
  value: string;
  onChange: (v: string) => void;
}) {
  return (
    <div className="space-y-1">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      <Input id={id} value={value} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}
